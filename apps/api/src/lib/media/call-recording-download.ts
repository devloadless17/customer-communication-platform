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
import { transcribeCallChannel } from "@/lib/ai/voice";
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

/**
 * Detect a REPETITION LOOP — one phrase emitted over and over until the audio
 * runs out. Seen live: a 50-second Lebanese Arabic call transcribed as "I want
 * to ask you something." repeated some twenty-five times.
 *
 * Why per-segment `compression_ratio` doesn't catch it: the loop is spread
 * ACROSS segments, and each individual segment holds one clean, unrepeated
 * sentence with a perfectly ordinary ratio. The repetition is only visible in
 * the assembled text, which is where this looks.
 *
 * Two independent signals, because a loop can repeat a sentence (caught by the
 * first) or a couple of words with no punctuation at all (caught by the second).
 */
function looksLikeRepetitionLoop(text: string): boolean {
  const normalised = text.trim().replace(/\s+/g, " ");
  if (normalised.length < 60) return false; // too short to judge

  // 1. One sentence dominating the transcript.
  const parts = normalised
    .split(/(?<=[.!?؟…])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length >= 4) {
    const counts = new Map<string, number>();
    for (const p of parts) counts.set(p, (counts.get(p) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (top[1] >= 4 && top[1] / parts.length >= 0.5) return true;
    // Or one phrase accounting for most of the CHARACTERS, which catches a
    // long repeated clause that only recurs a handful of times.
    if (top[1] >= 3 && (top[0].length * top[1]) / normalised.length >= 0.6) return true;
  }

  // 2. Vocabulary collapse — the same few words cycling with no sentence
  //    boundaries to split on.
  const words = normalised.split(" ").filter(Boolean);
  if (words.length >= 40) {
    const unique = new Set(words.map((w) => w.toLowerCase())).size;
    if (unique / words.length < 0.15) return true;
  }
  return false;
}

/**
 * What the workspace has already declared it speaks (AI Assistant → Languages
 * & Dialect). Used to VALIDATE a detection, never to force one: a result
 * naming a language the workspace doesn't speak is out-of-domain and gets
 * re-decoded pinned to the default.
 *
 * Deliberately not a blanket pin. This workspace supports Arabic AND English
 * with code-switching on, so hard-pinning Arabic would mistranslate a genuine
 * English call — and pinning on non-speech is actively harmful (measured:
 * silence + `language=ar` returns "اشتركوا في القناة", the classic
 * subtitle-scraped hallucination).
 */
interface LanguagePolicy {
  /** ISO codes the workspace says it speaks, e.g. ["ar", "en"]. */
  supported: string[];
  /** ISO fallback used when a detection lands outside `supported`. */
  fallback: string | null;
}

function languagePolicyFrom(config: {
  supportedLanguages?: unknown;
  defaultLanguage?: string | null;
  specificLanguage?: string | null;
  languagePolicy?: string | null;
}): LanguagePolicy {
  const supported = Array.isArray(config.supportedLanguages)
    ? config.supportedLanguages
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
    : [];
  const fallback =
    (config.languagePolicy === "specific" ? config.specificLanguage : null) ??
    config.defaultLanguage ??
    null;
  return {
    supported,
    fallback: fallback ? fallback.trim().toLowerCase().slice(0, 5) : null,
  };
}

/**
 * True when a detected language is one the workspace actually speaks.
 *
 * An empty `supported` list means "the operator declared nothing", which
 * accepts everything — never invent a restriction nobody configured.
 *
 * A name that maps to NO ISO code is treated as IMPLAUSIBLE, not as unknown.
 * That direction is the whole point: `supported` can only ever hold codes from
 * the settings picker, so a detection the map has never heard of — "bashkir",
 * the language behind the Cyrillic gibberish — is by construction not one of
 * them. Defaulting the unmappable case to "plausible" silently disabled this
 * guard for exactly the exotic detections it exists to catch, which is what
 * the spec caught.
 */
function isPlausibleLanguage(detected: string | undefined, policy: LanguagePolicy): boolean {
  if (!detected || policy.supported.length === 0) return true;
  const iso = languageToIso(detected);
  return iso !== null && policy.supported.includes(iso);
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
  policy: LanguagePolicy,
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

  // Transcribe the isolated legs AND the playback mix, then keep whichever
  // actually held the conversation. See `pickBestRendering` — this is the
  // difference between "usually better" and "never worse".
  const [agentR, customerR, mixR] = await Promise.all([
    transcribeOneChannel(sides[0]!, callId, policy),
    transcribeOneChannel(sides[1]!, callId, policy),
    transcribeOneChannel(
      { speaker: "Business", label: "mixed", audio: channels.mixed },
      callId,
      policy,
    ),
  ]);
  const results = [agentR, customerR];

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
        const retry = await transcribeOneChannel(side, callId, policy, pin);
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
  const perSpeaker =
    turns.length > 0
      ? {
          // Flat rendering for consumers that don't read segments (the /v1
          // document, the viewer's own no-segments fallback).
          text: turns
            .map((t) => `${t.speaker === "Business" ? "Agent" : "Customer"}: ${t.text}`)
            .join("\n"),
          language: dominant?.language,
          segments: turns,
        }
      : null;

  const mixed =
    mixR.segments.length > 0
      ? {
          text: mixR.segments.map((s) => s.text).join(" "),
          language: mixR.language,
          // A mix cannot be attributed. Leaving segments empty says so honestly
          // rather than labelling every word with a speaker we didn't identify.
          segments: [] as TranscriptSegment[],
        }
      : null;

  return pickBestRendering(perSpeaker, mixed, callId);
}

/**
 * Choose between the speaker-attributed rendering and the flat mix.
 *
 * Neither is better in every room, which is the whole reason both are
 * transcribed:
 *
 *   - Legs that are independent (a customer on a distant phone) → isolating
 *     the channels is clearly right. Measured: transcribing the MIX of such a
 *     call dropped an entire speaker.
 *   - Both devices in ONE room (an agent testing against their own handset,
 *     a speakerphone right next to the laptop) → each leg carries the same
 *     voice, and the browser's echo canceller chews up the microphone leg
 *     fighting it. The isolated channels are then WORSE than the mix, which
 *     is what a human hears on playback and finds perfectly clear.
 *
 * So the split has to earn its place per call: it wins only if it retained
 * essentially all of the words the mix found. Speaker labels are worth having,
 * but never at the cost of the words themselves — losing content is the
 * complaint that started this whole thread.
 */
function pickBestRendering(
  perSpeaker: { text: string; language?: string; segments: TranscriptSegment[] } | null,
  mixed: { text: string; language?: string; segments: TranscriptSegment[] } | null,
  callId: string,
): { text: string; language?: string; segments: TranscriptSegment[] } | null {
  if (!perSpeaker) return mixed;
  if (!mixed) return perSpeaker;

  // Compare CONTENT, not characters: the per-speaker text carries "Agent:" /
  // "Customer:" prefixes the mix doesn't have, and counting those would hand
  // the split a free advantage.
  const splitLen = perSpeaker.segments.reduce((n, s) => n + s.text.length, 0);
  const mixLen = mixed.text.length;

  // This gate exists to catch a COLLAPSE, not to police normal variance. The
  // echo failure it was built from left the split at ~40% of the mix
  // ("I don't...just...just..." against a clear sentence), while two healthy
  // decodes of the same audio routinely differ by 10-20% over filler words
  // alone. At 0.85 the split would lose its labels over an "um"; 0.7 catches
  // the collapse and keeps attribution everywhere else.
  if (splitLen >= mixLen * 0.7) return perSpeaker;

  console.warn(
    `[call-transcript] call=${callId}: per-speaker split kept ${splitLen} chars vs ` +
      `${mixLen} from the mix — the legs are probably echoing each other ` +
      `(two devices in one room); using the mix and dropping speaker labels`,
  );
  return mixed;
}

/**
 * One channel → filtered segments, with a retry ladder.
 *
 * Attempt 1 decodes at temperature 0 and lets the model detect the language.
 * A result is REJECTED and retried when it is a repetition loop, when every
 * segment fails the quality gates, or when the detected language is one the
 * workspace doesn't speak. Each retry raises the temperature (the documented
 * escape from a loop) and, once the detection has proven untrustworthy, pins
 * the workspace's default language.
 *
 * If the ladder runs out, this returns EMPTY. That is the point: no transcript
 * is a better answer than a confident wrong one, and every earlier version of
 * this code stored whatever came back.
 *
 * Returns an empty result rather than throwing, so one side failing never
 * costs the other side's words.
 */
async function transcribeOneChannel(
  side: {
    speaker: "Business" | "Customer";
    label: string;
    audio: CallChannelAudio;
    /** Wire type of `audio.bytes`. Isolated channels are mono WAV (the
     *  default); the whole-file fallback passes the recording's own
     *  container, and it MUST be declared honestly — the API picks its
     *  decoder from it. */
    mimeType?: string;
  },
  callId: string,
  policy: LanguagePolicy,
  pinnedLanguage?: string,
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

  // Temperature 0 first — correct for the overwhelming majority of audio. The
  // higher rungs exist only to break a loop.
  const ladder = [0, 0.4, 0.8];
  let language = pinnedLanguage;

  for (let attempt = 0; attempt < ladder.length; attempt++) {
    let res;
    try {
      const mime = side.mimeType ?? "audio/wav";
      res = await transcribeCallChannel({
        bytes: side.audio.bytes,
        // Extension follows the real container: the API reads BOTH it and the
        // content type to choose a decoder, so a `.wav` name on OGG bytes is
        // a decode failure waiting to happen.
        filename: `call-${callId}-${side.label}.${extensionForAudio(mime)}`,
        mimeType: mime,
        temperature: ladder[attempt],
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
    const assembled = kept.map((s) => s.text.trim()).join(" ");
    const looped = looksLikeRepetitionLoop(assembled);
    const wrongLanguage = !isPlausibleLanguage(res.language, policy);

    if (kept.length > 0 && !looped && !wrongLanguage) {
      return {
        speaker: side.speaker,
        label: side.label,
        segments: kept.map((s) => ({ start: s.start, text: s.text.trim() })),
        language: res.language,
        confidence: kept.reduce((a, s) => a + s.avg_logprob, 0) / kept.length,
        speechSeconds: side.audio.speechSeconds,
      };
    }

    const why = looped
      ? "repetition loop"
      : wrongLanguage
        ? `detected ${res.language}, which this workspace doesn't speak`
        : `all ${res.segments.length} segment(s) rejected as non-speech`;
    const isLast = attempt === ladder.length - 1;
    console.warn(
      `[call-transcript] call=${callId} ${side.label}: ${why} at temperature ` +
        `${ladder[attempt]}${language ? ` (language=${language})` : ""}` +
        (isLast ? " — discarding the channel" : " — retrying"),
    );
    // Once the model's own language choice has proven wrong, stop trusting it
    // and pin what the workspace says it speaks.
    if ((wrongLanguage || looped) && !language && policy.fallback) {
      language = policy.fallback;
    }
  }
  return empty;
}

/**
 * Pure decision functions, exported for the guard spec. These encode three
 * live incidents (Cyrillic gibberish, an English repetition loop over an
 * Arabic call, punctuation-only output for silence) and their thresholds are
 * measured, not guessed — so they are tested directly rather than through a
 * network round-trip that can't reproduce a hallucination on demand.
 */
export const __testing__ = {
  looksLikeRepetitionLoop,
  isPlausibleLanguage,
  languagePolicyFrom,
  isSubstantive,
  pickBestRendering,
};

/** File extension matching an audio wire type. The transcription API accepts
 *  a fixed set of containers and reads the FILENAME as well as the content
 *  type, so the two must agree. */
function extensionForAudio(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("webm")) return "webm";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "mp4";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "wav";
}

/**
 * whisper reports the language by NAME ("arabic"), while the API's `language`
 * PARAMETER wants ISO-639-1 ("ar"). Only the languages this platform actually
 * sees are mapped; an unmapped name simply means no retry is attempted, which
 * is the safe outcome.
 */
function languageToIso(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (LANGUAGE_ISO[key]) return LANGUAGE_ISO[key];
  // Already an ISO code (some models answer that way).
  return /^[a-z]{2}$/.test(key) ? key : null;
}

/**
 * Language name → ISO-639-1, covering EVERY option the AI Assistant →
 * Languages & Dialect picker offers.
 *
 * Completeness is load-bearing, not cosmetic: `isPlausibleLanguage` treats an
 * unmappable name as out-of-domain, so a language the operator legitimately
 * selected but this map omits would have its transcripts rejected and
 * discarded. Adding a language to that picker means adding it here.
 */
const LANGUAGE_ISO: Record<string, string> = {
  arabic: "ar",
  english: "en",
  french: "fr",
  spanish: "es",
  german: "de",
  italian: "it",
  portuguese: "pt",
  dutch: "nl",
  russian: "ru",
  turkish: "tr",
  persian: "fa",
  farsi: "fa",
  urdu: "ur",
  hindi: "hi",
  bengali: "bn",
  chinese: "zh",
  japanese: "ja",
  korean: "ko",
  indonesian: "id",
  malay: "ms",
  thai: "th",
  vietnamese: "vi",
  greek: "el",
  polish: "pl",
  ukrainian: "uk",
  romanian: "ro",
  swedish: "sv",
  danish: "da",
  finnish: "fi",
  norwegian: "no",
  czech: "cs",
  hungarian: "hu",
  swahili: "sw",
  hausa: "ha",
  amharic: "am",
  tagalog: "tl",
};

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

  const policy = languagePolicyFrom(aiConfig);
  let result = await transcribePerSpeaker(bytes, call.id, policy);

  if (!result) {
    // Not stereo, no ffmpeg, or every channel was discarded. Transcribe the
    // file whole — but through the SAME gated path, never a raw one.
    //
    // THIS IS WHERE THE GIBBERISH CAME FROM. The fallback used to call the
    // voice-note transcriber directly: a different model, no segment
    // metadata, and therefore no quality gate of any kind — so a 50-second
    // Lebanese Arabic call came back as one English sentence repeated
    // twenty-five times and was stored verbatim. An unguarded fallback behind
    // a guarded path just relocates the failure.
    const mixed = await transcribeOneChannel(
      {
        speaker: "Business",
        label: "mixed",
        // The whole file as one "channel". `speechSeconds` is asserted rather
        // than measured: the split already failed, and a recording that
        // reached this function has audio in it — the segment gates below are
        // what protect this path.
        audio: { bytes, meanVolumeDb: 0, speechSeconds: Number.POSITIVE_INFINITY },
        mimeType: mimeType ?? "audio/ogg",
      },
      call.id,
      policy,
    );
    if (mixed.segments.length > 0) {
      result = {
        text: mixed.segments.map((s) => s.text).join(" "),
        language: mixed.language,
        // No speaker attribution is possible from a mix — say so by leaving
        // segments empty rather than labelling every word "Agent".
        segments: [],
      };
    }
  }

  if (!result) {
    // Nothing survived. STORE NOTHING. An absent transcript is an honest
    // answer; a hallucinated one is worse than useless because it reads as
    // fact — the agent has no way to tell it apart from a real one.
    console.warn(
      `[call-transcript] call=${call.id}: no usable speech after all retries — storing no transcript`,
    );
    return false;
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
