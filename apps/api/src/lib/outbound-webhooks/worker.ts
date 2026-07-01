// Outbound-webhook delivery worker. Sibling to lib/workflows/worker.ts —
// both are framework-agnostic BullMQ consumers. The NestJS lifecycle
// harness (OutboundWebhookWorkerService) starts/stops this on module
// init/destroy so worker.close() can drain the in-flight HTTP request
// before the process exits.

import { DelayedError, Worker, type Job } from "bullmq";
import type IORedis from "ioredis";

import {
  WEBHOOK_DELIVER_QUEUE_NAME,
  createWebhookWorkerConnection,
  type WebhookDeliverJobData,
} from "./queue";
import { toExternalMediaUrl } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { recordJobFailure } from "@/common/job-failure-metrics";
import { decryptSecret } from "@/lib/crypto/envelope";
import { publish } from "@/lib/events/bus";
import { safeFetch, SsrfBlockedError, readLimitedBody } from "@/lib/http/safe-fetch";

import { signWebhookBody, WEBHOOK_WIRE_VERSION } from "./signing";

const DEFAULT_TIMEOUT_MS = 10_000;

// BullMQ lock the worker holds for an in-flight delivery. Must exceed
// DEFAULT_TIMEOUT_MS by a safety margin so the fetch can run to its full
// budget without the lock expiring mid-flight (which would re-deliver to
// the partner). Matches the workflow worker pattern (step timeout + 10s
// margin). Bumped previously to 120s out of an abundance of caution about
// DB-contention tail latency; 30s is sufficient because the per-row update
// path is single-row and capped — observed tail is well under 5s. The drain
// cap below must exceed this so an in-flight delivery's lock has expired
// before the process exits.
const WEBHOOK_LOCK_DURATION_MS = 30_000;
const WEBHOOK_LOCK_MARGIN_MS = 10_000;
// Hard ceiling on `worker.close()` during graceful shutdown. Set above the
// lock duration (with a small safety margin) so that when close returns,
// any in-flight job's BullMQ lock has already expired and another worker can
// re-claim it cleanly after restart — without us shipping a duplicate POST.
// Must stay well under api's compose `stop_grace_period: 100s` so the rest
// of onModuleDestroy still runs before SIGKILL.
const WEBHOOK_CLOSE_TIMEOUT_MS = 45_000;

if (WEBHOOK_LOCK_DURATION_MS <= DEFAULT_TIMEOUT_MS + WEBHOOK_LOCK_MARGIN_MS) {
  throw new Error(
    `[webhooks] WEBHOOK_LOCK_DURATION_MS (${WEBHOOK_LOCK_DURATION_MS}) must exceed ` +
      `DEFAULT_TIMEOUT_MS (${DEFAULT_TIMEOUT_MS}) + ${WEBHOOK_LOCK_MARGIN_MS}ms margin. ` +
      `A delivery that runs to its fetch timeout would outlive the lock and ` +
      `get re-delivered, causing a duplicate POST to the partner.`,
  );
}
if (WEBHOOK_CLOSE_TIMEOUT_MS <= WEBHOOK_LOCK_DURATION_MS) {
  throw new Error(
    `[webhooks] WEBHOOK_CLOSE_TIMEOUT_MS (${WEBHOOK_CLOSE_TIMEOUT_MS}) must exceed ` +
      `WEBHOOK_LOCK_DURATION_MS (${WEBHOOK_LOCK_DURATION_MS}) so an in-flight ` +
      `delivery's lock has expired by the time the worker closes; otherwise ` +
      `another worker may re-claim the still-locked job after restart.`,
  );
}

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

// Inbound media uploads asynchronously (meta.controller commits the message as
// media-pending and the binary lands a beat later — see completePendingMedia),
// so a message.received payload built at arrival can carry media.url=null. The
// worker re-resolves it from the row at SEND time, briefly polling while the
// background upload is still in flight.
const MEDIA_RESOLVE_WAIT_MS = 4000;
const MEDIA_RESOLVE_POLL_MS = 400;

interface WorkerGlobals {
  worker?: Worker<WebhookDeliverJobData>;
  connection?: IORedis;
  shuttingDown?: boolean;
}
const g = globalThis as unknown as { __ccpWebhookWorker?: WorkerGlobals };
const state: WorkerGlobals = (g.__ccpWebhookWorker ??= {});

function concurrency(): number {
  const raw = Number.parseInt(process.env.WEBHOOK_WORKER_CONCURRENCY ?? "10", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 10;
}

/**
 * Per-team in-process concurrency cap — same model as the workflow worker
 * (lib/workflows/worker.ts). One team whose partner endpoint is slow or
 * hanging at the request timeout would otherwise pin every global delivery
 * slot and starve every other team's deliveries. With this gate, a team at
 * cap has its extra jobs deferred (moveToDelayed + DelayedError) so the
 * BullMQ slot frees immediately for other teams.
 *
 * Tunable via WEBHOOK_PER_TEAM_CONCURRENCY (default 3 — a little looser than
 * workflows' 2 because deliveries are independent single-fetch jobs, not
 * multi-step runs, but tighter than the global cap so no single team can
 * monopolize the 10-lane pool). Across-PROCESS fairness needs Redis-backed
 * counters (deferred — single-process pilot). Inside one process this is exact.
 *
 * Starvation signal: each team-at-cap defer increments a per-team counter.
 * When the counter crosses TEAM_DEFER_BURST_WARN inside the warn window, we
 * log a structured warning so an operator can see "this team's webhook
 * receiver is too slow / cap too low" without grepping for moveToDelayed
 * patterns. The counter decays on every successful acquire so it tracks
 * pressure, not lifetime defers.
 */
function perTeamConcurrency(): number {
  const raw = Number.parseInt(process.env.WEBHOOK_PER_TEAM_CONCURRENCY ?? "3", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 3;
}

/** Delay before re-picking up a deferred (team-at-cap) delivery. */
const TEAM_BUSY_DEFER_MS = 250;

/** Burst of consecutive defers within the warn window that triggers the log. */
const TEAM_DEFER_BURST_WARN = 50;
/** Throttle window for the starvation warn log so it doesn't spam stdout. */
const TEAM_DEFER_WARN_INTERVAL_MS = 30_000;

interface TeamSlotState {
  /** In-flight deliveries for this team. */
  active: number;
  /** Count of consecutive defers since the last successful acquire. */
  consecutiveDefers: number;
  /** Last time we logged a starvation warning for this team. */
  lastWarnAt: number;
}
const teamSlots = new Map<string, TeamSlotState>();

function tryAcquireTeamSlot(teamId: string): boolean {
  const cap = perTeamConcurrency();
  let entry = teamSlots.get(teamId);
  if (!entry) {
    entry = { active: 0, consecutiveDefers: 0, lastWarnAt: 0 };
    teamSlots.set(teamId, entry);
  }
  if (entry.active >= cap) {
    entry.consecutiveDefers += 1;
    if (entry.consecutiveDefers >= TEAM_DEFER_BURST_WARN) {
      const now = Date.now();
      if (now - entry.lastWarnAt > TEAM_DEFER_WARN_INTERVAL_MS) {
        entry.lastWarnAt = now;
        console.warn(
          `[webhooks] team ${teamId} starving on delivery slots: ${entry.consecutiveDefers} consecutive defer(s), cap=${cap}`,
        );
      }
    }
    return false;
  }
  entry.consecutiveDefers = 0;
  entry.active += 1;
  return true;
}

function releaseTeamSlot(teamId: string): void {
  const entry = teamSlots.get(teamId);
  if (!entry) return;
  entry.active = Math.max(0, entry.active - 1);
  // minor#7: GC once NO deliveries are in flight, regardless of the defer
  // counter. consecutiveDefers only matters during active contention (it's reset
  // to 0 on every successful acquire); once active hits 0 there's no starvation
  // to track and the next delivery acquires immediately. The old `&&
  // consecutiveDefers === 0` guard leaked a grow-only map entry for any team
  // that went idle right after a defer (active drained to 0 while the counter
  // was still > 0). A later acquire re-creates the entry fresh.
  if (entry.active === 0) {
    teamSlots.delete(teamId);
  }
}

export function startWebhookDeliverWorker(): Worker<WebhookDeliverJobData> {
  if (state.worker) return state.worker;
  state.shuttingDown = false;

  // Dedicated blocking connection (NOT the shared producer) — see
  // createWorkerConnection in lib/workflows/queue.ts.
  const connection = createWebhookWorkerConnection("webhooks-worker");
  state.connection = connection;

  const worker = new Worker<WebhookDeliverJobData>(
    WEBHOOK_DELIVER_QUEUE_NAME,
    async (job: Job<WebhookDeliverJobData>, token?: string) => {
      // Per-team concurrency gate. Resolve the owning team from the delivery
      // row (single indexed read; the job payload only carries deliveryId).
      const owner = await db.outboundWebhookDelivery.findUnique({
        where: { id: job.data.deliveryId },
        select: { webhook: { select: { teamId: true } } },
      });
      if (!owner) {
        // Row deleted between enqueue and pickup (webhook revoked). deliverOnce
        // handles this too, but bail early so we don't claim a team slot for a
        // no-op.
        return;
      }
      const teamId = owner.webhook.teamId;
      if (!tryAcquireTeamSlot(teamId)) {
        // Team at cap — defer this delivery and free the BullMQ slot for other
        // teams' work. moveToDelayed + DelayedError doesn't count against
        // `attempts`.
        if (token) {
          await job.moveToDelayed(Date.now() + TEAM_BUSY_DEFER_MS, token);
        }
        throw new DelayedError();
      }
      try {
        // attemptsMade is 0 on first run; deliverOnce wants 1-indexed.
        // job.opts.attempts comes from the queue default (currently 4).
        const attempt = job.attemptsMade + 1;
        const maxAttempts = job.opts.attempts ?? 1;
        await deliverOnce(
          job.data.deliveryId,
          attempt,
          maxAttempts,
          job.data.chainDepth ?? 0,
        );
      } finally {
        releaseTeamSlot(teamId);
      }
    },
    {
      connection,
      concurrency: concurrency(),
      // Lock duration = DEFAULT_TIMEOUT_MS (10s fetch) + 10s margin, asserted
      // above. lockRenewTime stays at 10s (1/3 of lockDuration, BullMQ's
      // recommended ratio) so a healthy worker still extends mid-flight.
      lockDuration: WEBHOOK_LOCK_DURATION_MS,
      lockRenewTime: 10_000,
      // Explicit stalled-check tuning. See workflows/worker.ts for the
      // full rationale — same posture applied to every BullMQ worker so
      // a transient lock-renewal blip doesn't fail the delivery (and
      // double-POST the partner on retry).
      stalledInterval: 30_000,
      maxStalledCount: 3,
    },
  );

  worker.on("failed", (job, err) => {
    console.warn(
      `[webhooks] delivery ${job?.id} failed (attempt ${job?.attemptsMade}/${
        job?.opts.attempts ?? 1
      }): ${err.message}`,
    );
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      recordJobFailure("webhook-deliver", job.id, err.message);
    }
  });

  worker.on("error", (err) => {
    console.error("[webhooks] worker error", err);
    // Fatal classes (Redis socket closed, auth) leave the worker wedged with
    // state.worker still set. Close + null the slot and self-respawn on a delay
    // so deliveries resume without operator intervention — the workflow worker
    // is re-armed by its sweeper; this one has none, so it re-arms itself.
    // Skipped during shutdown so it doesn't fight stop().
    const msg = err instanceof Error ? err.message : String(err);
    const fatal =
      msg.includes("Connection is closed") ||
      msg.includes("WRONGPASS") ||
      msg.includes("NOAUTH");
    if (fatal && !state.shuttingDown) {
      console.warn("[webhooks] worker entered unrecoverable state; re-spawning");
      worker.close().catch(() => undefined);
      connection.disconnect();
      state.worker = undefined;
      state.connection = undefined;
      setTimeout(() => {
        if (!state.shuttingDown) startWebhookDeliverWorker();
      }, 1_000).unref();
    }
  });

  state.worker = worker;
  console.log(`[webhooks] delivery worker started, concurrency=${concurrency()}`);
  return worker;
}

export async function stopWebhookDeliverWorker(): Promise<void> {
  state.shuttingDown = true;
  if (!state.worker) return;
  // Hard cap on `worker.close()` — same posture as the workflow + send workers
  // (workflows/worker.ts, messages/send-worker.service.ts). onModuleDestroy
  // hooks run SEQUENTIALLY across modules, so each worker's drain is additive
  // toward compose's `stop_grace_period: 100s` on the api service; an uncapped
  // close here (e.g. a partner endpoint hanging) could push the total past
  // 100s and force a SIGKILL mid-drain, which re-runs the in-flight job after
  // restart (duplicate webhook POST). BullMQ's lockDuration is
  // WEBHOOK_LOCK_DURATION_MS (30s), so past WEBHOOK_CLOSE_TIMEOUT_MS (45s) the
  // lock is already lost and another worker can pick it up cleanly. The
  // close-cap > lock-duration invariant is asserted at boot.
  const closeTimeoutMs = WEBHOOK_CLOSE_TIMEOUT_MS;
  await Promise.race([
    state.worker.close(),
    new Promise<void>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `[webhooks] worker.close() exceeded ${closeTimeoutMs}ms — abandoning drain so process can exit before SIGKILL`,
            ),
          ),
        closeTimeoutMs,
      ).unref(),
    ),
  ]).catch((err) => {
    // Log but don't re-throw — let the rest of shutdown (connection close)
    // still run.
    console.error(err instanceof Error ? err.message : err);
  });
  // Close the worker's dedicated blocking connection (BullMQ doesn't, since we
  // handed it the instance). disconnect() is synchronous + can't hang.
  state.connection?.disconnect();
  state.connection = undefined;
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
  chainDepth: number,
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
  // minor#6: a manual TEST fire must POST even when the breaker auto-disabled
  // the webhook — that's exactly when the operator clicks "Test" (after fixing
  // their endpoint, to verify before re-enabling). Skipping it left the Test a
  // silent no-op. A passing test resets consecutiveFailures (success path below)
  // but does NOT re-enable — the operator still flips that explicitly. Real
  // (non-test) deliveries to a disabled webhook still no-op as before.
  const isTest = (delivery.payload as { test?: boolean } | null)?.test === true;
  if (!webhook.enabled && !isTest) {
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

  // Inbound media uploads async, so a message.received payload built at arrival
  // can carry media.url=null. Fill it from the row now (the background upload
  // has almost always finished by delivery time); defer to a BullMQ retry if a
  // large file is still uploading. Mutates delivery.payload in place.
  await resolvePendingMediaUrl(delivery.payload, attempt, maxAttempts);

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
        "X-CCP-Webhook-Version": String(WEBHOOK_WIRE_VERSION),
        "X-CCP-Signature": signature,
        // Cross-system loop guard. This delivery is one hop beyond the request
        // that caused it (chainDepth), so stamp depth+1. A partner that bounces
        // our webhook back into /v1 is expected to forward this header; the /v1
        // controller rejects at MAX_CHAIN_DEPTH (8), breaking the loop after a
        // bounded number of round-trips even if the partner ignores the
        // X-CCP-Origin-Key hint below.
        "X-CCP-Depth": String(chainDepth + 1),
        ...(originApiKeyId ? { "X-CCP-Origin-Key": originApiKeyId } : {}),
        // Correlation id of the request that caused this delivery, so a partner
        // can echo it back / log it and we can join their failure to our
        // originating request. Absent when the source event had no HTTP scope.
        ...(delivery.correlationId ? { "X-CCP-Trace-Id": delivery.correlationId } : {}),
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
    // A TRANSIENT SSRF block (dns-failure: resolver hiccup / not-yet-propagated
    // record on a healthy public host) must behave like any other transient
    // network error — re-throw so BullMQ retries, and do NOT bump the breaker
    // toward auto-disable. Only PERMANENT SSRF blocks (private range, bad
    // scheme, embedded creds, redirect policy) are pointless to retry (owh-4).
    const isTransientSsrf = isSsrf && (err as SsrfBlockedError).transient;
    const isPermanentSsrf = isSsrf && !isTransientSsrf;
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (isTransientSsrf) {
      // Let BullMQ's retry policy handle it; record non-final (no breaker bump).
      // If the host is genuinely dead the retries exhaust and the final attempt
      // records as final below on the last pass (attempt >= maxAttempts).
      const isFinal = attempt >= maxAttempts;
      await recordFailure(
        delivery.id,
        webhook.id,
        attempt,
        null,
        null,
        errorMessage,
        isFinal,
      );
      throw err;
    }
    // Permanent SSRF rejections (or a genuinely-exhausted retry) are final —
    // one breaker bump, then return (no BullMQ retry for permanent blocks).
    const isFinal = isPermanentSsrf || attempt >= maxAttempts;
    await recordFailure(
      delivery.id,
      webhook.id,
      attempt,
      null,
      null,
      errorMessage,
      isFinal,
    );
    if (isPermanentSsrf) return;
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
    // minor#6 follow-up: a Test on a still-DISABLED webhook records ONLY its own
    // delivery outcome — it must NOT reset the breaker or publish
    // subscription_recovered. Doing so flipped the settings UI to
    // enabled/"recovered" (the client's onRecovered handler) while the DB row
    // stayed disabled and real deliveries kept no-op'ing. The operator
    // re-enables explicitly.
    const isDisabledTest = isTest && !webhook.enabled;
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
          // Persist the as-sent payload so the delivery log matches what the
          // receiver got (media.url was resolved at send time, above).
          payload: delivery.payload as unknown as Parameters<
            typeof db.outboundWebhookDelivery.update
          >[0]["data"]["payload"],
        },
      }),
      // Breaker reset skipped for a disabled Test (isDisabledTest) — see above.
      ...(isDisabledTest
        ? []
        : [
            db.outboundWebhook.update({
              where: { id: webhook.id },
              data: {
                lastDeliveredAt: new Date(),
                lastErrorAt: null,
                lastErrorMessage: null,
                consecutiveFailures: 0,
              },
            }),
          ]),
    ]);
    if (!isDisabledTest && priorFailures > 0) {
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

/**
 * Fill `media.url` + `media.thumbnail_url` on a message-bearing payload from the
 * message row at SEND time. Inbound media uploads asynchronously, so the payload
 * built when the message arrived can carry `media.url=null`; by delivery time
 * the background upload has almost always finished. Briefly polls while it's
 * still in flight, then defers to a BullMQ retry for an unusually slow upload
 * (large video). Mutates `payload` in place; no-op when there's no media or the
 * url is already set (e.g. outbound sends, whose media is uploaded before the
 * row is created).
 */
async function resolvePendingMediaUrl(
  payload: unknown,
  attempt: number,
  maxAttempts: number,
): Promise<void> {
  const message = (
    payload as {
      message?: {
        // Flat wire block (wireMessageBlock) keys the internal id as `messageId`,
        // NOT `id` — reading `id` here always yielded undefined and short-circuited
        // the poll, leaving slow-upload media permanently null.
        messageId?: string;
        media?: { url?: string | null; thumbnail_url?: string | null } | null;
      };
    }
  )?.message;
  const media = message?.media;
  const messageId = message?.messageId;
  if (!media || !messageId || media.url) return;

  const deadline = Date.now() + MEDIA_RESOLVE_WAIT_MS;
  for (;;) {
    const row = await db.message.findUnique({
      where: { id: messageId },
      select: { mediaUrl: true, mediaThumbnailUrl: true, mediaKind: true },
    });
    if (row?.mediaUrl) {
      // The stored url points at the PRIVATE R2 bucket (403 for the webhook
      // receiver). Presign both the media + thumbnail into fetchable URLs so an
      // external consumer can actually download the attachment (legacy/foreign
      // urls pass through untouched). See toExternalMediaUrl.
      const [signedUrl, signedThumb] = await Promise.all([
        toExternalMediaUrl(row.mediaUrl),
        toExternalMediaUrl(row.mediaThumbnailUrl),
      ]);
      // Defensive shallow-copy of the media object before mutating: replace the
      // reference on `message.media` rather than rewriting the existing object
      // in place. BullMQ retry is already idempotent (we re-read delivery.payload
      // on each attempt), but if a future caller ever shares the payload
      // reference, in-place mutation here would leak through unexpectedly.
      message!.media = { ...media, url: signedUrl, thumbnail_url: signedThumb ?? media.thumbnail_url ?? null };
      return;
    }
    // mediaKind cleared → the download failed and the message fell back to
    // text-only; there will never be a url, so send the documented null.
    if (!row || !row.mediaKind) return;
    if (Date.now() >= deadline) {
      // Still uploading (large file). Let a BullMQ retry pick up the url within
      // the backoff window; on the final attempt, send null rather than loop.
      if (attempt < maxAttempts) {
        throw new Error(
          `media still uploading for message ${messageId}; deferring delivery`,
        );
      }
      return;
    }
    await new Promise((r) => setTimeout(r, MEDIA_RESOLVE_POLL_MS));
  }
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
 * Pull the originating API-key id out of a delivered webhook payload, if any.
 *
 * `delivery.payload` is the FLAT wire shape produced by `toWirePayload`
 * (NOT the internal enveloped `PublicEnvelope`), so the api-key id lives on:
 *   - message.sent:     `payload.sender.apiKeyId`  (wireSender, type "api")
 *   - message.received: never api-keyed (contact sender → apiKeyId null)
 *   - contact.*:        flat `payload.changedByApiKeyId` / `createdByApiKeyId`
 *                       / `deletedByApiKeyId`
 *   - conversation.*:   flat `payload.changedByApiKeyId`
 *   - note.created:     no api-key origin on the wire today
 *
 * Returns null on any shape we don't recognize — the partner just won't get
 * the loop-detection header, no harm done. The structure checks are defensive:
 * a malformed payload must not tank delivery with a TypeError.
 *
 * NOTE: this MUST stay in lockstep with `toWirePayload` / `wireSender` in
 * packages/shared/src/outbound-webhooks/public-events.ts — the prior version
 * read the old enveloped shape (`data.message.sender.{type,id}`) and so
 * silently always returned null after the flat-wire migration.
 */
function extractOriginApiKeyId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  // message.* — wireSender carries the api key id on `sender.apiKeyId`.
  const sender = p.sender;
  if (sender && typeof sender === "object") {
    const id = (sender as { apiKeyId?: unknown }).apiKeyId;
    if (typeof id === "string" && id) return id;
  }

  // contact.* / conversation.* — flat top-level *ApiKeyId fields.
  for (const key of ["changedByApiKeyId", "createdByApiKeyId", "deletedByApiKeyId"] as const) {
    const v = p[key];
    if (typeof v === "string" && v) return v;
  }

  return null;
}
