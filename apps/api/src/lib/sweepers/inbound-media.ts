import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { blobStorage } from "@/lib/blob-storage";
import { MEDIA_SIZE_CAPS } from "@/lib/media-storage";
import { getMetaProvider } from "@/lib/providers";
import { MediaTooLargeError } from "@/lib/providers/meta";
import { getMetaSendConfig } from "@/lib/providers/config";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";
import type { MediaKind } from "@ccp/shared/types";

/**
 * Reconcile inbound message rows left media-pending (`mediaKind` set +
 * `mediaUrl` null). The steady-state path
 * ([webhooks/meta/meta.controller.ts](../../webhooks/meta/meta.controller.ts))
 * downloads + uploads the binary in the background and patches the row; a
 * PERMANENT failure (over cap / no send config) clears the row to text-only
 * inline. What lands here is a row whose download hit a TRANSIENT failure
 * (Meta-CDN / blob blip) and was deliberately PARKED rather than cleared —
 * because Meta retains the inbound binary for ~30 days, so a later re-download
 * can still recover it.
 *
 * This sweeper therefore does two jobs over a parked row's life:
 *   1. RE-DOWNLOAD: for a row past the in-flight grace window but still inside
 *      the recovery horizon, re-attempt the download from the Meta media id in
 *      `rawPayload` (throttled per-row so a sustained outage doesn't hammer
 *      Meta). On success it patches the row + emits `message:media_ready` with
 *      media — the bubble swaps its shimmer for the image. Reuses the same lib
 *      primitives the controller uses; no new infrastructure.
 *   2. FINAL DOWNGRADE: once a row is older than the recovery horizon and the
 *      download still hasn't landed, CLEAR the media columns + emit an empty
 *      `message:media_ready` so the shimmer collapses to a text-only bubble
 *      (caption preserved in `body`). This is also the defense-in-depth path
 *      for any future failure mode that strands a partial write.
 */

const SWEEP_INTERVAL_MS = 60 * 1000;
// Rows younger than this may still have an in-flight download from the original
// request (slow video, 4-in-flight concurrency) — don't touch them.
const STALE_THRESHOLD_MS = 2 * 60 * 1000;
// How long we keep re-attempting a parked row before the final text-only
// downgrade. Comfortably inside Meta's ~30-day media retention; long enough to
// ride out any realistic blob-storage / Meta-CDN outage window.
const RECOVERY_HORIZON_MS = 24 * 60 * 60 * 1000;
// Minimum gap between re-download attempts for the SAME row. Hourly keeps a
// sustained outage from re-fetching every 60s for 24h while still recovering
// promptly once the dependency returns. Process-local (resets on restart, which
// just triggers a fresh attempt — the download + CAS patch is idempotent).
const RETRY_THROTTLE_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
// In-flight guard — prevents a slow sweep (re-downloads + batched UPDATE + N
// media-ready publishes) from overlapping with the next interval tick.
let inFlight = false;
// Per-row last-attempt timestamps for the hourly throttle. Grow-only Map at
// pilot scale (bounded by the count of currently-parked media rows, which is
// tiny outside an active outage); entries are pruned once the row resolves or
// crosses the horizon. Process-local by design — see RETRY_THROTTLE_MS.
const lastAttemptAt = new Map<string, number>();

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Mutex serializes against heavy daily/weekly sweepers. The query here
    // is small (100-row partial-index scan) so the skip-when-busy semantics
    // are fine — a missed 60s tick is recovered on the next.
    await withSweeperMutex("inbound-media", sweepOnce);
  } catch (err) {
    console.error(`[sweeper.inbound-media] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startInboundMediaSweeper(): void {
  if (timer) return;
  // Run once on boot to recover/clear casualties from the previous process.
  // Then settle into the periodic cadence.
  void runTick("initial sweep");
  timer = setInterval(() => {
    void runTick("sweep");
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export function stopInboundMediaSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const now = Date.now();
  const cutoff = new Date(now - STALE_THRESHOLD_MS);
  const horizon = new Date(now - RECOVERY_HORIZON_MS);

  // Find inbound rows whose phase-2 download never landed. Outbound rows
  // never go through the pending state (the send route writes media columns
  // synchronously or not at all), so the `direction = "in"` predicate is
  // both a safety guard and lets the partial inbound index do the work.
  const stuck = await db.message.findMany({
    where: {
      direction: "in",
      mediaKind: { not: null },
      mediaUrl: null,
      createdAt: { lt: cutoff },
    },
    select: {
      id: true,
      teamId: true,
      conversationId: true,
      mediaKind: true,
      mediaMimeType: true,
      mediaFilename: true,
      mediaDurationMs: true,
      mediaVoice: true,
      body: true,
      createdAt: true,
      rawPayload: true,
      externalId: true,
    },
    take: 100,
  });

  if (stuck.length === 0) return;

  // Partition: rows past the recovery horizon get the final downgrade; the
  // rest are eligible for a throttled re-download attempt.
  const expired = stuck.filter((r) => r.createdAt < horizon);
  const retriable = stuck.filter((r) => r.createdAt >= horizon);

  for (const row of retriable) {
    const last = lastAttemptAt.get(row.id) ?? 0;
    if (now - last < RETRY_THROTTLE_MS) continue;
    lastAttemptAt.set(row.id, now);
    try {
      await retryDownload(row);
    } catch (err) {
      // Stay parked for the next hour — the row keeps its caption-bearing
      // shimmer; we just couldn't recover this pass.
      console.warn(
        `[sweeper.inbound-media] re-download failed for ${row.id} — staying parked`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (expired.length === 0) return;

  // Clear the expired rows in one batched UPDATE — far cheaper than per-row.
  const ids = expired.map((r) => r.id);
  await db.message.updateMany({
    where: { id: { in: ids } },
    data: {
      mediaKind: null,
      mediaMimeType: null,
      mediaCaption: null,
      mediaFilename: null,
      mediaDurationMs: null,
      mediaKey: null,
      mediaUrl: null,
      mediaSizeBytes: null,
    },
  });

  // Tell every live client to drop the pending placeholder. Same payload
  // shape as the success path: omit `media` so the bubble strips its
  // media block and renders as a regular text row.
  for (const row of expired) {
    lastAttemptAt.delete(row.id);
    await publish({
      type: "message.media_ready",
      teamId: row.teamId,
      conversationId: row.conversationId,
      messageId: row.id,
      // No media → socket-fanout emits the "ready" event without payload.
    });
  }

  console.warn(
    `[sweeper.inbound-media] downgraded ${expired.length} stale pending media row(s) to text-only after recovery horizon`,
  );
}

type ParkedRow = {
  id: string;
  teamId: string;
  conversationId: string;
  mediaKind: string | null;
  mediaMimeType: string | null;
  mediaFilename: string | null;
  mediaDurationMs: number | null;
  mediaVoice: boolean | null;
  body: string;
  rawPayload: unknown;
  externalId: string;
};

/**
 * Re-attempt the download for one parked row from the Meta media id preserved
 * in `rawPayload`, then patch the row + emit `message:media_ready`. CAS-gated
 * on `mediaUrl: null, mediaKind: { not: null }` so a concurrent completion
 * (e.g. a Meta webhook retry's download that landed first) makes this a no-op
 * instead of a torn write. Throws on any failure so the caller keeps the row
 * parked for the next pass.
 */
async function retryDownload(row: ParkedRow): Promise<void> {
  const mediaKind = row.mediaKind as MediaKind | null;
  if (!mediaKind) return;

  const externalMediaId = extractMediaId(row.rawPayload, row.externalId);
  if (!externalMediaId) {
    // No media id to retry from — nothing the horizon backstop won't clear.
    return;
  }

  const sendConfig = await getMetaSendConfig(row.teamId);
  const cap = MEDIA_SIZE_CAPS[mediaKind];
  // minor#3: pass the cap so fetchMedia rejects via Content-Length BEFORE
  // buffering the binary into heap (RAM guard), same as the webhook path.
  let fetched;
  try {
    fetched = await getMetaProvider().fetchMedia!(externalMediaId, sendConfig, cap);
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      // Deterministically over cap — clear now rather than re-fetching forever.
      await clearOne(row);
      return;
    }
    throw err;
  }

  if (fetched.bytes.length > cap) {
    // Deterministically over cap — clear now rather than re-fetching forever.
    await clearOne(row);
    return;
  }

  const saved = await blobStorage.upload({
    bytes: fetched.bytes,
    mimeType: fetched.mimeType,
    kind: mediaKind,
    context: {
      teamId: row.teamId,
      direction: "in",
      externalId: row.externalId,
      originalFilename: row.mediaFilename ?? null,
    },
  });

  const updated = await db.message.updateMany({
    where: { id: row.id, mediaUrl: null, mediaKind: { not: null } },
    data: {
      mediaKey: saved.key,
      mediaUrl: saved.url,
      mediaSizeBytes: saved.sizeBytes,
      mediaMimeType: fetched.mimeType,
    },
  });
  if (updated.count === 0) return;

  lastAttemptAt.delete(row.id);
  await publish({
    type: "message.media_ready",
    teamId: row.teamId,
    conversationId: row.conversationId,
    messageId: row.id,
    media: {
      kind: mediaKind,
      url: `/api/media/${row.id}`,
      mimeType: fetched.mimeType,
      sizeBytes: saved.sizeBytes,
      ...(row.body ? { caption: row.body } : {}),
      ...(row.mediaFilename ? { filename: row.mediaFilename } : {}),
      ...(row.mediaDurationMs != null ? { durationMs: row.mediaDurationMs } : {}),
      // Keep the voice-note affordance when the sweeper recovers a parked voice
      // note (applyMessageMediaReady replaces media wholesale — see the inbound
      // live path in meta.controller.ts).
      ...(row.mediaVoice ? { voice: true } : {}),
    },
  });
}

/** Clear a single parked row to text-only + emit the empty ready frame. */
async function clearOne(row: ParkedRow): Promise<void> {
  const cleared = await db.message.updateMany({
    where: { id: row.id, mediaKind: { not: null }, mediaUrl: null },
    data: {
      mediaKind: null,
      mediaMimeType: null,
      mediaCaption: null,
      mediaFilename: null,
      mediaDurationMs: null,
      mediaKey: null,
      mediaUrl: null,
      mediaSizeBytes: null,
    },
  });
  lastAttemptAt.delete(row.id);
  if (cleared.count === 0) return;
  await publish({
    type: "message.media_ready",
    teamId: row.teamId,
    conversationId: row.conversationId,
    messageId: row.id,
  });
}

/**
 * Pull the Meta media id back out of the verbatim webhook body for the message
 * with id `externalId`. Mirrors the parser walk in
 * [lib/providers/meta.ts](../providers/meta.ts) (`m[m.type].id`). Returns null
 * for any shape we don't recognise so a malformed payload keeps the row parked
 * rather than throwing.
 */
function extractMediaId(rawPayload: unknown, externalId: string): string | null {
  const p = rawPayload as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          messages?: Array<{
            id?: string;
            type?: string;
            [k: string]: unknown;
          }>;
        };
      }>;
    }>;
  };
  for (const entry of p?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        if (m.id !== externalId || !m.type) continue;
        const sub = m[m.type] as { id?: string } | undefined;
        if (sub?.id) return sub.id;
      }
    }
  }
  return null;
}
