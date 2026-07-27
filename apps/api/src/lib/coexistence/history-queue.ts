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
  workspaceId: string;
  /** The raw Meta `history` webhook body — re-parsed by the worker. */
  payload: unknown;
  /** Account the chunk arrived on; stamped on threads this backfill creates. */
  channelConnectionId?: string | null;
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
      // Each job carries a FULL raw Meta history payload (thousands of past
      // messages per chunk) as job data inside the 200mb noeviction Redis. A
      // large backfill retaining 1000 completed + 5000 failed such payloads
      // could hit maxmemory, at which point EVERY BullMQ write in the process
      // fails (send/workflow/broadcast enqueues) and the wedge can't self-heal.
      // The payload has zero replay value once ingested — dedup is by wamid —
      // so drop completed jobs almost immediately and keep only a small failed
      // window for triage.
      removeOnComplete: { age: 3600, count: 50 },
      removeOnFail: { age: 24 * 3600, count: 500 },
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
  workspaceId: string,
  payload: unknown,
  /**
   * The account the history webhook arrived on. Carried so backfilled threads
   * are BOUND to a number: without it they land with a null
   * `channelConnectionId`, which (since the account-unresolved guard) makes
   * them unsendable from the inbox in a multi-account workspace until the
   * customer sends an inbound.
   */
  channelConnectionId?: string | null,
): Promise<string> {
  const job = await getHistoryQueue().add("chunk", {
    workspaceId,
    payload,
    ...(channelConnectionId ? { channelConnectionId } : {}),
  });
  return job.id as string;
}

export async function closeHistoryQueue(): Promise<void> {
  if (state.queue) {
    await state.queue.close();
    state.queue = undefined;
  }
}
