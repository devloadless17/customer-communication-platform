import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { getProviderBinding } from "@/lib/providers";

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
