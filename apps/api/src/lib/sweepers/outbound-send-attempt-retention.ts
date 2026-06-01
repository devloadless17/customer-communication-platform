import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Retention sweeper for OutboundSendAttempt rows. The model is bookkeeping
 * for the BEFORE-Meta-call idempotency check in two places:
 *   - `MessagesService.executeTextSendJob` (jobId `msg-send-*`) — once a job is
 *     past BullMQ's `removeOnFail` window (7 days) there can be no more retries
 *     using the same jobId, so the row's "block double-send" purpose is moot.
 *   - the broadcast runner's per-recipient guard (jobId `bc-recipient-*`,
 *     added 2026-05-22) — completed rows are reconcile breadcrumbs; the rare
 *     stuck/incomplete row (crash mid-send) is GC'd here after 7 days too.
 *
 * Without cleanup, the table grows monotonically (1 row per outbound text
 * send per attempt × team × forever). At pilot scale that's slow, but the
 * growth is unbounded so a sweeper is the right shape.
 *
 * Retention window: 7 days. Matches send-queue's `removeOnFail: { age:
 * 24h * 7 }` so a row we delete here is guaranteed to have no
 * corresponding BullMQ job left to retry. Bumping this only changes
 * disk usage; it never affects correctness.
 *
 * Cadence: 24h. Cheap — one indexed DELETE.
 */
const RETENTION_DAYS = 7;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Initial delay so the sweeper doesn't compete with boot-time work on the
// DB. 10min is long enough that migrations + boot reconcilers have all
// settled.
const INITIAL_DELAY_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Mutex serializes the indexed DELETE against other heavy sweepers.
    await withSweeperMutex("outbound-send-attempt-retention", sweepOnce);
  } catch (err) {
    console.error(`[sweeper.outbound-send-attempt] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startOutboundSendAttemptRetentionSweeper(): void {
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

export function stopOutboundSendAttemptRetentionSweeper(): void {
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
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  // Drop both terminal-state rows (completed or failed) AND stuck rows
  // (attempted but never marked either way) past the retention window.
  // Stuck rows past 7 days are functionally identical to dropped rows —
  // BullMQ's removeOnFail (7d) has GC'd the corresponding job, so the
  // attempt can never be retried.
  const result = await db.outboundSendAttempt.deleteMany({
    where: {
      attemptStartedAt: { lt: cutoff },
    },
  });
  if (result.count > 0) {
    console.warn(
      `[sweeper.outbound-send-attempt] pruned ${result.count} row(s) older than ${RETENTION_DAYS} days`,
    );
  }
}
