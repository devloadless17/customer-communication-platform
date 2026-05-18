import { db } from "@/lib/db";
import { enqueueWorkflowResume } from "@/lib/workflows/queue";

/**
 * Periodic sweeper that recovers `waiting` workflow runs whose scheduled
 * resume job is missing. Two ways a run gets stranded:
 *
 *   1. Process death between the `WorkflowRun.update(status: "waiting")`
 *      and `enqueueWorkflowResume()` calls in the runner — DB says
 *      waiting, BullMQ has nothing.
 *   2. Redis eviction / restart without persistence — BullMQ delayed jobs
 *      were in Redis, Redis got reset, the rows are still `waiting`.
 *
 * Without this sweeper, a stranded run sits in `waiting` forever with no
 * visibility. The runs UI shows "resumes in …" but the timestamp keeps
 * sliding into the past with nothing happening.
 *
 * The sweep is idempotent — re-enqueueing a run whose job already exists
 * is fine; BullMQ deduplicates by jobId in `addBulk` semantics, and
 * `enqueueWorkflowResume` uses `runId` as the jobId so duplicates are
 * collapsed.
 *
 * Interval: 60s. Short enough to recover quickly, long enough that a
 * tight schema_index on (status, waitUntil) makes the query trivial.
 */

const SWEEP_INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;

export function startWorkflowWaitingSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    sweepOnce().catch((err) => {
      console.warn(
        "[workflow-waiting-sweeper] iteration failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopWorkflowWaitingSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const now = new Date();
  // Look back a short grace window so a freshly-stamped wait that's about
  // to be enqueued isn't double-scheduled by us racing the runner's own
  // enqueue. Anything older than 30s without a resume firing is stuck.
  const cutoff = new Date(now.getTime() - 30_000);
  const stranded = await db.workflowRun.findMany({
    where: {
      status: "waiting",
      waitUntil: { lte: cutoff },
    },
    select: { id: true, waitUntil: true },
    take: 100, // bounded per tick — protects against thundering recovery
  });
  if (stranded.length === 0) return;

  for (const run of stranded) {
    // Delay 0 → resume now. The job-id-based dedupe inside
    // enqueueWorkflowResume collapses duplicates.
    try {
      await enqueueWorkflowResume(run.id, 0);
    } catch (err) {
      console.warn(
        `[workflow-waiting-sweeper] re-enqueue failed for run=${run.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  // Log on non-empty sweeps so an operator can spot a pattern. Quiet
  // when there's nothing to do.
  console.warn(
    `[workflow-waiting-sweeper] re-enqueued ${stranded.length} stranded waiting run(s)`,
  );
}
