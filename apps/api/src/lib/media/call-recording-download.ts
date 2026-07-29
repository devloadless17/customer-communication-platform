import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { publish } from "@/lib/events/bus";
import { getProviderBinding } from "@/lib/providers";
import {
  extractCallChannels,
  transcodeCallRecordingToOgg,
  type CallChannelAudio,
} from "@/lib/media/audio-transcode";
import { transcribeCallChannel, transcribeInboundAudio } from "@/lib/ai/voice";
import { configEnabled, loadAiConfig } from "@/lib/ai/runtime-config";

/**
 * Announce a call's artifact state to the team, AFTER the key column is
 * committed — the frame is what makes a just-finished call grow its play /
 * transcript buttons without a page reload (§10: emit only after a successful
 * state change).
 *
 * Re-reads the row rather than taking the caller's word for it, so the frame
 * reports both artifacts truthfully whichever one just landed, and a losing
 * CAS never publishes a half-state. Every caller gates on having actually
 * written, so this runs at most twice per recorded call.
 *
 * Best-effort by construction: a failed publish costs the live update, never
 * the artifact — the next thread hydrate still shows it.
 */
async function publishCallArtifacts(
  callId: string,
  opts: { transcriptPending?: boolean } = {},
): Promise<void> {
  try {
    const row = await db.call.findUnique({
      where: { id: callId },
      select: {
        id: true,
        workspaceId: true,
        conversationId: true,
        recordingKey: true,
        transcriptKey: true,
        transcriptLanguage: true,
        transcriptMediaId: true,
      },
    });
    if (!row) return;
    const hasTranscript = row.transcriptKey !== null;
    await publish({
      type: "call.artifacts_changed",
      workspaceId: row.workspaceId,
      conversationId: row.conversationId,
      callId: row.id,
      hasRecording: row.recordingKey !== null,
      hasTranscript,
      transcriptLanguage: row.transcriptLanguage,
      // Explicit caller intent wins (the in-app path knows whether Whisper is
      // about to run — nothing on the row says so). Otherwise: the provider
      // announced a transcript media id we haven't fetched yet.
      transcriptPending:
        !hasTranscript && (opts.transcriptPending ?? row.transcriptMediaId !== null),
    });
  } catch (err) {
    console.warn(
      `[call-artifacts] publish failed for call=${callId}: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

/**
 * Download an opted-in call recording from the provider and persist it to R2.
 *
 * The provider's `call_recording_available` webhook hands us a media id whose
 * underlying file is DELETED 7 days later, so the bytes must land in our own
 * storage promptly. Called twice over a row's life: inline (detached) from the
 * webhook side-path, and by the call-recordings sweeper for rows whose inline
 * attempt hit a transient failure (Meta CDN / R2 blip).
 *
 * Idempotent: the final write CAS-es on `recordingKey` still being null, and a
 * re-upload to the same fixed key is harmless — so webhook redelivery, an
 * inline attempt racing the sweeper, or a process restart mid-download all
 * converge on one stored object.
 *
 * Returns true when the recording is persisted (now or previously); false on
 * a failure worth retrying.
 */

// Heap guard, not a target: fetchMedia buffers the file, and an hour of
// VoIP-bitrate OPUS is ~11 MB — 64 MB accommodates any realistic call while
// keeping a burst of concurrent downloads inside the api heap budget.
const RECORDING_MAX_BYTES = 64 * 1024 * 1024;

export async function downloadCallRecording(
  callId: string,
  /** Provider's base64 SHA-256 from the webhook, when the caller has it.
   *  Sweeper retries pass nothing — the authenticated re-fetch is trusted. */
  expectedSha256?: string | null,
): Promise<boolean> {
  const call = await db.call.findUnique({
    where: { id: callId },
    select: {
      id: true,
      workspaceId: true,
      channel: true,
      recordingMediaId: true,
      recordingKey: true,
      recordingMimeType: true,
      conversation: { select: { channelConnectionId: true } },
    },
  });
  if (!call?.recordingMediaId) return true; // nothing to download
  if (call.recordingKey) return true; // already persisted

  const binding = getProviderBinding(call.channel);
  const fetchMedia = binding.provider.fetchMedia;
  if (!fetchMedia) {
    console.warn(
      `[call-recording] ${call.channel} provider has no fetchMedia — cannot download recording for call=${callId}`,
    );
    return false;
  }

  const config = await binding.getSendConfig(
    call.workspaceId,
    call.conversation.channelConnectionId,
  );
  const media = await fetchMedia(call.recordingMediaId, config, RECORDING_MAX_BYTES);

  if (expectedSha256) {
    const actual = createHash("sha256").update(media.bytes).digest("base64");
    if (actual !== expectedSha256) {
      // A truncated/corrupted transfer — retry-worthy, never stored as-is.
      console.warn(
        `[call-recording] sha256 mismatch for call=${callId} (expected ${expectedSha256}, got ${actual}) — discarding download`,
      );
      return false;
    }
  }

  const contentType =
    media.mimeType || call.recordingMimeType || "audio/ogg; codecs=opus";
  // Fixed, tenant-prefixed key: re-attempts overwrite the same object rather
  // than orphaning copies, and cleanup/listing stays workspace-scoped.
  const key = `call-recordings/${call.workspaceId}/${call.id}.ogg`;
  await blobStorage.putObject({ key, bytes: media.bytes, contentType });

  const written = await db.call.updateMany({
    where: { id: call.id, recordingKey: null },
    data: { recordingKey: key, recordingMimeType: contentType },
  });
  // Only the CAS winner announces, so a redelivered webhook racing the
  // sweeper produces exactly one frame.
  if (written.count > 0) await publishCallArtifacts(call.id);
  return true;
}

// A transcript is a JSON document — even a very long call's transcript is
// well under a megabyte; the cap is pure paranoia.
const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Same lifecycle as `downloadCallRecording`, for the transcript document.
 * Additionally extracts `transcript.language` (the provider's AUTO-DETECTED
 * spoken language, e.g. "ar") into the denormalized row column so lists can
 * show it without fetching the document.
 */
export async function downloadCallTranscript(
  callId: string,
  expectedSha256?: string | null,
): Promise<boolean> {
  const call = await db.call.findUnique({
    where: { id: callId },
    select: {
      id: true,
      workspaceId: true,
      channel: true,
      transcriptMediaId: true,
      transcriptKey: true,
      conversation: { select: { channelConnectionId: true } },
    },
  });
  if (!call?.transcriptMediaId) return true;
  if (call.transcriptKey) return true;

  const binding = getProviderBinding(call.channel);
  const fetchMedia = binding.provider.fetchMedia;
  if (!fetchMedia) {
    console.warn(
      `[call-transcript] ${call.channel} provider has no fetchMedia — cannot download transcript for call=${callId}`,
    );
    return false;
  }

  const config = await binding.getSendConfig(
    call.workspaceId,
    call.conversation.channelConnectionId,
  );
  const media = await fetchMedia(
    call.transcriptMediaId,
    config,
    TRANSCRIPT_MAX_BYTES,
  );

  if (expectedSha256) {
    const actual = createHash("sha256").update(media.bytes).digest("base64");
    if (actual !== expectedSha256) {
      console.warn(
        `[call-transcript] sha256 mismatch for call=${callId} (expected ${expectedSha256}, got ${actual}) — discarding download`,
      );
      return false;
    }
  }

  // Best-effort language extraction — a malformed document still gets stored
  // verbatim (it's the artifact of record), just without the denormalized tag.
  let language: string | null = null;
  try {
    const doc = JSON.parse(new TextDecoder().decode(media.bytes)) as {
      transcript?: { language?: unknown };
    };
    if (typeof doc.transcript?.language === "string" && doc.transcript.language) {
      language = doc.transcript.language.slice(0, 16);
    }
  } catch {
    console.warn(
      `[call-transcript] transcript for call=${callId} is not valid JSON — storing verbatim`,
    );
  }

  const key = `call-transcripts/${call.workspaceId}/${call.id}.json`;
  await blobStorage.putObject({
    key,
    bytes: media.bytes,
    contentType: "application/json",
  });

  const written = await db.call.updateMany({
    where: { id: call.id, transcriptKey: null },
    data: {
      transcriptKey: key,
      ...(language ? { transcriptLanguage: language } : {}),
    },
  });
  if (written.count > 0) await publishCallArtifacts(call.id);
  return true;
}

// ─── In-app artifact pipeline (browser-recorded calls) ──────────────────────
//
// The "inapp" artifact mode: the agent's browser records the call (stereo —
// agent left, customer right) and uploads it here. No provider announcement,
// no provider retention window — the bytes are ours from the first flush.

/**
 * Store an in-app recording upload. Periodic flushes each carry the FULL
 * file-so-far and overwrite the same key — a browser crash mid-call loses at
 * most the last flush interval, and no chunk-assembly protocol is needed. The
 * final upload remuxes to OGG/OPUS (universal playback; the browser sends
 * webm on Chrome-family, mp4/aac on Safari) and optionally kicks off the
 * Whisper transcription.
 */
export async function storeInAppRecording(
  callId: string,
  file: { bytes: Uint8Array; mimeType: string },
  opts: {
    final: boolean;
    transcribe: boolean;
    /**
     * Does the number's policy actually want the AUDIO kept? False in the
     * transcription-only configuration, where the browser still records
     * because Whisper needs bytes to work from — but the workspace said
     * "don't record calls", so the audio is transient input, not an artifact.
     * See `discardStoredRecording`.
     */
    retainRecording?: boolean;
  },
): Promise<void> {
  const call = await db.call.findUnique({
    where: { id: callId },
    select: { id: true, workspaceId: true },
  });
  if (!call) return;

  const rawKey = `call-recordings/${call.workspaceId}/${call.id}.raw`;
  if (!opts.final) {
    // Interim flush: store the browser container as-is. Playable in
    // Chrome-family if the call crashes here; the final upload replaces it.
    await blobStorage.putObject({
      key: rawKey,
      bytes: file.bytes,
      contentType: file.mimeType || "audio/webm",
    });
    await db.call.update({
      where: { id: call.id },
      data: { recordingKey: rawKey, recordingMimeType: file.mimeType || "audio/webm" },
    });
    return;
  }

  // Final: remux/transcode to OGG/OPUS for universal playback. On ffmpeg
  // failure (slot timeout under load, exotic container) keep the raw upload —
  // a recording that only plays in Chrome beats no recording.
  let key = rawKey;
  let contentType = file.mimeType || "audio/webm";
  let bytesForTranscription = file.bytes;
  try {
    const ogg = await transcodeCallRecordingToOgg(file.bytes);
    key = `call-recordings/${call.workspaceId}/${call.id}.ogg`;
    contentType = "audio/ogg";
    bytesForTranscription = ogg;
    await blobStorage.putObject({ key, bytes: ogg, contentType });
  } catch (err) {
    console.warn(
      `[call-recording] in-app remux failed for call=${callId} (${
        err instanceof Error ? err.message : err
      }) — keeping the browser container`,
    );
    await blobStorage.putObject({ key, bytes: file.bytes, contentType });
  }
  await db.call.update({
    where: { id: call.id },
    data: { recordingKey: key, recordingMimeType: contentType },
  });

  // ONLY NOW drop the interim raw — after the row points at the new key.
  //
  // ORDER IS LOAD-BEARING. This delete used to sit immediately after the OGG
  // upload, i.e. BEFORE the pointer moved. A crash (or a DB blip) in that
  // window left `recordingKey` naming an object that had just been deleted,
  // while the OGG nobody pointed at became an orphan the blob sweeper reclaims
  // 24h later — permanent loss of the recording, and unlike Meta's own
  // recordings there is no upstream copy to re-fetch, because these bytes only
  // ever existed in the agent's browser. Same class as the four blob-orphan
  // incidents that file's header documents.
  //
  // Reversed, the worst case is a stray `.raw` the sweeper reclaims on its own
  // — which is what "best-effort" should have meant all along.
  if (key !== rawKey) await blobStorage.delete(rawKey).catch(() => undefined);

  // The recording is playable NOW — tell the team before Whisper runs, so the
  // bubble the agent is looking at grows its play button immediately instead
  // of waiting on the transcription (or on a page reload).
  await publishCallArtifacts(call.id, { transcriptPending: opts.transcribe });

  if (opts.transcribe) {
    // Detached — the upload response must not wait on Whisper.
    void transcribeInAppCallRecording(call.id, bytesForTranscription, contentType)
      .then(async (ok) => {
        // A skip (AI not configured) resolves false having published nothing;
        // clear the pending flag so the "Transcribing…" chip doesn't hang.
        if (!ok) {
          await publishCallArtifacts(call.id, { transcriptPending: false });
          return;
        }
        // Transcription-only policy: the transcript is written, so the audio
        // has served its purpose and the workspace never asked to keep it.
        if (opts.retainRecording === false) await discardStoredRecording(call.id);
      })
      .catch((err) => {
        console.warn(
          `[call-transcript] in-app transcription failed for call=${callId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
        void publishCallArtifacts(call.id, { transcriptPending: false });
      });
  }
}

/**
 * Drop a call's stored audio once its transcript exists, for the
 * transcription-only policy ("Transcribe calls" on, "Record calls" off).
 *
 * The browser has to record either way — Whisper needs bytes — so without
 * this the workspace ends up with a playable recording it explicitly turned
 * off, and a play button next to a call it believes was never recorded.
 *
 * ONLY runs after a SUCCESSFUL transcription (re-checked here, not taken on
 * the caller's word). A failed or skipped transcription KEEPS the audio: it is
 * then the only artifact of that call, and losing both is a worse outcome than
 * briefly retaining audio while the transcription problem is fixed.
 *
 * ORDER IS LOAD-BEARING, and it is the REVERSE of the store path's. The row
 * pointer is cleared BEFORE the bytes are deleted, so a crash in between
 * leaves an unreferenced object the blob-orphan sweeper reclaims — never a
 * `recordingKey` naming an object that no longer exists (the failure mode
 * that file's header documents four instances of).
 */
async function discardStoredRecording(callId: string): Promise<void> {
  try {
    const row = await db.call.findUnique({
      where: { id: callId },
      select: { id: true, recordingKey: true, transcriptKey: true },
    });
    if (!row?.recordingKey) return;
    if (!row.transcriptKey) return; // no transcript ⇒ the audio is all we have

    const key = row.recordingKey;
    // CAS on the key we read: if a concurrent write re-pointed the row (a
    // late final upload landing after this transcription), leave it alone
    // rather than deleting bytes the new pointer names.
    const cleared = await db.call.updateMany({
      where: { id: row.id, recordingKey: key },
      data: { recordingKey: null, recordingMimeType: null },
    });
    if (cleared.count === 0) return;

    await blobStorage.delete(key).catch((err) => {
      // Orphaned object, reclaimed by the blob-orphan sweeper within 24h. The
      // pointer is already gone, which is the part that matters.
      console.warn(
        `[call-recording] discard: blob delete failed for call=${callId} key=${key}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    });
    // Tell the open inboxes the play button is gone, same frame that put it
    // there — otherwise it lingers until reload and 404s when clicked.
    await publishCallArtifacts(row.id, { transcriptPending: false });
  } catch (err) {
    console.warn(
      `[call-recording] discard failed for call=${callId}: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

/** Viewer-compatible transcript segment. `speaker` is the transcript
 *  document's own vocabulary — the panel maps `Business` → "Agent". */
interface TranscriptSegment {
  id: number;
  speaker: "Business" | "Customer";
  /** Seconds from the start of the call — the shared clock both channels are
   *  measured on, which is what makes interleaving them meaningful. */
  start: number;
  text: string;
}

/**
 * A channel with less speech than this was never part of the conversation.
 * Below it the channel is not sent to a speech model AT ALL — the only
 * reliable defence, because a model handed non-speech does not return
 * nothing, it returns confident nonsense (measured: silence → "人間失格",
 * noise → "Horecaonderneming").
 */
const MIN_SPEECH_SECONDS = 0.4;

/**
 * Quality gates on returned segments. Measured no_speech_prob:
 *
 *   real speech, good level        0.015 - 0.025
 *   real speech, leg 22 dB quiet   0.598   ← genuine Lebanese Arabic
 *   line noise, no speech          0.890
 *   pure digital silence           0.943
 *
 * Hence 0.8, NOT the conventional 0.6: a quiet customer's real words scored
 * 0.598, so 0.6 would have discarded the very speaker this pipeline exists to
 * recover. The primary defence against hallucination is the speech gate above
 * (a channel with no speech is never sent at all); this is the second line,
 * and it is tuned to keep words rather than to be tidy.
 *
 * NOTE the usual whisper heuristic — `no_speech_prob > 0.6 AND avg_logprob <
 * -1.0` — would not have caught the hallucinations at all: they scored -0.36
 * and -0.51, i.e. the model was *confident* about the words it invented. The
 * no-speech probability is the load-bearing signal; avg_logprob only catches a
 * second, rarer failure (a garbled decode of real audio).
 */
const MAX_NO_SPEECH_PROB = 0.8;
const MIN_AVG_LOGPROB = -1.0;
/** Text-to-compressed-size ratio above this is a repetition loop. */
const MAX_COMPRESSION_RATIO = 2.4;

/** Anything with no letters or digits — " ." and friends, what a model emits
 *  when it hears nothing but is obliged to answer. */
function isSubstantive(text: string): boolean {
  return /\p{L}|\p{N}/u.test(text);
}

interface ChannelResult {
  speaker: "Business" | "Customer";
  label: string;
  segments: Array<{ start: number; text: string }>;
  language?: string;
  /** Mean confidence of the surviving segments — drives which channel's
   *  language detection is trusted when the two disagree. */
  confidence: number;
  speechSeconds: number;
}

/**
 * Transcribe the agent and customer channels separately and label them.
 * Returns null when the audio can't be split, so the caller falls back to the
 * whole-file pass. Never throws for a per-channel failure: one side failing
 * still yields the other side's words.
 */
async function transcribePerSpeaker(
  bytes: Uint8Array,
  callId: string,
): Promise<{ text: string; language?: string; segments: TranscriptSegment[] } | null> {
  let channels: Awaited<ReturnType<typeof extractCallChannels>>;
  try {
    channels = await extractCallChannels(bytes);
  } catch (err) {
    console.warn(
      `[call-transcript] channel split failed for call=${callId} (${
        err instanceof Error ? err.message : err
      }) — falling back to the mixed transcript`,
    );
    return null;
  }
  if (!channels) return null; // mono source — nothing to separate

  const sides = [
    { speaker: "Business" as const, label: "agent", audio: channels.agent },
    { speaker: "Customer" as const, label: "customer", audio: channels.customer },
  ];

  const results = await Promise.all(
    sides.map((side) => transcribeOneChannel(side, callId)),
  );

  // ── Cross-channel language consensus ────────────────────────────────────
  // Both people on a call are speaking the same language essentially always,
  // so the two channels disagreeing means one of them was mis-detected — and
  // it is the quieter/less confident side that gets it wrong. The live bug:
  // the agent channel resolved Arabic while the customer channel, carrying
  // genuine Lebanese Arabic, came back as Cyrillic gibberish. Re-decode the
  // doubted side PINNED to the trusted language rather than storing nonsense.
  const speaking = results.filter((r) => r.segments.length > 0);
  if (speaking.length === 2) {
    const [a, b] = speaking as [ChannelResult, ChannelResult];
    if (a.language && b.language && a.language !== b.language) {
      // Trust the side with more speech to identify the language; on a tie,
      // the more confident one.
      const trusted =
        Math.abs(a.speechSeconds - b.speechSeconds) > 1
          ? (a.speechSeconds > b.speechSeconds ? a : b)
          : (a.confidence >= b.confidence ? a : b);
      const doubted = trusted === a ? b : a;
      const pin = languageToIso(trusted.language!);
      console.warn(
        `[call-transcript] call=${callId} channel language disagreement ` +
          `(${a.label}=${a.language} vs ${b.label}=${b.language}) — retrying ` +
          `${doubted.label} pinned to ${pin ?? trusted.language}`,
      );
      if (pin) {
        const side = sides.find((s) => s.speaker === doubted.speaker)!;
        const retry = await transcribeOneChannel(side, callId, pin);
        // Keep the retry only if it actually produced something; a pinned
        // decode that comes back empty must not erase what we already had.
        if (retry.segments.length > 0) Object.assign(doubted, retry);
      }
    }
  }

  // ── Interleave into one conversation ────────────────────────────────────
  const merged = results
    .flatMap((r) => r.segments.map((s) => ({ speaker: r.speaker, ...s })))
    .sort((x, y) => x.start - y.start);
  if (merged.length === 0) return null; // nothing usable — caller falls back

  // Fold consecutive segments from the same speaker into one turn. Whisper
  // splits on prosody, so a single sentence can arrive as three segments; a
  // transcript that renders those as three labelled rows reads like a stutter.
  const turns: TranscriptSegment[] = [];
  for (const seg of merged) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.text = `${last.text} ${seg.text}`.trim();
      continue;
    }
    turns.push({ id: turns.length, speaker: seg.speaker, start: seg.start, text: seg.text });
  }

  const dominant = [...results].sort((x, y) => y.speechSeconds - x.speechSeconds)[0];
  return {
    // Flat rendering for consumers that don't read segments (the /v1 document,
    // the viewer's own no-segments fallback).
    text: turns
      .map((t) => `${t.speaker === "Business" ? "Agent" : "Customer"}: ${t.text}`)
      .join("\n"),
    language: dominant?.language,
    segments: turns,
  };
}

/** One channel → filtered segments. Returns an empty result rather than
 *  throwing, so one side failing never costs the other side's words. */
async function transcribeOneChannel(
  side: { speaker: "Business" | "Customer"; label: string; audio: CallChannelAudio },
  callId: string,
  language?: string,
): Promise<ChannelResult> {
  const empty: ChannelResult = {
    speaker: side.speaker,
    label: side.label,
    segments: [],
    confidence: 0,
    speechSeconds: side.audio.speechSeconds,
  };
  // THE gate: no detected speech ⇒ no API call. A model asked to transcribe
  // silence invents text, and nothing in its answer says so.
  if (side.audio.speechSeconds < MIN_SPEECH_SECONDS) return empty;

  let res;
  try {
    res = await transcribeCallChannel({
      bytes: side.audio.bytes,
      filename: `call-${callId}-${side.label}.wav`,
      ...(language ? { language } : {}),
    });
  } catch (err) {
    console.warn(
      `[call-transcript] ${side.label} channel failed for call=${callId}: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return empty;
  }

  const kept = res.segments.filter(
    (s) =>
      s.no_speech_prob <= MAX_NO_SPEECH_PROB &&
      s.avg_logprob >= MIN_AVG_LOGPROB &&
      s.compression_ratio <= MAX_COMPRESSION_RATIO &&
      isSubstantive(s.text),
  );
  if (res.segments.length > 0 && kept.length === 0) {
    console.warn(
      `[call-transcript] call=${callId} ${side.label}: all ${res.segments.length} ` +
        `segment(s) rejected as non-speech — dropping the channel`,
    );
  }
  if (kept.length === 0) return empty;

  return {
    speaker: side.speaker,
    label: side.label,
    segments: kept.map((s) => ({ start: s.start, text: s.text.trim() })),
    language: res.language,
    confidence: kept.reduce((a, s) => a + s.avg_logprob, 0) / kept.length,
    speechSeconds: side.audio.speechSeconds,
  };
}

/**
 * whisper reports the language by NAME ("arabic"), while the API's `language`
 * PARAMETER wants ISO-639-1 ("ar"). Only the languages this platform actually
 * sees are mapped; an unmapped name simply means no retry is attempted, which
 * is the safe outcome.
 */
function languageToIso(name: string): string | null {
  const map: Record<string, string> = {
    arabic: "ar",
    english: "en",
    french: "fr",
    spanish: "es",
    turkish: "tr",
    urdu: "ur",
    hindi: "hi",
    persian: "fa",
    russian: "ru",
    german: "de",
    italian: "it",
    portuguese: "pt",
  };
  const key = name.trim().toLowerCase();
  if (map[key]) return map[key];
  // Already an ISO code (some models answer that way).
  return /^[a-z]{2}$/.test(key) ? key : null;
}

/**
 * Transcribe an in-app recording through the SAME Whisper pipeline that
 * handles inbound voice notes — Arabic-native, auto-detected.
 *
 * PER SPEAKER, not per mix. The stereo master carries the agent on the left
 * channel and the customer on the right, and each is transcribed on its own.
 * That is not a nicety: transcribing the MIX silently drops words whenever
 * both channels carry the same voice at different delays (speakerphone, an
 * agent testing against their own handset, any room where both legs are
 * audible). Measured 2026-07-29 — a 250 ms / -8 dB echo turned "Hello? Test
 * test." into "Hello, test."; the same audio, one channel isolated,
 * transcribed in full. See `extractCallChannels`.
 *
 * Falls back to a single whole-file pass when the source isn't stereo, when
 * ffmpeg is unavailable, or when the split yields nothing usable — a
 * mix-transcript beats no transcript.
 *
 * Output carries `segments` tagged `Business` / `Customer`, which the
 * transcript viewer already renders as "Agent" / "Customer". There are no
 * per-utterance timestamps: the configured STT model (`gpt-4o-transcribe` —
 * measurably better than whisper-1 on Arabic, which is this product's primary
 * language) doesn't expose them, so the two sides appear as one block each
 * rather than interleaved turns.
 */
export async function transcribeInAppCallRecording(
  callId: string,
  bytes?: Uint8Array,
  mimeType?: string,
): Promise<boolean> {
  const call = await db.call.findUnique({
    where: { id: callId },
    select: {
      id: true,
      workspaceId: true,
      transcriptKey: true,
      recordingKey: true,
      recordingMimeType: true,
    },
  });
  if (!call || call.transcriptKey) return true;
  if (!bytes) {
    if (!call.recordingKey) return false;
    const fetched = await blobStorage.fetch(call.recordingKey);
    bytes = fetched.bytes;
    mimeType = fetched.mimeType || call.recordingMimeType || "audio/ogg";
  }

  // Same gate the voice-note pipeline uses: transcription runs on the
  // workspace's own AI config (OpenAI key). Off ⇒ skip quietly — the
  // recording itself is already stored.
  const aiConfig = await loadAiConfig(call.workspaceId);
  if (!configEnabled(aiConfig)) {
    console.warn(
      `[call-transcript] AI not configured for team=${call.workspaceId} — skipping in-app transcription for call=${callId}`,
    );
    return false;
  }

  const perSpeaker = await transcribePerSpeaker(bytes, call.id);
  let result = perSpeaker;
  if (!result) {
    // Not stereo / no ffmpeg / both channels came back empty — transcribe the
    // file as it stands. A mix transcript beats no transcript.
    const mixed = await transcribeInboundAudio({
      bytes,
      filename: `call-${call.id}.ogg`,
      mimeType: mimeType ?? "audio/ogg",
    });
    result = { text: mixed.text, language: mixed.language, segments: [] };
  }

  const doc = {
    metadata: {
      processed_at: new Date().toISOString(),
      source: "inapp",
      // Which path produced this — a mix transcript is the degraded one, and
      // when a call reads badly this is the first thing worth knowing.
      channels: result.segments.length > 0 ? "per-speaker" : "mixed",
    },
    transcript: {
      text: result.text,
      language: result.language ?? null,
      segments: result.segments,
    },
  };
  const key = `call-transcripts/${call.workspaceId}/${call.id}.json`;
  await blobStorage.putObject({
    key,
    bytes: new TextEncoder().encode(JSON.stringify(doc)),
    contentType: "application/json",
  });
  const written = await db.call.updateMany({
    where: { id: call.id, transcriptKey: null },
    data: {
      transcriptKey: key,
      ...(result.language
        ? { transcriptLanguage: result.language.slice(0, 16) }
        : {}),
    },
  });
  if (written.count > 0) await publishCallArtifacts(call.id);
  return true;
}
