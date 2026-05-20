import { db } from "@/lib/db";

/**
 * Periodic sweeper that cleans up stale `WorkflowAwaitingReply` rows. The
 * ask_question step deletes its row on resume (both answered + timeout
 * paths converge there), so under normal operation this sweeper has nothing
 * to do. It exists for the edge cases:
 *
 *   1. The workflow was disabled / deleted between the ask_question step
 *      pausing and the timeout firing → the runner short-circuits with
 *      `markSkipped` and never re-enters the step, so the awaiting row
 *      lingers.
 *   2. The timeout resume job + the timeout sweep both lost their handle
 *      on the run (unlikely but possible if Redis dropped the job AND the
 *      workflow-waiting sweeper raced a workflow-disable).
 *   3. Manual DB intervention.
 *
 * `cleanupAfterMs` is a grace window past `expiresAt` so a tight race
 * between the runner's resume + this sweep can't delete a row the runner
 * is about to consume. 2× the timeout grace used by workflow-waiting
 * (30s) gives 60s of headroom — more than enough for a normal resume.
 *
 * Sweep interval: 1 hour. The row count is tiny in practice (one per
 * paused ask_question step) and the cleanup is purely housekeeping.
 */

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h
const CLEANUP_GRACE_MS = 60 * 1000; // 60s past expiresAt before deleting

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startWorkflowAwaitingReplySweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    sweepOnce()
      .catch((err) => {
        console.warn(
          "[workflow-awaiting-reply-sweeper] iteration failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        inFlight = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopWorkflowAwaitingReplySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - CLEANUP_GRACE_MS);
  const result = await db.workflowAwaitingReply.deleteMany({
    where: { expiresAt: { lte: cutoff } },
  });
  if (result.count > 0) {
    console.warn(
      `[workflow-awaiting-reply-sweeper] cleaned ${result.count} stale row(s)`,
    );
  }
}
