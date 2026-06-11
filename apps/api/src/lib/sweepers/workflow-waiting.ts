import { db } from "@/lib/db";
import {
  clearTerminalJob,
  enqueueWorkflowResume,
  enqueueWorkflowRun,
} from "@/lib/workflows/queue";

/**
 * Periodic sweeper that recovers stranded workflow runs whose BullMQ job
 * is missing. Covers TWO statuses:
 *
 *   - `waiting` runs whose scheduled resume job is missing. Two ways
 *     they strand:
 *       1. Process death between `WorkflowRun.update(status: "waiting")`
 *          and `enqueueWorkflowResume()` in the runner.
 *       2. Redis eviction / restart without persistence.
 *
 *   - `queued` runs whose initial run job is missing. The dispatcher
 *     creates the row inside a tx (commits immediately) and THEN calls
 *     `enqueueWorkflowRun` with a retry-with-backoff. A Redis stall
 *     longer than the retry budget (5s+ tail) leaves the row at
 *     `queued` with no BullMQ job — invisible to BullMQ, invisible to
 *     the original `waiting`-only sweep query, invisible to operators.
 *     This is the same crash-window class as the waiting case.
 *
 * Without this sweep, a stranded run sits forever with no visibility.
 * The runs UI shows the row but nothing happens.
 *
 * The sweep is idempotent — re-enqueueing a run whose job is STILL LIVE
 * (waiting / delayed / active) is a BullMQ no-op (custom jobId dedupe). The
 * sweeper passes the run's current stepLog.length as `waitSeq` so the computed
 * jobId matches what the runner used.
 *
 * BUT a deterministic jobId also dedupes against a RETAINED-terminal job:
 * `removeOnFail` keeps a failed job for 7 days (queue.ts), so a run whose job
 * failed its full retry budget (e.g. a DB outage spanning all 3 backoff
 * attempts) would have its recovery silently no-op'd for up to 7 days — the
 * sweeper reporting success while the run stays stranded. So before each
 * re-enqueue we `clearTerminalJob(jobId)`: it removes a failed/completed hash
 * (leaving a live job untouched) so the re-add actually re-creates the job.
 *
 * Interval: 60s. Short enough to recover quickly, long enough that the
 * tight (status, waitUntil) index makes the query trivial.
 */

const SWEEP_INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
// In-flight guard: a slow sweep (long DB query / re-enqueue tail) MUST NOT
// overlap with the next interval tick. BullMQ deduplicates by jobId so a
// double-enqueue is silently safe today, but the protection is implicit —
// the moment a sweeper grows extra side effects, overlapping ticks become
// a correctness hazard. Cheap explicit flag, no race on Node's single-
// threaded event loop.
let inFlight = false;

export function startWorkflowWaitingSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    sweepOnce()
      .catch((err) => {
        console.warn(
          "[workflow-waiting-sweeper] iteration failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        inFlight = false;
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
  const strandedWaiting = await db.workflowRun.findMany({
    where: {
      status: "waiting",
      waitUntil: { lte: cutoff },
    },
    select: { id: true, waitUntil: true, stepLog: true },
    take: 100, // bounded per tick — protects against thundering recovery
  });

  // `queued` rows older than the grace window are stranded — the dispatcher
  // commits the row first, then enqueues with up to 5s of retry; anything
  // past 30s without a worker pickup means BullMQ never got the job. The
  // worker's `claimRun` updates status to `running` on pickup, so the
  // sweeper here only sees rows that genuinely never started.
  const strandedQueued = await db.workflowRun.findMany({
    where: {
      status: "queued",
      // WorkflowRun uses `startedAt` (not `createdAt`) as its insertion
      // timestamp — see schema.prisma. Filter on that.
      startedAt: { lte: cutoff },
    },
    select: { id: true },
    take: 100,
  });

  if (strandedWaiting.length === 0 && strandedQueued.length === 0) return;

  const nowMs = now.getTime();
  for (const run of strandedWaiting) {
    // Recompute the remaining delay from waitUntil rather than always
    // passing 0. Two reasons:
    //   1. Defensive: if the 30s grace cutoff is ever tightened, or if the
    //      sweeper picks up a row whose waitUntil is somehow still in the
    //      future, delay:0 would wake a 1-hour wait instantly.
    //   2. The BullMQ jobId-based dedupe (resume-${runId}-${waitSeq})
    //      collapses any pre-existing delayed job — but if the runner's
    //      own enqueue is racing us with a longer delay AND the runner
    //      wins the race, we don't want the sweeper's delay:0 job to
    //      have won the slot. Math.max(0, …) preserves "fire now if
    //      overdue" semantics for the common case while keeping the
    //      future-delay case correct.
    // Non-null: the WHERE clause filters waitUntil <= cutoff, which excludes
    // NULLs in Postgres — Prisma's projected type doesn't carry that fact.
    const delayMs = Math.max(0, run.waitUntil!.getTime() - nowMs);
    // stepLog.length matches the value the runner used at scheduling time
    // (the runner pushes the "waiting" entry, persists, then enqueues).
    const waitSeq = Array.isArray(run.stepLog) ? run.stepLog.length : 0;
    try {
      // Clear a retained-terminal (failed/completed) job with this id first,
      // else the re-add below is a silent dedupe no-op and the run stays
      // stranded for the 7-day removeOnFail window. Live jobs are untouched.
      const cleared = await clearTerminalJob(`resume-${run.id}-${waitSeq}`);
      if (cleared) {
        console.warn(
          `[workflow-waiting-sweeper] cleared terminal resume job for run=${run.id} (waitSeq=${waitSeq}) before re-enqueue`,
        );
      }
      await enqueueWorkflowResume(run.id, delayMs, waitSeq);
    } catch (err) {
      console.warn(
        `[workflow-waiting-sweeper] re-enqueue failed for run=${run.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  for (const run of strandedQueued) {
    // jobId is `run-${runId}` (see queue.ts) — same dedupe as the dispatcher,
    // so this is a no-op if the dispatcher's late-retry happens to win. Clear
    // a retained-terminal job first for the same reason as the waiting loop:
    // a `run-${runId}` job that failed its retry budget would otherwise block
    // recovery for the 7-day removeOnFail window.
    try {
      const cleared = await clearTerminalJob(`run-${run.id}`);
      if (cleared) {
        console.warn(
          `[workflow-waiting-sweeper] cleared terminal run job for run=${run.id} before re-enqueue`,
        );
      }
      await enqueueWorkflowRun(run.id);
    } catch (err) {
      console.warn(
        `[workflow-waiting-sweeper] queued re-enqueue failed for run=${run.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Log on non-empty sweeps so an operator can spot a pattern. Quiet
  // when there's nothing to do.
  if (strandedWaiting.length > 0) {
    console.warn(
      `[workflow-waiting-sweeper] re-enqueued ${strandedWaiting.length} stranded waiting run(s)`,
    );
  }
  if (strandedQueued.length > 0) {
    console.warn(
      `[workflow-waiting-sweeper] re-enqueued ${strandedQueued.length} stranded queued run(s)`,
    );
  }
}
