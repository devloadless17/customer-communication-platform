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
  /** Owning team, carried from the publishing event so the worker's per-team
   *  concurrency gate reads it off the job instead of a per-pickup DB
   *  findUnique (join webhook.workspaceId) — which, under a single-team burst that
   *  keeps deferring, became a DB/Redis busy-spin. Optional for backward-compat
   *  with jobs enqueued before this field existed (worker falls back to the
   *  delivery row for those). */
  workspaceId?: string;
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
 * Retry profile: front-loaded exponential backoff starting at 30s so a brief
 * receiver blip recovers on the first retry, while the full ladder spans
 * ~31 min so a routine partner deploy (a few minutes of 5xx / connection
 * refused) doesn't permanently lose every delivery generated in that window.
 *
 * BullMQ's builtin `exponential` is base-2 (`2^(attemptsMade-1) * delay`), so
 * with delay=30s the per-retry delays are 30s → 1m → 2m → 4m → 8m → 16m; 7
 * attempts total put the last retry ~31 min after the first failure (cumulative
 * ~31.5 min). This is the correction for the old `attempts: 4` profile, whose
 * comment claimed a 30s→2m→8m→30m / ~40min spread but — because base-2 isn't
 * base-4 — actually exhausted all retries in ~3.5 min, so a 10-min receiver
 * outage lost every delivery permanently. (The exact 30s→2m→8m→30m ladder is
 * base-4 and would need a custom Worker `settings.backoffStrategy`; deferred —
 * extending the base-2 ladder covers the same intent with a one-line change and
 * no cross-file coupling.)
 *
 * After the final attempt the worker stamps `lastErrorAt` on the webhook row +
 * bumps `consecutiveFailures`; the circuit breaker auto-disables once that
 * crosses the threshold.
 */
export function getWebhookDeliverQueue(): Queue<WebhookDeliverJobData> {
  if (state.queue) return state.queue;
  state.queue = new Queue<WebhookDeliverJobData>(WEBHOOK_DELIVER_QUEUE_NAME, {
    connection: webhookConnectionOptions(),
    defaultJobOptions: {
      attempts: 7,
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
  workspaceId?: string,
): Promise<string> {
  const q = getWebhookDeliverQueue();
  const job = await q.add(
    "deliver",
    {
      deliveryId,
      ...(chainDepth ? { chainDepth } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    },
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
