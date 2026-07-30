import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Reclaim orphan blobs at the provider (Cloudflare R2).
 *
 * Leak vectors:
 *   1. `blobStorage.delete()` is intentionally non-throwing (r2.ts) so a
 *      transient provider outage during a contact/conversation/team delete
 *      drops the blob from the DB but leaves the object in the bucket. We log
 *      the failure but don't queue a retry.
 *   2. A crash between the `blobStorage.upload()` return and the DB row write
 *      for the message — the object is in R2 with no Message row pointing to it.
 *
 * Strategy: page through provider files, cross-check each batch against every
 * column that persists an object key (Message.mediaKey / .mediaThumbnailKey,
 * TeamChannelMessage.mediaKey, Call.recordingKey / .transcriptKey), delete
 * files older than a grace window whose keys appear in none of them.
 *
 * URL-only blobs are EXCLUDED. Avatars store only `User.avatarUrl` (no
 * `mediaKey`), so a naive "delete unless in a mediaKey column" scan would
 * falsely orphan and permanently delete every avatar. They live under the
 * `avatars/` key prefix — see `isUrlOnlyBlob` — which we skip before the
 * cross-check. Any future blob category that stores only a URL must add its
 * key prefix there.
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
 * Per-tick budget: scan at most 4 pages × 500 keys = 2000 keys. When a tick
 * exhausts that budget with the listing still truncated, we persist the
 * provider cursor in `resumeCursor` (module-level) and the next tick continues
 * where this one stopped, wrapping back to the start once the listing is fully
 * walked. Without this each weekly tick would rescan the same first 2000
 * lexicographic keys and never reclaim a leak sorting after them. At pilot
 * scale (1 tenant, low media volume) the whole bucket fits in one page.
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

// Blob categories that persist only a URL (no `mediaKey` to cross-check), keyed
// by their object-key prefix. These must be skipped by the orphan scan or
// they'd be deleted as false orphans. Avatars (lib/blob-storage/avatar.ts) live
// under `avatars/`.
//
// `ai-knowledge/` and `ai-voice-draft/` are here for the SAME reason and were
// missing, which made this sweeper permanently DESTROY customer data rather
// than merely leak storage:
//   - `ai-knowledge/{workspaceId}/{uuid}` (team/ai-assistant/ai-knowledge.service.ts)
//     is referenced ONLY by `AiContextDocument.r2Key`.
//   - `ai-voice-draft/{workspaceId}/{messageId}.mp3` (lib/ai/voice-delivery.ts) is
//     referenced ONLY by the AI suggestion's `audioR2Key`.
// `listKeys` walks the WHOLE bucket with no prefix filter, and the cross-check
// below queries only Message.mediaKey / Message.mediaThumbnailKey /
// TeamChannelMessage.mediaKey — so once past the grace window both categories
// were classified as orphans and deleted, leaving the DB row pointing at a dead
// key. For a knowledge doc that is the customer's uploaded source file, gone,
// with `reprocess` throwing BlobObjectNotFoundError forever after.
//
// Excluding by prefix is the FAIL-SAFE choice and deliberate: the worst case is
// unreclaimed storage, whereas a cross-check with a wrong column name deletes
// data on the next weekly tick. Reclaiming these two categories properly means
// adding their own cross-checks (`AiContextDocument.r2Key` and the suggestion's
// `audioR2Key`) alongside the three below — worth doing, but not at the price
// of risking the destructive direction to get there.
// (`ai-voice/` — the SENT voice note — needs no entry: send-media-internal
// stores it on `Message.mediaKey`, so the existing cross-check covers it.)
//
// `contact-exports/` and `contact-imports/` are here for the same reason, and
// unlike the two above there is NO storage leak in excluding them: that
// category owns its own lifecycle. Every object is referenced by a
// `ContactTransferJob` row (`artifactKey` / `sourceKey` / `errorArtifactKey`)
// which this cross-check doesn't query, and the dedicated
// `contact-transfer-artifacts` sweeper deletes both the objects and the rows at
// their 7-day `expiresAt`. Without this entry, a user's export would be
// destroyed by THIS sweeper after the 24h grace window while its job row still
// advertised a working download — the third instance of exactly the failure
// this comment block already documents twice.
const URL_ONLY_KEY_PREFIXES = [
  "avatars/",
  "ai-knowledge/",
  "ai-voice-draft/",
  "contact-exports/",
  "contact-imports/",
] as const;
// URL-only categories that DON'T have a distinguishing key prefix. Template
// header media (messages.service.ts `uploadTemplateHeaderMedia`) lives under the
// shared `media/` prefix, but its stable URL is the only persisted reference —
// it's stored in workflow `send_template` step config, Broadcast variables, and
// Message.rawPayload, never in a `mediaKey` column — so the cross-check below
// would classify every one as an orphan and permanently delete it, silently
// breaking all media-header automations. Its key segment is
// `sanitizeSeg('tpl-hdr-<uuid>')`, so the `/tpl-hdr-` marker is stable.
const URL_ONLY_KEY_MARKERS = ["/tpl-hdr-"] as const;
// NOTE: video poster thumbnails (key `...-video.jpg` under `media/`, stored on
// Message.mediaThumbnailKey) are NOT excluded here — they ARE db-keyed, so the
// exact `mediaThumbnailKey` cross-check below folds every REFERENCED poster
// into `referenced`. That protects live posters while still letting a
// genuinely-orphaned poster (parent row gone) be reclaimed — a blanket
// exclusion would leak those forever.
function isUrlOnlyBlob(key: string): boolean {
  return (
    URL_ONLY_KEY_PREFIXES.some((p) => key.startsWith(p)) ||
    URL_ONLY_KEY_MARKERS.some((m) => key.includes(m))
  );
}

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;
let listKeysUnsupportedLogged = false;
// Provider cursor carried across ticks so a bucket larger than the per-tick
// page budget is walked incrementally instead of rescanning the first 2000
// keys every week. `undefined` = start from the beginning of the listing.
let resumeCursor: string | undefined;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Mutex serializes the multi-page provider-list scan against other
    // heavy sweepers. Health log warns if last completion >8d.
    await withSweeperMutex("blob-orphan", sweepOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopBlobOrphanSweeper();
      return;
    }
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

/** Exported for the spec — same convention as `sweepMessageFlagCountsOnce`.
 *  This sweeper's failure mode is PERMANENT DELETION of referenced customer
 *  data, so the cross-check needs to be assertable directly rather than only
 *  through the weekly timer. */
export async function sweepBlobOrphansOnce(): Promise<void> {
  return sweepOnce();
}

async function sweepOnce(): Promise<void> {
  if (!blobStorage.listKeys) return;

  const ageCutoffMs = Date.now() - GRACE_MS;
  const orphanKeys: string[] = [];
  // Resume where the previous tick stopped; wrap to the start once exhausted.
  let cursor: string | undefined = resumeCursor;
  let nextResumeCursor: string | undefined;
  let scannedCount = 0;

  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const { keys, nextCursor } = await blobStorage.listKeys({
      limit: PAGE_SIZE,
      cursor,
    });
    // Empty page = listing exhausted (or a stale cursor past the end); wrap.
    if (keys.length === 0) {
      nextResumeCursor = undefined;
      break;
    }
    scannedCount += keys.length;
    // Track the cursor to persist: if we exit the loop with this still set the
    // listing was truncated at the budget and the next tick continues from here.
    nextResumeCursor = nextCursor;

    // Only consider blobs older than the grace window. Recent uploads might
    // still be racing the DB row write. Also exclude URL-only blob categories
    // (avatars) — they persist no `mediaKey`, so the cross-check below would
    // classify every one as an orphan and permanently delete it.
    const eligible = keys.filter(
      (k) => k.uploadedAt < ageCutoffMs && !isUrlOnlyBlob(k.key),
    );
    if (eligible.length > 0) {
      const eligibleKeyList = eligible.map((k) => k.key);
      // Cross-check both customer-message media AND team-chat-message media.
      // Both tables store the R2 object key in `mediaKey`. ALSO cross-
      // check Message.mediaThumbnailKey — video poster frames are stored on a
      // separate key there, not in `mediaKey`, so without this a referenced
      // poster thumbnail would be classified an orphan and deleted.
      const [msgHits, thumbHits, chatHits, recordingHits, transcriptHits, ticketHits] =
        await Promise.all([
          db.message.findMany({
            where: { mediaKey: { in: eligibleKeyList } },
            select: { mediaKey: true },
          }),
          db.message.findMany({
            where: { mediaThumbnailKey: { in: eligibleKeyList } },
            select: { mediaThumbnailKey: true },
          }),
          db.teamChannelMessage.findMany({
            where: { mediaKey: { in: eligibleKeyList } },
            select: { mediaKey: true },
          }),
          // CALL ARTIFACTS. `call-recordings/{ws}/{callId}.ogg` and
          // `call-transcripts/{ws}/{callId}.json` are referenced ONLY by
          // Call.recordingKey / Call.transcriptKey. Without these two queries
          // every one of them was classified an orphan 24h after the call and
          // permanently deleted while the Call row still advertised it — and
          // unlike a leaked blob that is UNRECOVERABLE: Meta deletes its own
          // copy 7 days after the webhook, so R2 holds the only one. That is
          // the fourth instance of the exact failure the comment block above
          // already documents three times.
          //
          // Cross-checked rather than prefix-excluded BECAUSE the columns
          // exist: exclusion would protect live artifacts but leak every
          // genuinely orphaned one forever (a workspace delete drops the Call
          // rows and nothing else collects these keys). Same reasoning as the
          // `mediaThumbnailKey` check above.
          db.call.findMany({
            where: { recordingKey: { in: eligibleKeyList } },
            select: { recordingKey: true },
          }),
          db.call.findMany({
            where: { transcriptKey: { in: eligibleKeyList } },
            select: { transcriptKey: true },
          }),
          // TICKET ATTACHMENTS. `media/{ws}/…-tkt-…` keys are referenced ONLY
          // by TicketAttachment.blobKey. Registered here the moment the table
          // was added, for the reason the block above documents four times: a
          // new blob-owning table that skips this cross-check has its LIVE
          // files deleted 24h later, and a customer's uploaded evidence is not
          // recoverable from anywhere else.
          db.ticketAttachment.findMany({
            where: { blobKey: { in: eligibleKeyList } },
            select: { blobKey: true },
          }),
        ]);
      const referenced = new Set<string>([
        ...msgHits.map((m) => m.mediaKey!).filter(Boolean),
        ...thumbHits.map((m) => m.mediaThumbnailKey!).filter(Boolean),
        ...chatHits.map((m) => m.mediaKey!).filter(Boolean),
        ...recordingHits.map((c) => c.recordingKey!).filter(Boolean),
        ...transcriptHits.map((c) => c.transcriptKey!).filter(Boolean),
        ...ticketHits.map((a) => a.blobKey).filter(Boolean),
      ]);
      for (const k of eligible) {
        if (!referenced.has(k.key)) orphanKeys.push(k.key);
      }
    }

    if (!nextCursor) break;
    cursor = nextCursor;
  }

  // Persist for the next tick: a set cursor continues the walk, `undefined`
  // (listing exhausted this tick) wraps back to the start of the bucket.
  resumeCursor = nextResumeCursor;

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
