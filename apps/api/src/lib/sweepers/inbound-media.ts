import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { blobStorage } from "@/lib/blob-storage";
import { MEDIA_SIZE_CAPS } from "@/lib/media-storage";
import { getMetaProvider } from "@/lib/providers";
import { MediaTooLargeError } from "@/lib/providers/meta";
import { getMetaSendConfig } from "@/lib/providers/config";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";
import { extractVideoPosterFrame } from "@/lib/media-thumbnail";
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
// A non-WhatsApp row can't be re-downloaded (no re-fetchable media id), so its
// only outcomes are "in-flight completion" or "final downgrade". A multi-
// attachment social burst can legitimately still be downloading well past the
// 2-min in-flight grace (fetchUrlBytes: 20s timeout × 3 retries per attachment,
// 4-wide lanes over a 12-photo message ≈ 3 min under a degraded Meta CDN), so
// downgrading at 2 min races a still-successful download and drops the media.
// Wait comfortably past worst-case wall time before the text-only downgrade.
const SOCIAL_INFLIGHT_GRACE_MS = 10 * 60 * 1000;
// How long we keep re-attempting a parked row before the final text-only
// downgrade. Comfortably inside Meta's ~30-day media retention; long enough to
// ride out any realistic blob-storage / Meta-CDN outage window.
const RECOVERY_HORIZON_MS = 24 * 60 * 60 * 1000;
// Minimum gap between re-download attempts for the SAME row. Hourly keeps a
// sustained outage from re-fetching every 60s for 24h while still recovering
// promptly once the dependency returns. Process-local (resets on restart, which
// just triggers a fresh attempt — the download + CAS patch is idempotent).
const RETRY_THROTTLE_MS = 60 * 60 * 1000;
// Max DISTINCT rows we re-download per tick. Each attempt can block on the
// Meta CDN / R2 for the full request timeout, so bounding the batch keeps a
// sustained outage from turning one tick into a multi-minute run. The hourly
// per-row throttle already limits re-attempts; this caps work-per-tick.
const MAX_RETRIABLE_PER_TICK = 10;

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
    // PHASE 1 — under the mutex: the pool-pressuring DB work ONLY (the 100-row
    // partial-index scan + the batched downgrade UPDATE + the downgrade
    // publishes). Small + fast, so the skip-when-busy mutex semantics are fine.
    // `undefined` when the mutex was held (another sweeper running) — treat as
    // "nothing to retry this tick".
    const retriable =
      (await withSweeperMutex("inbound-media", selectAndDowngrade)) ?? [];
    // PHASE 2 — NO mutex: the network-bound re-downloads. These hit the Meta
    // CDN + R2, NOT the Prisma pool the mutex exists to protect. Holding the
    // single global sweeper mutex across a multi-minute Meta/R2 outage would
    // starve every other mutex-protected sweeper (stale-calls, retention,
    // blob-orphan). The batch is already capped in PHASE 1.
    if (retriable.length > 0) await retryParkedRows(retriable);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopInboundMediaSweeper();
      return;
    }
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

/**
 * PHASE 1 (under mutex): scan for parked rows, downgrade the expired ones in
 * one batched UPDATE, and RETURN the throttle-eligible retriable rows (capped)
 * for the caller to re-download OUTSIDE the mutex. Only DB/pool + socket work
 * runs here — nothing network-bound.
 */
async function selectAndDowngrade(): Promise<ParkedRow[]> {
  const now = Date.now();
  const cutoff = new Date(now - STALE_THRESHOLD_MS);
  const horizon = new Date(now - RECOVERY_HORIZON_MS);
  const socialGrace = new Date(now - SOCIAL_INFLIGHT_GRACE_MS);

  // Find inbound rows whose phase-2 download never landed. Outbound rows
  // never go through the pending state (the send route writes media columns
  // synchronously or not at all), so the `direction = "in"` predicate is a
  // safety guard. This exact predicate is served by the partial index
  // `Message_inbound_media_pending_idx` (migration 20260622120000) — without
  // it the 60s tick seq-scans the whole Message table.
  const stuck = await db.message.findMany({
    where: {
      direction: "in",
      mediaKind: { not: null },
      mediaUrl: null,
      createdAt: { lt: cutoff },
    },
    select: {
      id: true,
      workspaceId: true,
      conversationId: true,
      channel: true,
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

  if (stuck.length === 0) return [];

  // Partition: rows past the recovery horizon get the final downgrade; the
  // rest are eligible for a throttled re-download attempt. Only WhatsApp rows
  // are retriable — `retryDownload` reconstructs the Meta media id from the
  // WhatsApp webhook shape, so a stranded Messenger/Instagram row (expiring CDN
  // URL, no re-fetchable media id) can never be recovered here; downgrade it
  // straight to text-only instead of looping a no-op retry until the horizon.
  // But a social row can still be legitimately in-flight past the 2-min cutoff,
  // so hold its downgrade until SOCIAL_INFLIGHT_GRACE_MS — a row inside that
  // window is neither expired nor retriable, so it stays parked and lets the
  // controller's still-running download win the CAS instead of being nulled out.
  const expired = stuck.filter(
    (r) =>
      r.createdAt < horizon ||
      (r.channel !== "whatsapp" && r.createdAt < socialGrace),
  );
  const retriable = stuck.filter((r) => r.createdAt >= horizon && r.channel === "whatsapp");

  // Downgrade the expired rows FIRST — both the batched UPDATE and the
  // media_ready publishes are DB/socket-bound (cheap), so they belong under
  // the mutex.
  if (expired.length > 0) {
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
      // Per-row isolation: the DB downgrade already committed in the batched
      // updateMany above, so these rows will NOT be re-selected next tick
      // (mediaKind is null). If one publish throws, swallowing it here keeps
      // the remaining rows' "drop the placeholder" frames flowing instead of
      // aborting the loop and stranding every later row's live shimmer.
      try {
        await publish({
          type: "message.media_ready",
          workspaceId: row.workspaceId,
          conversationId: row.conversationId,
          messageId: row.id,
          // No media → socket-fanout emits the "ready" event without payload.
        });
      } catch (err) {
        console.warn(
          `[sweeper.inbound-media] downgrade publish failed for ${row.id} (DB already correct; client refreshes on reload)`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.warn(
      `[sweeper.inbound-media] downgraded ${expired.length} stale pending media row(s) to text-only after recovery horizon`,
    );
  }

  // Select the re-download batch: throttle-eligible rows only (hourly per
  // row), capped per tick. Stamp lastAttemptAt NOW so the throttle accounts
  // for this attempt even though the download itself runs in PHASE 2 outside
  // the mutex. Filter BEFORE the cap so the budget isn't wasted on throttled
  // rows (which would stall recovery of the eligible ones behind them).
  const batch = retriable
    .filter((r) => now - (lastAttemptAt.get(r.id) ?? 0) >= RETRY_THROTTLE_MS)
    .slice(0, MAX_RETRIABLE_PER_TICK);
  for (const row of batch) lastAttemptAt.set(row.id, now);
  return batch;
}

/**
 * PHASE 2 (NO mutex): re-download each parked row from its Meta media id. Each
 * call is network-bound (Meta CDN + R2) and may block on the full request
 * timeout during an outage — which is exactly why this runs OFF the mutex, so
 * a slow dependency can't starve the other mutex-protected sweepers.
 */
async function retryParkedRows(rows: ParkedRow[]): Promise<void> {
  for (const row of rows) {
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
}

type ParkedRow = {
  id: string;
  workspaceId: string;
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

  const sendConfig = await getMetaSendConfig(row.workspaceId);
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

  let saved;
  try {
    saved = await blobStorage.upload({
      bytes: fetched.bytes,
      mimeType: fetched.mimeType,
      kind: mediaKind,
      context: {
        workspaceId: row.workspaceId,
        direction: "in",
        externalId: row.externalId,
        originalFilename: row.mediaFilename ?? null,
      },
    });
  } catch (err) {
    if (isDeterministicMediaRejection(err)) {
      // Mime allowlist / magic-byte mismatch — re-downloading yields the same
      // bytes that fail the same gate, so clear now rather than re-fetching
      // hourly for the full 24h horizon. Mirrors the MediaTooLargeError branch.
      await clearOne(row);
      return;
    }
    throw err;
  }

  // Video-only: mirror the live ingest path (meta.controller.ts) and generate a
  // poster frame so a sweeper-recovered video doesn't render as a black box.
  // Best-effort — an ffmpeg failure / corrupt video leaves the thumbnail fields
  // null and the bubble falls back to bg-black, same as the live path degrades.
  let thumbKey: string | undefined;
  let thumbUrl: string | undefined;
  if (mediaKind === "video") {
    try {
      const poster = await extractVideoPosterFrame(fetched.bytes);
      if (poster && poster.length > 0) {
        const thumb = await blobStorage.upload({
          bytes: poster,
          mimeType: "image/jpeg",
          kind: "image",
          context: {
            workspaceId: row.workspaceId,
            direction: "in",
            // Suffix the wamid so the dashboard filename is distinct from the
            // original video's blob (matches the live path's `_thumb` customId).
            externalId: `${row.externalId}_thumb`,
            originalFilename: null,
          },
        });
        thumbKey = thumb.key;
        thumbUrl = thumb.url;
      }
    } catch (err) {
      console.warn(
        `[sweeper.inbound-media] video poster generation failed for ${row.externalId}`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const updated = await db.message.updateMany({
    where: { id: row.id, mediaUrl: null, mediaKind: { not: null } },
    data: {
      mediaKey: saved.key,
      mediaUrl: saved.url,
      mediaSizeBytes: saved.sizeBytes,
      mediaMimeType: fetched.mimeType,
      ...(thumbKey ? { mediaThumbnailKey: thumbKey, mediaThumbnailUrl: thumbUrl } : {}),
    },
  });
  // A concurrent completion won the CAS — the thumb blob we may have uploaded
  // above is now unreferenced, but the blob-orphan sweeper reclaims it (and the
  // `_thumb` customId guard keeps it from being deleted before then). Still
  // prune the throttle entry: the row IS resolved, so its grow-only Map entry
  // must not leak until process restart.
  lastAttemptAt.delete(row.id);
  if (updated.count === 0) return;

  await publish({
    type: "message.media_ready",
    workspaceId: row.workspaceId,
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
      // Recovered-video poster, served through the same auth-redirect path as
      // the main media URL.
      ...(thumbKey ? { thumbnailUrl: `/api/media/${row.id}/thumb` } : {}),
    },
  });
}

/**
 * The blob-storage mime allowlist + magic-byte guard throw a plain Error whose
 * message is prefixed `blob-storage:` (mime-guard.ts). Unlike a Meta-CDN / R2
 * blip these are DETERMINISTIC — the same bytes fail the same gate on every
 * re-download — so a parked row must be CLEARED to text-only rather than
 * re-fetched hourly for the full 24h horizon. The guard runs synchronously
 * BEFORE any network I/O inside `upload()`, so this only ever matches the mime
 * gate, never a transient upload failure. (A typed `MediaValidationError` in
 * mime-guard would be cleaner than matching the message — see needsCoordination.)
 */
function isDeterministicMediaRejection(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("blob-storage:");
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
    workspaceId: row.workspaceId,
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
