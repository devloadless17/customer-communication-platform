// BullMQ wiring for MATERIALIZING large broadcasts. A broadcast whose audience
// exceeds the synchronous-insert threshold is created `materializing` with its
// resolved recipients staged on the row; a job here inserts the
// BroadcastRecipient rows off the create HTTP path, flips the row `materializing`
// → `queued`, and hands off to `startBroadcast`. Small broadcasts insert inline
// and never touch this queue.
//
// Mirrors schedule-queue.ts exactly (same Redis owner, same idempotent-jobId +
// terminal-job-clear dance). See lib/workflows/queue.ts for the connection.

import { Queue } from "bullmq";

import {
  connectionOptions,
  createWorkerConnection,
  getRedisConnection,
} from "@/lib/workflows/queue";

export interface BroadcastMaterializeJobData {
  broadcastId: string;
}

export const BROADCAST_MATERIALIZE_QUEUE_NAME = "broadcast-materialize";

interface QueueGlobals {
  queue?: Queue<BroadcastMaterializeJobData>;
}
// globalThis singleton so swc-node watch HMR doesn't spawn duplicate queues.
const g = globalThis as unknown as { __ccpBroadcastMaterializeQueue?: QueueGlobals };
const state: QueueGlobals = (g.__ccpBroadcastMaterializeQueue ??= {});

export function getBroadcastMaterializeQueue(): Queue<BroadcastMaterializeJobData> {
  if (state.queue) return state.queue;
  state.queue = new Queue<BroadcastMaterializeJobData>(BROADCAST_MATERIALIZE_QUEUE_NAME, {
    connection: connectionOptions(),
    defaultJobOptions: {
      // Materialization is idempotent (the worker CAS-guards status and uses
      // createMany skipDuplicates), so a couple of retries covers a transient
      // Redis/DB blip; the drift sweeper is the longer-horizon backstop.
      attempts: 3,
      backoff: { type: "fixed", delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600, count: 500 },
    },
  });
  return state.queue;
}

/** Stable, idempotent job id — one materialize job per broadcast. `-` separator:
 *  BullMQ rejects `:` in custom ids. */
function materializeJobId(broadcastId: string): string {
  return `bcast-mat-${broadcastId}`;
}

/**
 * Enqueue (or re-enqueue) the materialize job for a broadcast. Idempotent: a
 * still-pending job is left alone; a lingering TERMINAL job (retained by
 * removeOnComplete/Fail) is cleared first so a drift-sweep re-enqueue actually
 * arms a fresh job rather than silently no-oping (same subtlety as the schedule
 * queue's I-11 note).
 */
export async function enqueueBroadcastMaterialize(broadcastId: string): Promise<void> {
  const q = getBroadcastMaterializeQueue();
  const jobId = materializeJobId(broadcastId);
  const existing = await q.getJob(jobId);
  if (existing) {
    const jobState = await existing.getState();
    if (jobState === "completed" || jobState === "failed") {
      try {
        await existing.remove();
      } catch {
        // Raced into a re-run between getState and remove — the worker's CAS
        // (materializing → queued) keeps a double-run a no-op, so this is safe.
      }
    }
  }
  await q.add("materialize", { broadcastId }, { jobId });
}

/**
 * Remove a broadcast's pending materialize job (used when an operator cancels a
 * still-`materializing` broadcast). Safe if the job is already gone / running.
 */
export async function removeBroadcastMaterialize(broadcastId: string): Promise<void> {
  const q = getBroadcastMaterializeQueue();
  const job = await q.getJob(materializeJobId(broadcastId));
  if (job) {
    try {
      await job.remove();
    } catch {
      // Job moved to active/completed between getJob and remove — the worker's
      // status CAS makes a late run on a canceled row a no-op.
    }
  }
}

/** Dedicated worker connection (see workflow queue rationale). Caller closes. */
export function createBroadcastMaterializeWorkerConnection() {
  return createWorkerConnection("broadcast-materialize");
}

export async function closeBroadcastMaterializeQueue(): Promise<void> {
  if (state.queue) {
    await state.queue.close();
    state.queue = undefined;
  }
}

// Re-export so the worker module has a single import surface.
export { getRedisConnection };
