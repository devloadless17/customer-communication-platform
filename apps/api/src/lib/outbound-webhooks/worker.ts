// Outbound-webhook delivery worker. Sibling to lib/workflows/worker.ts —
// both are framework-agnostic BullMQ consumers. The NestJS lifecycle
// harness (OutboundWebhookWorkerService) starts/stops this on module
// init/destroy so worker.close() can drain the in-flight HTTP request
// before the process exits.

import { Worker, type Job } from "bullmq";

import {
  WEBHOOK_DELIVER_QUEUE_NAME,
  webhookConnectionOptions,
  type WebhookDeliverJobData,
} from "./queue";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto/envelope";
import { publish } from "@/lib/events/bus";
import { safeFetch, SsrfBlockedError, readLimitedBody } from "@/lib/http/safe-fetch";

import { signWebhookBody } from "./signing";

const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Auto-disable threshold. After this many consecutive **deliveries** fail
 * across ALL their attempts, `enabled` flips to false. Counted per delivery
 * (not per attempt) — the original implementation incremented on every
 * BullMQ retry, which tripped the breaker after 5 dead deliveries instead
 * of 20 because each delivery took the counter +4 (default attempts=4).
 *
 * 4 attempts × ~30s/2m/8m/30m backoff = ~40 minutes per failed delivery.
 * 20 consecutive *deliveries* ≈ ~13 hours of sustained breakage. Conservative.
 */
const AUTO_DISABLE_THRESHOLD = 20;

const MAX_RESPONSE_BODY_BYTES = 4096;

interface WorkerGlobals {
  worker?: Worker<WebhookDeliverJobData>;
}
const g = globalThis as unknown as { __ccpWebhookWorker?: WorkerGlobals };
const state: WorkerGlobals = (g.__ccpWebhookWorker ??= {});

function concurrency(): number {
  const raw = Number.parseInt(process.env.WEBHOOK_WORKER_CONCURRENCY ?? "10", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 10;
}

export function startWebhookDeliverWorker(): Worker<WebhookDeliverJobData> {
  if (state.worker) return state.worker;

  const worker = new Worker<WebhookDeliverJobData>(
    WEBHOOK_DELIVER_QUEUE_NAME,
    async (job: Job<WebhookDeliverJobData>) => {
      // attemptsMade is 0 on first run; deliverOnce wants 1-indexed.
      // job.opts.attempts comes from the queue default (currently 4).
      const attempt = job.attemptsMade + 1;
      const maxAttempts = job.opts.attempts ?? 1;
      await deliverOnce(job.data.deliveryId, attempt, maxAttempts);
    },
    {
      connection: webhookConnectionOptions(),
      concurrency: concurrency(),
      // Each delivery is a single fetch + a tiny DB update. 30s lock is
      // generous for a 10s-timeout fetch — leaves headroom for slow DNS
      // + a couple of write retries on the DB side.
      lockDuration: 30_000,
      lockRenewTime: 15_000,
    },
  );

  worker.on("failed", (job, err) => {
    console.warn(
      `[webhooks] delivery ${job?.id} failed (attempt ${job?.attemptsMade}/${
        job?.opts.attempts ?? 1
      }): ${err.message}`,
    );
  });

  worker.on("error", (err) => {
    console.error("[webhooks] worker error", err);
  });

  state.worker = worker;
  console.log(`[webhooks] delivery worker started, concurrency=${concurrency()}`);
  return worker;
}

export async function stopWebhookDeliverWorker(): Promise<void> {
  if (!state.worker) return;
  await state.worker.close();
  state.worker = undefined;
}

/**
 * One delivery attempt. Reads the persisted row (so retries pick up the
 * current secret post-rotation), POSTs, then updates the row + the
 * webhook's rolling failure counter.
 *
 * Throwing here triggers a BullMQ retry per the queue's exponential backoff.
 * Returning successfully ends the job. Decisions:
 *   - 2xx response   → success
 *   - 4xx / 5xx / no-response (DNS, timeout, TLS) → throw so BullMQ retries
 *   - On the LAST attempt (`attempt === maxAttempts`), we still throw so
 *     the BullMQ "failed" event fires, but we ALSO update the breaker
 *     counter so the next event doesn't immediately re-trip a dead URL.
 */
async function deliverOnce(
  deliveryId: string,
  attempt: number,
  maxAttempts: number,
): Promise<void> {
  const delivery = await db.outboundWebhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  });
  if (!delivery) {
    // Row was deleted (webhook revoked between enqueue and pickup).
    // Nothing to do — log and exit cleanly.
    console.warn(`[webhooks] delivery ${deliveryId} missing — webhook deleted before delivery?`);
    return;
  }

  const { webhook } = delivery;
  if (!webhook.enabled) {
    // Webhook was disabled between enqueue and pickup. Mark this attempt
    // as a no-op so the delivery log carries an explicit reason.
    await db.outboundWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attemptCount: attempt,
        failedAt: new Date(),
        errorMessage: "webhook disabled before delivery",
      },
    });
    return;
  }

  let secret: string;
  try {
    secret = decryptSecret(webhook.secret);
  } catch (err) {
    await db.outboundWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attemptCount: attempt,
        failedAt: new Date(),
        errorMessage: `secret decrypt failed: ${err instanceof Error ? err.message : err}`,
      },
    });
    throw err;
  }

  const body = JSON.stringify(delivery.payload);
  const signature = signWebhookBody(secret, body);

  let response: Response;
  try {
    response = await safeFetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "CCP-Webhook/1.0",
        "X-CCP-Event": delivery.eventType,
        "X-CCP-Delivery": delivery.id,
        "X-CCP-Signature": signature,
      },
      body,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    const isSsrf = err instanceof SsrfBlockedError;
    const errorMessage = err instanceof Error ? err.message : String(err);
    // SSRF rejections are permanent — treat as the final attempt for
    // breaker-counter purposes (one bump on the delivery, then return)
    // since BullMQ retries here are pointless: the URL won't resolve any
    // differently next try.
    const isFinal = isSsrf || attempt >= maxAttempts;
    await recordFailure(
      delivery.id,
      webhook.id,
      attempt,
      null,
      null,
      errorMessage,
      isFinal,
    );
    if (isSsrf) return;
    throw err;
  }

  // Stream-read at most MAX_RESPONSE_BODY_BYTES for the log row — a receiver
  // returning a 2GB body must not OOM the worker.
  const responseText = await readLimitedBody(response, MAX_RESPONSE_BODY_BYTES);

  if (response.ok) {
    await db.$transaction([
      db.outboundWebhookDelivery.update({
        where: { id: deliveryId },
        data: {
          attemptCount: attempt,
          responseStatus: response.status,
          responseBody: responseText,
          deliveredAt: new Date(),
          failedAt: null,
          errorMessage: null,
        },
      }),
      db.outboundWebhook.update({
        where: { id: webhook.id },
        data: {
          lastDeliveredAt: new Date(),
          lastErrorAt: null,
          lastErrorMessage: null,
          consecutiveFailures: 0,
        },
      }),
    ]);
    return;
  }

  // Non-2xx: persist + bump the breaker only on the final attempt so the
  // counter measures deliveries rather than attempts.
  await recordFailure(
    delivery.id,
    webhook.id,
    attempt,
    response.status,
    responseText,
    `HTTP ${response.status}`,
    attempt >= maxAttempts,
  );
  throw new Error(`receiver returned ${response.status}`);
}

async function recordFailure(
  deliveryId: string,
  webhookId: string,
  attempt: number,
  status: number | null,
  responseBody: string | null,
  errorMessage: string,
  /** True on the final BullMQ attempt — only then do we bump the breaker
   *  counter, so the threshold counts deliveries (not per-attempt retries). */
  isFinalAttempt: boolean,
): Promise<void> {
  // We need the team id outside the transaction (for the socket emit) AND
  // we want the disable to be transactional with the failure counter bump,
  // so collect the just-tripped flag from the inner update and fire the
  // event afterwards.
  let tripped: { teamId: string; reason: string } | null = null;
  await db.$transaction(async (tx) => {
    await tx.outboundWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attemptCount: attempt,
        responseStatus: status,
        responseBody,
        failedAt: new Date(),
        errorMessage,
      },
    });
    // Non-final attempts: stamp lastErrorAt/lastErrorMessage so the
    // settings UI still surfaces "the last attempt failed", but do NOT
    // bump the consecutive-failures counter — the delivery is still in
    // flight from the breaker's perspective and BullMQ will retry it.
    if (!isFinalAttempt) {
      await tx.outboundWebhook.update({
        where: { id: webhookId },
        data: {
          lastErrorAt: new Date(),
          lastErrorMessage: errorMessage,
        },
      });
      return;
    }
    const updated = await tx.outboundWebhook.update({
      where: { id: webhookId },
      data: {
        lastErrorAt: new Date(),
        lastErrorMessage: errorMessage,
        consecutiveFailures: { increment: 1 },
      },
      select: { consecutiveFailures: true, enabled: true, teamId: true },
    });
    if (updated.enabled && updated.consecutiveFailures >= AUTO_DISABLE_THRESHOLD) {
      const reason = `${updated.consecutiveFailures} consecutive failures`;
      await tx.outboundWebhook.update({
        where: { id: webhookId },
        data: {
          enabled: false,
          disabledAt: new Date(),
          disabledReason: reason,
        },
      });
      tripped = { teamId: updated.teamId, reason };
      console.warn(
        `[webhooks] auto-disabled webhook ${webhookId} after ${updated.consecutiveFailures} consecutive failures`,
      );
    }
  });

  if (tripped) {
    // Socket-side notification — surfaces a toast in the settings UI so an
    // operator who's watching knows their integration just went silent.
    // Fire-and-forget: if the bus is degraded, the DB state is still correct
    // and the UI will show the disabled badge on next page load.
    const t = tripped as { teamId: string; reason: string };
    void publish({
      type: "webhook.subscription_disabled",
      teamId: t.teamId,
      webhookId,
      reason: t.reason,
    }).catch((err) => {
      console.error(
        `[webhooks] publish(webhook.subscription_disabled) failed: ${err instanceof Error ? err.message : err}`,
      );
    });
  }
}

