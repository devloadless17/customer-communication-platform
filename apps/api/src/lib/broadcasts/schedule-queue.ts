// BullMQ wiring for SCHEDULED broadcasts. A broadcast created with a future
// `scheduledAt` gets one delayed job here; when it fires, the worker flips the
// row `scheduled` → `queued` and hands off to the existing `startBroadcast`
// runner. Immediate ("send now") broadcasts never touch this queue.
//
// Reuses the workflow queue's Redis connection helpers (one Redis, one place
// that owns the connect options) — see lib/workflows/queue.ts.

import { Queue } from "bullmq";

import {
  connectionOptions,
  createWorkerConnection,
  getRedisConnection,
} from "@/lib/workflows/queue";

export interface BroadcastScheduleJobData {
  broadcastId: string;
}

export const BROADCAST_SCHEDULE_QUEUE_NAME = "broadcast-schedule";

interface QueueGlobals {
  queue?: Queue<BroadcastScheduleJobData>;
}
// globalThis singleton so swc-node watch HMR doesn't spawn duplicate queues.
const g = globalThis as unknown as { __ccpBroadcastScheduleQueue?: QueueGlobals };
const state: QueueGlobals = (g.__ccpBroadcastScheduleQueue ??= {});

export function getBroadcastScheduleQueue(): Queue<BroadcastScheduleJobData> {
  if (state.queue) return state.queue;
  state.queue = new Queue<BroadcastScheduleJobData>(BROADCAST_SCHEDULE_QUEUE_NAME, {
    connection: connectionOptions(),
    defaultJobOptions: {
      // A scheduled broadcast firing is a one-shot trigger; the runner itself
      // owns per-recipient retries + the boot reconciler owns crash recovery,
      // so this job doesn't need many attempts. 2 covers a transient Redis/DB
      // blip at fire time.
      attempts: 2,
      backoff: { type: "fixed", delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600, count: 500 },
    },
  });
  return state.queue;
}

/** Stable, idempotent job id — one delayed job per broadcast. Re-enqueue (boot
 *  reconcile, double-create retry) is a no-op while the job still exists. `-`
 *  separator: BullMQ rejects `:` in custom ids. */
function scheduleJobId(broadcastId: string): string {
  return `bcast-${broadcastId}`;
}

/**
 * Enqueue (or re-enqueue) the delayed fire for a scheduled broadcast.
 * `delayMs` is `scheduledAt - now`, clamped to ≥1 (a past/near-now time fires
 * effectively immediately — the worker still does the CAS so it's safe).
 */
export async function enqueueScheduledBroadcast(
  broadcastId: string,
  delayMs: number,
): Promise<void> {
  const q = getBroadcastScheduleQueue();
  const jobId = scheduleJobId(broadcastId);
  // I-11: BullMQ's add() with a duplicate jobId is a SILENT no-op while ANY job
  // with that id still exists — including a COMPLETED job retained by
  // removeOnComplete (24h) or a FAILED one retained by removeOnFail (7d). So a
  // re-enqueue from the drift sweeper for a broadcast that stranded AFTER its
  // fire job already ran would be silently discarded while the caller logs
  // "re-enqueued". If a TERMINAL job with this id lingers, remove it first so
  // the re-add actually arms a fresh delayed job. A still-pending job
  // (delayed/waiting/active) is left alone — re-enqueueing onto a live one-shot
  // is correctly a no-op.
  const existing = await q.getJob(jobId);
  if (existing) {
    const jobState = await existing.getState();
    if (jobState === "completed" || jobState === "failed") {
      try {
        await existing.remove();
      } catch {
        // Raced into a re-run between getState and remove — the worker's CAS
        // (scheduled → queued) keeps a double-fire a no-op, so this is safe.
      }
    }
  }
  await q.add(
    "fire",
    { broadcastId },
    { delay: Math.max(1, delayMs), jobId },
  );
}

/**
 * Remove a broadcast's pending delayed job (used when an operator cancels a
 * still-scheduled broadcast). Safe if the job is already gone / already fired.
 */
export async function removeScheduledBroadcast(broadcastId: string): Promise<void> {
  const q = getBroadcastScheduleQueue();
  const job = await q.getJob(scheduleJobId(broadcastId));
  if (job) {
    try {
      await job.remove();
    } catch {
      // Job moved to active/completed between getJob and remove — the worker's
      // CAS (scheduled → queued) makes a late fire on a canceled row a no-op.
    }
  }
}

/** Dedicated worker connection (see workflow queue rationale). Caller closes. */
export function createBroadcastScheduleWorkerConnection() {
  return createWorkerConnection("broadcast-schedule");
}

export async function closeBroadcastScheduleQueue(): Promise<void> {
  if (state.queue) {
    await state.queue.close();
    state.queue = undefined;
  }
}

// Re-export so the worker module has a single import surface.
export { getRedisConnection };
