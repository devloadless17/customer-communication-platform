import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Housekeeping for contact import/export jobs. Two independent duties:
 *
 * 1. EXPIRY. A contact export is a bulk PII dump — the whole address book in
 *    one downloadable file. Leaving those in the bucket forever turns a single
 *    leaked presigned URL, or a stale bucket ACL, into a full contact-book
 *    breach months after the fact. Artifacts (and the uploaded source files,
 *    which are the same data) are deleted at `expiresAt`, and the job row goes
 *    with them so the history doesn't advertise downloads that 404.
 *
 * 2. STALE RUNS. A worker killed mid-run (deploy, OOM, SIGKILL) leaves a
 *    `running` row that would otherwise sit at 47% forever. A heartbeat older
 *    than the stall threshold means nobody is working on it, so it's failed
 *    with an honest message. BullMQ's own stalled-job handling may also retry
 *    it; the runner's resume cursor makes that safe either way.
 *
 * Guarded by the shared sweeper mutex so a second app instance (a named §16
 * scaling cliff) can't double-delete.
 */

const SWEEP_INTERVAL_MS = 15 * 60_000;
const INITIAL_DELAY_MS = 90_000;

/**
 * A run whose heartbeat is older than this is presumed dead. The worker
 * heartbeats every progress flush (~2s) and a batch is bounded, so 15 minutes
 * of silence is far outside normal operation even for a slow 100k import.
 */
const STALL_MS = 15 * 60_000;

/**
 * A staged upload older than this with no job pointing at it is abandoned.
 * Generous: a user can legitimately sit on the mapping step for a long time
 * (checking a column against their CRM), and deleting the file under them turns
 * "Import" into an unexplained failure.
 */
const ABANDONED_UPLOAD_MS = 6 * 3600_000;

/** Rows per pass — bounded so a backlog can't turn one tick into a long
 *  transaction; the next tick picks up the rest. */
const BATCH = 200;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function sweepOnce(): Promise<void> {
  await failStalledRuns();
  await reapExpired();
  await reapAbandonedUploads();
}

/**
 * Reclaim staged import files whose wizard was abandoned.
 *
 * `POST /contacts/import/preview` uploads the file to
 * `contact-imports/<workspaceId>/staged-<uuid>.<ext>` so the RUN call doesn't have
 * to re-upload it. If the user closes the dialog at the mapping step, no
 * ContactTransferJob row is ever created — so `reapExpired` (which walks job
 * rows) never sees it, and the generic blob-orphan sweeper deliberately skips
 * this whole prefix because THIS sweeper owns the category. Without this pass
 * an abandoned 50 MB upload would sit in the bucket forever.
 *
 * Cross-checked against `sourceKey` before deleting: a file staged minutes ago
 * and imported seconds ago must not be pulled out from under a running job.
 */
/**
 * Provider cursor carried ACROSS ticks, exactly like the blob-orphan sweeper.
 *
 * Without it this listed the same first `BATCH` keys forever: `listKeys` is
 * S3 `ListObjectsV2`, which returns keys in lexicographic order and honours
 * `MaxKeys`. The `contact-imports/` prefix holds BOTH `staged-<uuid>` uploads
 * and `<jobId>-errors.<fmt>` reports (which live until their job's 7-day
 * expiry), so a tenant whose workspace cuid sorts early and which runs a
 * dozen imports a day pins the window permanently — after which no other
 * workspace's abandoned upload, at up to 50 MB each, is ever reclaimed.
 *
 * This is the identical bug blob-orphan.ts documents having fixed for itself
 * ("each weekly tick would rescan the same first 2000 lexicographic keys and
 * never reclaim a leak sorting after them"). Same remedy.
 */
let resumeCursor: string | undefined;

async function reapAbandonedUploads(): Promise<void> {
  if (!blobStorage.listKeys) return; // provider can't enumerate — nothing to do

  const cutoff = Date.now() - ABANDONED_UPLOAD_MS;
  const { keys, nextCursor } = await blobStorage.listKeys({
    limit: BATCH,
    prefix: "contact-imports/",
    ...(resumeCursor ? { cursor: resumeCursor } : {}),
  });
  // Advance (or wrap to the start when the listing is exhausted) BEFORE any
  // early return below, so a page with no candidates still moves the window.
  resumeCursor = nextCursor;

  // Only `staged-` objects: the `-errors.` reports are job-owned and reaped
  // with their row.
  const candidates = keys
    .filter((k) => k.key.includes("/staged-") && k.uploadedAt > 0 && k.uploadedAt < cutoff)
    .map((k) => k.key);
  if (candidates.length === 0) return;

  const referenced = await db.contactTransferJob.findMany({
    where: { sourceKey: { in: candidates } },
    select: { sourceKey: true },
  });
  const inUse = new Set(referenced.map((r) => r.sourceKey));
  const orphans = candidates.filter((k) => !inUse.has(k));
  if (orphans.length === 0) return;

  // `delete` never throws — it REPORTS the keys it couldn't remove, so the log
  // says what actually happened instead of always claiming success.
  const failed = await blobStorage.delete(orphans);
  const reclaimed = orphans.length - failed.length;
  if (reclaimed > 0) {
    console.warn(`[sweeper.contact-transfer] reclaimed ${reclaimed} abandoned upload(s)`);
  }
  if (failed.length > 0) {
    console.error(
      `[sweeper.contact-transfer] ${failed.length} abandoned upload(s) survived deletion — retrying next tick`,
    );
  }
}

async function failStalledRuns(): Promise<void> {
  const cutoff = new Date(Date.now() - STALL_MS);
  const res = await db.contactTransferJob.updateMany({
    where: {
      status: "running",
      // A row that somehow never heartbeat at all is judged on startedAt.
      OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }],
    },
    data: {
      status: "failed",
      // `ContactTransferJob.error` is a COLUMN the UI renders verbatim, not an
      // HTTP error envelope — so the sentence belongs here, not a key. (The
      // batch-F normalization script mistook it for an envelope and added a
      // `detail` field the model doesn't have; check:prisma-fields caught it,
      // which is precisely the runtime-only class that checker exists for.)
      // error-key-checker: column-not-envelope
      error:
        "The transfer stopped unexpectedly. Its progress was saved — start it again to continue.",
      finishedAt: new Date(),
    },
  });
  if (res.count > 0) {
    console.warn(`[sweeper.contact-transfer] failed ${res.count} stalled job(s)`);
  }
}

async function reapExpired(): Promise<void> {
  const rows = await db.contactTransferJob.findMany({
    where: { expiresAt: { lt: new Date() } },
    select: { id: true, sourceKey: true, artifactKey: true, errorArtifactKey: true },
    take: BATCH,
  });
  if (rows.length === 0) return;

  const perRow = rows.map((r) => ({
    id: r.id,
    keys: [r.sourceKey, r.artifactKey, r.errorArtifactKey].filter(
      (k): k is string => Boolean(k),
    ),
  }));
  const keys = perRow.flatMap((r) => r.keys);

  // Delete the objects BEFORE the rows, and drop ONLY the rows whose objects
  // are confirmed gone. `blobStorage.delete` never throws — it returns the keys
  // it could not remove — so that list is the ONLY signal an object survived.
  // Deleting the row anyway strands a full contact-book export in the bucket
  // with nothing pointing at it: blob-orphan deliberately prefix-excludes
  // `contact-exports/`+`contact-imports/` because THIS sweeper owns them, and
  // reapAbandonedUploads only matches `staged-` keys. The rest wait for the
  // next tick.
  const failed = keys.length > 0 ? new Set(await blobStorage.delete(keys)) : new Set<string>();

  const reapable = perRow.filter((r) => r.keys.every((k) => !failed.has(k)));
  if (failed.size > 0) {
    console.error(
      `[sweeper.contact-transfer] ${failed.size} artifact(s) survived deletion — keeping ${
        perRow.length - reapable.length
      } job row(s) for the next tick`,
    );
  }
  if (reapable.length === 0) return;

  await db.contactTransferJob.deleteMany({ where: { id: { in: reapable.map((r) => r.id) } } });
}

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("contact-transfer-artifacts", sweepOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopContactTransferSweeper();
      return;
    }
    console.error(`[sweeper.contact-transfer] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startContactTransferSweeper(): void {
  if (timer || initialTimer) return;
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

export function stopContactTransferSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
