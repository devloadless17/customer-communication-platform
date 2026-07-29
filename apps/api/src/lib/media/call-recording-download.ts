import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { getProviderBinding } from "@/lib/providers";
import { transcodeCallRecordingToOgg } from "@/lib/media/audio-transcode";
import { transcribeInboundAudio } from "@/lib/ai/voice";
import { configEnabled, loadAiConfig } from "@/lib/ai/runtime-config";

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

  await db.call.updateMany({
    where: { id: call.id, recordingKey: null },
    data: { recordingKey: key, recordingMimeType: contentType },
  });
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

  await db.call.updateMany({
    where: { id: call.id, transcriptKey: null },
    data: {
      transcriptKey: key,
      ...(language ? { transcriptLanguage: language } : {}),
    },
  });
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
  opts: { final: boolean; transcribe: boolean },
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

  if (opts.transcribe) {
    // Detached — the upload response must not wait on Whisper.
    void transcribeInAppCallRecording(call.id, bytesForTranscription, contentType).catch(
      (err) => {
        console.warn(
          `[call-transcript] in-app transcription failed for call=${callId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      },
    );
  }
}

/**
 * Transcribe an in-app recording through the SAME Whisper pipeline that
 * handles inbound voice notes — Arabic-native, auto-detected. Produces a
 * viewer-compatible transcript document (text + language; no per-speaker
 * segments in v1 — the stereo master preserves the channel split for a
 * future per-speaker pass).
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

  const result = await transcribeInboundAudio({
    bytes,
    filename: `call-${call.id}.ogg`,
    mimeType: mimeType ?? "audio/ogg",
  });
  const doc = {
    metadata: {
      processed_at: new Date().toISOString(),
      source: "inapp",
    },
    transcript: {
      text: result.text,
      language: result.language ?? null,
      segments: [],
    },
  };
  const key = `call-transcripts/${call.workspaceId}/${call.id}.json`;
  await blobStorage.putObject({
    key,
    bytes: new TextEncoder().encode(JSON.stringify(doc)),
    contentType: "application/json",
  });
  await db.call.updateMany({
    where: { id: call.id, transcriptKey: null },
    data: {
      transcriptKey: key,
      ...(result.language
        ? { transcriptLanguage: result.language.slice(0, 16) }
        : {}),
    },
  });
  return true;
}
