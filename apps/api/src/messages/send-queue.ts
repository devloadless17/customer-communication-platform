import { Queue } from "bullmq";

import { connectionOptions } from "@/lib/workflows/queue";
import type { Channel } from "@ccp/shared/types";

/**
 * Outbound text/template send queue.
 *
 * The HTTP POST does pre-flight (conversation lookup, 24h window, replyTo
 * resolution) synchronously so 4xx errors still surface in the response,
 * then enqueues a job and returns `{ ok: true, queued: true, clientTempId }`
 * in ~5 ms. A BullMQ worker (`send-worker.service.ts`) picks up the job and
 * performs the Meta send + idempotent DB write + bus publish — the same
 * sequence that used to happen on the HTTP critical path.
 *
 * Media sends do NOT go through this queue: the multer-disk-temp-file
 * lives in /tmp on the current process and isn't reachable from a different
 * worker process. Forward + external /v1 also stay synchronous (partners
 * need the wamid in the response).
 *
 * jobId = clientTempId when set, so BullMQ's "skip add if jobId exists"
 * dedupes double-click / network-retry duplicates at the queue layer too,
 * on top of the in-process `send-idempotency` lock.
 */

export const MESSAGE_SEND_QUEUE_NAME = "message-sends";

/**
 * Scope: only free-form TEXT sends ride this queue today. Template sends
 * stay on the synchronous HTTP path because (a) their preflight is more
 * involved (template lookup + var-count validation + approved-status check)
 * and (b) per-agent volume is much lower (one click in the template picker
 * vs. dozens of free-form replies per shift). Media sends also stay sync
 * because the multer-disk temp file lives on the originating process and
 * isn't shareable with a worker in another process. Forward + /v1 external
 * API stay sync — both need the wamid in the response.
 */
interface BaseSendJob {
  teamId: string;
  userId: string;
  conversationId: string;
  /** Pre-resolved at preflight — the worker uses this directly to call Meta
   *  and does NOT re-fetch the contact row. The preflight verified the
   *  number existed; if a teammate strips the contact's phone in the queue
   *  gap (rare), Meta will reject the send with a clear error and the
   *  worker publishes `message.send_failed`. */
  phoneNumber: string;
  /** Channel the destination belongs to, pre-resolved at preflight from the
   *  contact's identity (`resolveContactChannel`). The worker looks the
   *  provider up in the registry instead of assuming Meta. Optional for
   *  forward-compat with jobs enqueued before this field existed — the worker
   *  defaults to `meta_cloud`. */
  channel?: Channel;
  /** Pre-resolved local id when the user is replying to a quoted message. */
  replyToMessageId?: string | null;
  /** Pre-resolved wamid for Meta's `context.message_id`; absent when parent
   *  is pending-send. Worker forwards as-is — no further lookup. */
  replyToExternalId?: string;
  /** Echoed all the way back to the originating client for optimistic-swap. */
  clientTempId?: string;
  /** Stamped at HTTP arrival so the message timestamp reflects intent, not
   *  worker pickup latency. ISO string for BullMQ JSON compatibility. */
  receivedAt: string;
}

export interface SendTextJobData extends BaseSendJob {
  kind: "text";
  body: string;
}

export type MessageSendJobData = SendTextJobData;

interface QueueGlobals {
  queue?: Queue<MessageSendJobData>;
}
const g = globalThis as unknown as { __ccpMessageSendQueue?: QueueGlobals };
const state: QueueGlobals = (g.__ccpMessageSendQueue ??= {});

/**
 * Lazy queue — same pattern as the workflows queue. `connectionOptions()`
 * returns the shared IORedis singleton so we don't open a second connection
 * just for this queue.
 */
export function getMessageSendQueue(): Queue<MessageSendJobData> {
  if (state.queue) return state.queue;
  state.queue = new Queue<MessageSendJobData>(MESSAGE_SEND_QUEUE_NAME, {
    connection: connectionOptions(),
    defaultJobOptions: {
      // 3 attempts on 5xx / transient — Meta returns 503 on rate limit and a
      // brief network blip is recoverable. 4xx errors (24h closed, template
      // rejected) are NOT retried; the worker categorizes the error and
      // re-throws non-transient ones as `UnrecoverableError` so BullMQ skips
      // remaining attempts.
      attempts: 3,
      backoff: { type: "exponential", delay: 1_500 },
      // Successful sends are durable in DB + audit timeline; the job record
      // itself doesn't need to live forever. Keep a day of completed jobs
      // for ops debugging, a week of failures.
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });
  return state.queue;
}

/**
 * Enqueue an outbound send. When clientTempId is set we use it as the BullMQ
 * jobId so a duplicate POST with the same clientTempId becomes a no-op at the
 * queue layer (a second adversarial-retry doesn't re-Meta-send). Without a
 * clientTempId we let BullMQ generate one — pure server-driven sends (none
 * today) wouldn't have a stable browser key anyway.
 */
export async function enqueueMessageSend(data: MessageSendJobData): Promise<void> {
  const q = getMessageSendQueue();
  await q.add(
    `${data.kind}:${data.conversationId}`,
    data,
    data.clientTempId ? { jobId: `msg-send-${data.clientTempId}` } : undefined,
  );
}

/**
 * Close the lazy producer + its ioredis socket on shutdown. Without this,
 * the producer connection (shared via connectionOptions()) outlives the
 * worker drain by 1-2s, keeping the process from exiting cleanly within
 * the compose stop_grace_period. Mirrors `closeWebhookDeliverQueue` in
 * `lib/outbound-webhooks/queue.ts`. Idempotent on re-entry — safe if a
 * caller invokes it twice.
 */
export async function closeMessageSendQueue(): Promise<void> {
  if (!state.queue) return;
  const q = state.queue;
  state.queue = undefined;
  try {
    await q.close();
  } catch {
    // No-op; we're shutting down and the ioredis socket may already be
    // disconnected via the shared producer connection's own teardown.
  }
}

