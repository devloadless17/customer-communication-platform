import { ServiceUnavailableException } from "@nestjs/common";
import { Queue } from "bullmq";

import { connectionOptions } from "@/lib/workflows/queue";
import type { Channel } from "@ccp/shared/types";

// Bound the enqueue so a Redis outage fails FAST instead of hanging on the
// ioredis connect-retry loop (~tens of seconds → opaque 500). 2.5s is well
// under any human-perceptible-as-frozen threshold and leaves headroom over a
// healthy enqueue (~5ms).
const ENQUEUE_TIMEOUT_MS = 2_500;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("enqueue_timeout")), ms);
    // Attaching handlers to `p` means a late settle after the timeout is
    // consumed here (no unhandledRejection); it just no-ops on the already-
    // settled outer promise. If Redis recovers and the late add succeeds, the
    // clientTempId jobId dedupes it against the user's retry.
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e as Error); },
    );
  });
}

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
  workspaceId: string;
  userId: string;
  conversationId: string;
  /** Pre-resolved at preflight — the worker uses this directly to call Meta
   *  and does NOT re-fetch the contact row. The preflight verified the
   *  number existed; if a teammate strips the contact's phone in the queue
   *  gap (rare), Meta will reject the send with a clear error and the
   *  worker publishes `message.send_failed`. */
  phoneNumber: string;
  /** True when `phoneNumber` is a WhatsApp BSUID, not a phone — pre-resolved
   *  at preflight (`resolveContactChannel`). The worker threads it to the
   *  provider so the destination rides Meta's `recipient` field. Optional for
   *  forward-compat with jobs enqueued before this field existed. */
  viaBsuid?: boolean;
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
  /** True only when the client is RE-sending a previously-failed bubble (it
   *  reuses that send's clientTempId). A terminally-failed job can linger under
   *  the same jobId, so only a retry needs the getJob→remove-if-failed probe
   *  below. First sends skip the Redis round-trip entirely (jobId is fresh). */
  isRetry?: boolean;
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
      //
      // `custom` hands retry SPACING to the worker's backoffStrategy
      // (send-worker.service.ts): the same 1.5s-exponential as before for
      // transient errors, but a full pair-limit token period (≥6s) when Meta
      // answered 131056 — under the old flat schedule both retries landed
      // inside the 6s refill window and were guaranteed wasted.
      attempts: 3,
      backoff: { type: "custom" },
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
 *
 * One carve-out: a prior send under this clientTempId may have FAILED
 * terminally. BullMQ retains the failed job 7 days (removeOnFail age) and
 * dedupes `add` on jobId, so a same-jobId re-add would be a SILENT no-op —
 * stranding the Retry (reply-box deliberately reuses the clientTempId). So we
 * first drop a terminally-failed record under the same jobId, letting the
 * re-add actually enqueue. The worker's OutboundSendAttempt guard still
 * arbitrates double-send safety on the fresh run (provably-not-sent rows were
 * deleted → clean re-send; ambiguous rows surface a visible error). Only a
 * FAILED job is removed — an in-flight / completed job keeps the dedupe.
 *
 * The probe only runs on a RETRY (`data.isRetry`): a fresh clientTempId can't
 * collide with a lingering failed job, so a first send skips the getJob/getState
 * Redis round-trip and just adds. Only a retry reuses a clientTempId that may
 * have a terminally-failed record parked under its jobId.
 */
export async function enqueueMessageSend(data: MessageSendJobData): Promise<void> {
  const q = getMessageSendQueue();
  // Tenant-namespaced: clientTempId is CLIENT input (the browser mints it with
  // Math.random), and both the BullMQ jobId dedupe and the globally-unique
  // OutboundSendAttempt.jobId key on this value for up to 7 days
  // (removeOnFail age). Without the workspace prefix, a colliding — or
  // deliberately copied — clientTempId from another workspace's session would
  // silently no-op that tenant's send at the queue layer (audit 2026-08-19,
  // U2a-01). The prefix is invisible to clients; they only ever see their own
  // clientTempId echoed back.
  const jobId = data.clientTempId
    ? `msg-send-${data.workspaceId}-${data.clientTempId}`
    : undefined;
  try {
    if (jobId && data.isRetry) {
      const existing = await withTimeout(q.getJob(jobId), ENQUEUE_TIMEOUT_MS);
      if (
        existing &&
        (await withTimeout(existing.getState(), ENQUEUE_TIMEOUT_MS)) === "failed"
      ) {
        await withTimeout(existing.remove(), ENQUEUE_TIMEOUT_MS);
      }
    }
    await withTimeout(
      q.add(
        `${data.kind}:${data.conversationId}`,
        data,
        jobId ? { jobId } : undefined,
      ),
      ENQUEUE_TIMEOUT_MS,
    );
  } catch {
    // Redis down / slow. Surface a clear, RETRYABLE 503 (not an opaque 500 after
    // a 30s hang). The send-idempotency wrapper drops this 503 from its cache so
    // the agent's immediate retry isn't stuck on a stale failure for 5 minutes.
    throw new ServiceUnavailableException({
      error: "queue_unavailable",
      detail: "Message queue is temporarily unavailable — please retry.",
    });
  }
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

