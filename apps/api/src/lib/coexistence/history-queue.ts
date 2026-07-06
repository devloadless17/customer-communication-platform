// BullMQ wiring for the WhatsApp Coexistence history backfill.
//
// The `history` webhook can carry thousands of past messages across many
// chunked deliveries. Ingesting them inline would blow the webhook's fail-soft
// budget (Meta retries any non-2xx into a storm). Instead the webhook enqueues
// the RAW payload here and 200s immediately; the worker (history-worker.ts)
// re-parses + ingests in the background, idempotently (dedup by wamid), so a
// chunk re-delivery is safe.
//
// Reuses the shared Redis connection helpers from the workflows queue — same
// process, same Redis, no reason to open a second producer socket.

import { Queue } from "bullmq";

import { connectionOptions } from "@/lib/workflows/queue";

export interface HistoryJobData {
  teamId: string;
  /** The raw Meta `history` webhook body — re-parsed by the worker. */
  payload: unknown;
}

export const COEXISTENCE_HISTORY_QUEUE_NAME = "coexistence-history";

interface QueueGlobals {
  queue?: Queue<HistoryJobData>;
}
const g = globalThis as unknown as { __ccpHistoryQueue?: QueueGlobals };
const state: QueueGlobals = (g.__ccpHistoryQueue ??= {});

export function getHistoryQueue(): Queue<HistoryJobData> {
  if (state.queue) return state.queue;
  state.queue = new Queue<HistoryJobData>(COEXISTENCE_HISTORY_QUEUE_NAME, {
    connection: connectionOptions(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });
  return state.queue;
}

/**
 * Enqueue one history chunk. No custom jobId — every chunk is a distinct
 * delivery and idempotency is enforced downstream by the per-message wamid
 * dedup, so we WANT each chunk processed (a dedup on jobId would silently drop
 * legitimately-distinct chunks).
 */
export async function enqueueHistoryChunk(
  teamId: string,
  payload: unknown,
): Promise<string> {
  const job = await getHistoryQueue().add("chunk", { teamId, payload });
  return job.id as string;
}

export async function closeHistoryQueue(): Promise<void> {
  if (state.queue) {
    await state.queue.close();
    state.queue = undefined;
  }
}
