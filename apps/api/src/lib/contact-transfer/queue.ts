// BullMQ wiring for contact import/export jobs. Both directions share one
// queue: they have the same shape (read a job row, stream a file, update
// counters), the same concurrency budget, and the same failure handling, so
// two queues would be two of everything for no isolation benefit.
//
// Mirrors lib/broadcasts/materialize-queue.ts exactly (same Redis owner, same
// globalThis singleton, same idempotent-jobId + terminal-job-clear dance). See
// lib/workflows/queue.ts for the connection.

import { Queue } from "bullmq";

import {
  connectionOptions,
  createWorkerConnection,
  getRedisConnection,
} from "@/lib/workflows/queue";

export interface ContactTransferJobData {
  jobId: string;
}

export const CONTACT_TRANSFER_QUEUE_NAME = "contact-transfer";

/**
 * Process-wide worker concurrency. Deliberately low and deliberately GLOBAL:
 * the recurring defect in this codebase's queues has been a per-tenant cap with
 * no process-wide ceiling (MAX_RUNNING_BROADCASTS / FFMPEG_CONCURRENCY), which
 * lets 30 tenants each run "one" job and collectively exhaust the box. A
 * transfer holds a temp file, a parser, and a batch of rows; two at a time is
 * what a 2 GB API container can carry alongside the inbox.
 */
export const MAX_CONCURRENT_TRANSFERS = 2;

/** Per-team ceiling, enforced at enqueue time (a 4xx, not a silent queue). */
export const MAX_CONCURRENT_TRANSFERS_PER_TEAM = 1;

interface QueueGlobals {
  queue?: Queue<ContactTransferJobData>;
}
// globalThis singleton so swc-node watch HMR doesn't spawn duplicate queues.
const g = globalThis as unknown as { __ccpContactTransferQueue?: QueueGlobals };
const state: QueueGlobals = (g.__ccpContactTransferQueue ??= {});

export function getContactTransferQueue(): Queue<ContactTransferJobData> {
  if (state.queue) return state.queue;
  state.queue = new Queue<ContactTransferJobData>(CONTACT_TRANSFER_QUEUE_NAME, {
    connection: connectionOptions(),
    defaultJobOptions: {
      // Every write the runner performs is individually idempotent (createMany
      // skipDuplicates, revive CAS, ON CONFLICT DO NOTHING) AND the runner
      // resumes from the persisted `processedRows` cursor, so a retry re-does
      // at most the batch that was in flight. Three attempts covers a
      // transient Redis/DB blip; the sweeper is the longer-horizon backstop.
      attempts: 3,
      backoff: { type: "fixed", delay: 10_000 },
      removeOnComplete: { age: 24 * 3600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3600, count: 200 },
    },
  });
  return state.queue;
}

/** Stable, idempotent job id — one BullMQ job per transfer row. `-` separator:
 *  BullMQ rejects `:` in custom ids. */
function transferJobId(jobId: string): string {
  return `ctf-${jobId}`;
}

/**
 * Enqueue (or re-enqueue) a transfer. Idempotent: a still-pending job is left
 * alone; a lingering TERMINAL job (retained by removeOnComplete/Fail) is
 * cleared first so a sweeper re-enqueue actually arms a fresh job rather than
 * silently no-oping.
 */
export async function enqueueContactTransfer(jobId: string): Promise<void> {
  const q = getContactTransferQueue();
  const id = transferJobId(jobId);
  const existing = await q.getJob(id);
  if (existing) {
    const jobState = await existing.getState();
    if (jobState === "completed" || jobState === "failed") {
      try {
        await existing.remove();
      } catch {
        // Raced into a re-run between getState and remove — the runner's status
        // CAS (pending|running → running) keeps a double-run a no-op.
      }
    }
  }
  await q.add("transfer", { jobId }, { jobId: id });
}

/** Remove a pending transfer job (operator cancel). Safe if already gone/running. */
export async function removeContactTransfer(jobId: string): Promise<void> {
  const q = getContactTransferQueue();
  const job = await q.getJob(transferJobId(jobId));
  if (job) {
    try {
      await job.remove();
    } catch {
      // Moved to active/completed between getJob and remove — the runner's
      // cancel check makes a late run on a canceled row a no-op.
    }
  }
}

/** Dedicated worker connection (see workflow queue rationale). Caller closes. */
export function createContactTransferWorkerConnection() {
  return createWorkerConnection("contact-transfer");
}

export async function closeContactTransferQueue(): Promise<void> {
  if (state.queue) {
    await state.queue.close();
    state.queue = undefined;
  }
}

// Re-export so the worker module has a single import surface.
export { getRedisConnection };
