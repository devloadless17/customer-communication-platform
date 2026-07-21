import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

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

/** Rows per pass — bounded so a backlog can't turn one tick into a long
 *  transaction; the next tick picks up the rest. */
const BATCH = 200;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function sweepOnce(): Promise<void> {
  await failStalledRuns();
  await reapExpired();
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
      error: "The transfer stopped unexpectedly. Its progress was saved — start it again to continue.",
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

  const keys = rows
    .flatMap((r) => [r.sourceKey, r.artifactKey, r.errorArtifactKey])
    .filter((k): k is string => Boolean(k));

  if (keys.length > 0) {
    // Delete the objects BEFORE the rows. If this throws, the rows survive and
    // the next tick retries — the opposite order would orphan the objects with
    // nothing left pointing at them, which is exactly what the blob-orphan
    // sweeper exists to clean up and what we'd rather not create.
    try {
      await blobStorage.delete(keys);
    } catch (err) {
      console.error("[sweeper.contact-transfer] artifact delete failed", err);
      return;
    }
  }

  await db.contactTransferJob.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
}

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("contact-transfer-artifacts", sweepOnce);
  } catch (err) {
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
