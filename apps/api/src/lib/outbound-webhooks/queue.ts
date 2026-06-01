// Shared BullMQ wiring for the outbound-webhooks delivery queue. Lives
// under lib/ (not under apps/api/src/outbound-webhooks/) for symmetry with
// lib/workflows/queue.ts — the queue is framework-agnostic and only the
// NestJS lifecycle harness sits above it.
//
// The job payload is intentionally tiny — the public envelope + signing
// secret are looked up from the OutboundWebhookDelivery row inside the
// worker so the queue stays small and a long-delayed job picks up the
// current secret (post-rotation) rather than the one in effect at enqueue.

import { Queue, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";

export interface WebhookDeliverJobData {
  deliveryId: string;
  /** Inbound X-CCP-Depth of the request that caused this delivery (0/absent
   *  when the event had no HTTP scope). The worker stamps depth+1 on the
   *  outbound POST so a partner that bounces our webhook back into /v1 carries
   *  an incrementing counter that trips at MAX_CHAIN_DEPTH — the cross-system
   *  loop guard. Rides on the job, not the delivery row, so no schema change. */
  chainDepth?: number;
}

export const WEBHOOK_DELIVER_QUEUE_NAME = "webhook-deliver";

interface QueueGlobals {
  connection?: IORedis;
  queue?: Queue<WebhookDeliverJobData>;
}
const g = globalThis as unknown as { __ccpWebhookQueue?: QueueGlobals };
const state: QueueGlobals = (g.__ccpWebhookQueue ??= {});

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "REDIS_URL not set. Outbound webhooks require Redis. " +
        "Either set REDIS_URL in .env or start Redis via `docker compose up -d redis`.",
    );
  }
  return url;
}

export function getWebhookRedisConnection(): IORedis {
  if (state.connection) return state.connection;
  state.connection = new IORedis(redisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Same posture as the workflow queue connection. Without these a
    // network-partitioned Redis wedges the worker indefinitely.
    connectTimeout: 10_000,
    commandTimeout: 30_000,
  });
  state.connection.on("error", (err) => {
    console.error("[webhooks][redis]", err.message);
  });
  return state.connection;
}

export function webhookConnectionOptions(): ConnectionOptions {
  return getWebhookRedisConnection();
}

/**
 * Dedicated connection for the delivery Worker's blocking commands — see
 * `createWorkerConnection` in lib/workflows/queue.ts for why a Worker must not
 * share the producer connection. Caller owns + closes it.
 */
export function createWebhookWorkerConnection(label: string): IORedis {
  const conn = getWebhookRedisConnection().duplicate();
  conn.on("error", (err) => {
    console.error(`[${label}][redis]`, err.message);
  });
  return conn;
}

/**
 * Retry profile: 4 attempts with exponential backoff starting at 30s
 * (30s → ~2m → ~8m → ~30m). After the final attempt the worker stamps
 * `lastErrorAt` on the webhook row + bumps `consecutiveFailures`; the
 * circuit breaker auto-disables once that crosses the threshold.
 */
export function getWebhookDeliverQueue(): Queue<WebhookDeliverJobData> {
  if (state.queue) return state.queue;
  state.queue = new Queue<WebhookDeliverJobData>(WEBHOOK_DELIVER_QUEUE_NAME, {
    connection: webhookConnectionOptions(),
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });
  return state.queue;
}

/**
 * Enqueue idempotently. `jobId: deliver-${deliveryId}` collapses any
 * duplicate enqueue for the same delivery row — the orphan-delivery
 * sweeper can re-enqueue stranded rows without racing the subscriber's
 * original enqueue and POSTing the partner twice.
 *
 * Separator is `-`, not `:` — BullMQ 5.x rejects colons in custom job IDs.
 */
export async function enqueueWebhookDelivery(
  deliveryId: string,
  chainDepth?: number,
): Promise<string> {
  const q = getWebhookDeliverQueue();
  const job = await q.add(
    "deliver",
    { deliveryId, ...(chainDepth ? { chainDepth } : {}) },
    { jobId: `deliver-${deliveryId}` },
  );
  return job.id as string;
}

export async function closeWebhookDeliverQueue(): Promise<void> {
  if (state.queue) {
    await state.queue.close();
    state.queue = undefined;
  }
  if (state.connection) {
    state.connection.disconnect();
    state.connection = undefined;
  }
}
