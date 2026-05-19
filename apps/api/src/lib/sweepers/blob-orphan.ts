import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";

/**
 * Reclaim orphan blobs at the provider (UploadThing today).
 *
 * Leak vectors:
 *   1. `blobStorage.delete()` is intentionally non-throwing (uploadthing.ts:88-98)
 *      so a transient provider outage during a contact/conversation/team delete
 *      drops the blob from the DB but leaves the file on the provider's
 *      storage. We log the failure but don't queue a retry.
 *   2. A crash between the `blobStorage.upload()` return and the DB row write
 *      for the message — the file is on UploadThing with no Message row
 *      pointing to it.
 *
 * Strategy: page through provider files, cross-check each batch against
 * Message.mediaKey + TeamChannelMessage.mediaKey, delete files older than a
 * grace window whose keys appear in neither table.
 *
 * Grace window: 24h. Long enough that an in-flight upload (between
 * provider-side commit and our DB write) isn't mistaken for an orphan. Short
 * enough that a real leak is reclaimed within a day.
 *
 * Cadence: weekly. The leak rate is "outage-driven, not steady" — daily
 * sweeps would mostly find nothing while paying for a full provider list scan.
 * Override via BLOB_ORPHAN_SWEEP_INTERVAL_MS if a customer needs faster
 * reclaim.
 *
 * Per-tick budget: scan at most 4 pages × 500 keys = 2000 keys. Provider
 * pagination tokens aren't durable across ticks; if the provider has more
 * than this we walk further next week. At pilot scale (1 tenant, low media
 * volume) the whole bucket fits in one page.
 *
 * Safety: if `blobStorage.listKeys` is undefined (provider doesn't expose
 * enumeration), the sweeper logs once and stays disabled. No false-positive
 * deletes from a half-implemented provider.
 */

const SWEEP_INTERVAL_MS = (() => {
  const raw = Number.parseInt(process.env.BLOB_ORPHAN_SWEEP_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 60 * 60 * 1000 ? raw : 7 * 24 * 60 * 60 * 1000;
})();
const INITIAL_DELAY_MS = 30 * 60 * 1000; // 30min after boot — let the other sweepers finish their initial passes first
const GRACE_MS = 24 * 60 * 60 * 1000; // ignore blobs uploaded in the last 24h
const PAGE_SIZE = 500;
const MAX_PAGES_PER_TICK = 4;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;
let listKeysUnsupportedLogged = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await sweepOnce();
  } catch (err) {
    console.error(`[sweeper.blob-orphan] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startBlobOrphanSweeper(): void {
  if (timer || initialTimer) return;
  if (!blobStorage.listKeys) {
    if (!listKeysUnsupportedLogged) {
      listKeysUnsupportedLogged = true;
      console.warn(
        `[sweeper.blob-orphan] provider "${blobStorage.name}" doesn't expose listKeys — orphan sweeper disabled`,
      );
    }
    return;
  }
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runTick("initial sweep");
    timer = setInterval(() => {
      void runTick("sweep");
    }, SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
}

export function stopBlobOrphanSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  if (!blobStorage.listKeys) return;

  const ageCutoffMs = Date.now() - GRACE_MS;
  const orphanKeys: string[] = [];
  let offset = 0;
  let scannedCount = 0;

  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const { keys, hasMore } = await blobStorage.listKeys({
      limit: PAGE_SIZE,
      offset,
    });
    if (keys.length === 0) break;
    scannedCount += keys.length;

    // Only consider blobs older than the grace window. Recent uploads might
    // still be racing the DB row write.
    const eligible = keys.filter((k) => k.uploadedAt < ageCutoffMs);
    if (eligible.length > 0) {
      const eligibleKeyList = eligible.map((k) => k.key);
      // Cross-check both customer-message media AND team-chat-message media.
      // Both tables store the UploadThing fileKey in `mediaKey`.
      const [msgHits, chatHits] = await Promise.all([
        db.message.findMany({
          where: { mediaKey: { in: eligibleKeyList } },
          select: { mediaKey: true },
        }),
        db.teamChannelMessage.findMany({
          where: { mediaKey: { in: eligibleKeyList } },
          select: { mediaKey: true },
        }),
      ]);
      const referenced = new Set<string>([
        ...msgHits.map((m) => m.mediaKey!).filter(Boolean),
        ...chatHits.map((m) => m.mediaKey!).filter(Boolean),
      ]);
      for (const k of eligible) {
        if (!referenced.has(k.key)) orphanKeys.push(k.key);
      }
    }

    if (!hasMore) break;
    offset += PAGE_SIZE;
  }

  if (orphanKeys.length === 0) {
    // Quiet on no-finds — daily noise from a healthy system isn't useful.
    return;
  }

  // Hand off to the provider's delete; failures are swallowed inside, so we
  // log here for visibility regardless.
  await blobStorage.delete(orphanKeys);
  console.warn(
    `[sweeper.blob-orphan] reclaimed ${orphanKeys.length} orphan blob(s) ` +
      `(scanned ${scannedCount})`,
  );
}
