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
      // Each delivery is a single fetch + a tiny DB update — BUT under DB
      // contention (100 concurrent failures all queued on the same
      // OutboundWebhook row lock) tail latency can pass 60s, the BullMQ
      // lock expires, and the job is re-delivered → duplicate POST to
      // the partner. Bumped to 120s; lockRenewTime stays at 30s so the
      // worker still extends while genuinely active.
      lockDuration: 120_000,
      lockRenewTime: 30_000,
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

  // Loop-detection hint for partners. When the event was triggered via an
  // API-key-authenticated mutation (a `/v1/messages` send, a `/v1/contacts`
  // tag flip, etc.), the public envelope carries the originating apiKeyId
  // in `payload.data.sender.id` (for sends) or `payload.data.changed_by.id`
  // (for contact mutations). Surface it as a request header so a partner's
  // automation can do a single-line "if this matches my key, ignore" check
  // without cracking open the JSON body. Closes the hot-potato vector:
  // partner → POST /v1/messages → our `message.sent` → outbound webhook →
  // partner → POST again, ad nauseam.
  const originApiKeyId = extractOriginApiKeyId(delivery.payload);

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
        ...(originApiKeyId ? { "X-CCP-Origin-Key": originApiKeyId } : {}),
      },
      body,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      // No redirects on outbound webhooks. A 307 hop to a different host
      // would re-send the same HMAC signature + auth headers, which a
      // malicious receiver could log and replay. Webhook receivers are
      // terminal endpoints; if a customer truly needs a redirect they
      // should update the URL in our settings.
      maxRedirects: 0,
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
    // Read prior consecutive-failures count so we can emit a recovery
    // event on the N>0 → 0 transition. Without this the operator never
    // gets a positive signal when a previously-broken webhook recovers
    // (the disabled flow has both a log + a socket event; recovery was
    // silent).
    const priorFailures = webhook.consecutiveFailures;
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
    if (priorFailures > 0) {
      try {
        await publish({
          type: "webhook.subscription_recovered",
          teamId: webhook.teamId,
          webhookId: webhook.id,
        });
      } catch (err) {
        // Non-fatal — the row update succeeded; the recovery notification
        // is informational only.
        console.warn(
          `[webhooks] publish(webhook.subscription_recovered) failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
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
  // Two writes, deliberately NOT wrapped in one transaction:
  //   1. Delivery row update — single-row, no contention with other workers.
  //   2. Webhook counter bump — every concurrent failed delivery to the
  //      SAME dead URL queues on this row lock; folding (1) inside (2)'s
  //      tx serialized the delivery-row write through the same lock for
  //      no benefit. The counter is a breaker; overshooting the threshold
  //      by a few in a real outage is benign. The delivery rows being
  //      eventually-consistent with the counter is the right tradeoff.
  await db.outboundWebhookDelivery.update({
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
    await db.outboundWebhook.update({
      where: { id: webhookId },
      data: {
        lastErrorAt: new Date(),
        lastErrorMessage: errorMessage,
      },
    });
    return;
  }

  // Atomic increment + read (single-row UPDATE…RETURNING). Concurrent
  // failed deliveries to the same webhook all queue here in order.
  const updated = await db.outboundWebhook.update({
    where: { id: webhookId },
    data: {
      lastErrorAt: new Date(),
      lastErrorMessage: errorMessage,
      consecutiveFailures: { increment: 1 },
    },
    select: { consecutiveFailures: true, enabled: true, teamId: true },
  });

  let tripped: { teamId: string; reason: string } | null = null;
  if (updated.enabled && updated.consecutiveFailures >= AUTO_DISABLE_THRESHOLD) {
    const reason = `${updated.consecutiveFailures} consecutive failures`;
    // Second concurrent worker may attempt the same disable — fine, the
    // disabledAt/disabledReason update is idempotent and the publish
    // below is rate-limited by the WHERE clause: only the first tripper
    // actually transitions enabled=true → enabled=false.
    const flip = await db.outboundWebhook.updateMany({
      where: { id: webhookId, enabled: true },
      data: {
        enabled: false,
        disabledAt: new Date(),
        disabledReason: reason,
      },
    });
    if (flip.count > 0) {
      tripped = { teamId: updated.teamId, reason };
      console.warn(
        `[webhooks] auto-disabled webhook ${webhookId} after ${updated.consecutiveFailures} consecutive failures`,
      );
    }
  }

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

/**
 * Pull the originating API-key id out of a public-event envelope, if any.
 *
 * Public envelope shape varies per event type. The two shapes that carry
 * an API-key sender today:
 *   - message.sent:     `data.message.sender.type === "api"` + `.sender.id`
 *   - message.received: never API-keyed (always a contact sender)
 *   - contact.*:        `data.changed_by.type === "api"` + `.changed_by.id`
 *   - note.created:     `data.note.author.type === "api"` (rare today)
 *   - conversation.*:   `data.changed_by.type === "api"` + `.changed_by.id`
 *
 * Returns null on any payload shape we don't recognize — the partner
 * just won't receive the loop-detection header, no harm done. JSON
 * structure check is defensive: a partner's bad webhook URL change
 * shouldn't tank deliveries with a TypeError on a missing nested field.
 */
function extractOriginApiKeyId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;

  const candidates: Array<{ type?: unknown; id?: unknown }> = [];
  const d = data as Record<string, unknown>;
  // message.* envelopes nest sender on the message
  const msg = d.message;
  if (msg && typeof msg === "object") {
    const sender = (msg as { sender?: unknown }).sender;
    if (sender && typeof sender === "object") {
      candidates.push(sender as { type?: unknown; id?: unknown });
    }
  }
  // contact.* / conversation.* envelopes nest the actor on changed_by
  const changedBy = d.changed_by;
  if (changedBy && typeof changedBy === "object") {
    candidates.push(changedBy as { type?: unknown; id?: unknown });
  }
  // note.created envelope nests on note.author
  const note = d.note;
  if (note && typeof note === "object") {
    const author = (note as { author?: unknown }).author;
    if (author && typeof author === "object") {
      candidates.push(author as { type?: unknown; id?: unknown });
    }
  }

  for (const c of candidates) {
    if (c.type === "api" && typeof c.id === "string" && c.id) return c.id;
  }
  return null;
}
