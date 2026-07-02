import { db } from "@/lib/db";

import { enqueueWebhookDelivery } from "@/lib/outbound-webhooks/queue";

/**
 * Recover orphaned `OutboundWebhookDelivery` rows.
 *
 * The subscriber path is:
 *   1. db.outboundWebhookDelivery.create({ ... })          ← row written
 *   2. enqueueWebhookDelivery(row.id).catch(...)            ← job enqueued
 *
 * Steps 1 + 2 are NOT in a transaction (BullMQ doesn't share Postgres state),
 * so a Redis outage / process death between them leaves the row with
 * `attemptCount=0`, no `deliveredAt`, no `failedAt`. The original code path
 * never retries this and the row is invisible to the worker — silent data
 * loss. This sweeper finds those rows and re-enqueues.
 *
 * Why 5 minutes: BullMQ-enqueued deliveries that haven't been picked up
 * yet (because the worker is backed up) ALSO have `attemptCount=0`. We
 * have to wait long enough that any in-queue delivery has been claimed
 * by the worker (which bumps attemptCount even on the first attempt at
 * `deliverOnce`). At 10 concurrency + ~10s/delivery that's 60 deliveries
 * per minute per worker; a 5-minute lag covers a 300-delivery backlog.
 * Tune via WEBHOOK_ORPHAN_GRACE_MS.
 */

const SWEEP_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 30_000;
const MAX_PER_SWEEP = 100;

function graceMs(): number {
  const raw = Number.parseInt(process.env.WEBHOOK_ORPHAN_GRACE_MS ?? "300000", 10);
  return Number.isFinite(raw) && raw >= 60_000 && raw <= 3_600_000 ? raw : 300_000;
}

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
// In-flight guard — under a backlog the Promise.allSettled tail could grow
// past the 60s tick. Without the guard, a second tick would re-enqueue the
// same orphan rows in parallel; BullMQ would coalesce by row id but we'd
// pay double the Redis writes. Explicit flag is cheaper.
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await sweepOnce();
  } catch (err) {
    console.error(`[sweeper.orphan-webhook-delivery] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startOrphanWebhookDeliverySweeper(): void {
  if (timer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runTick("initial sweep");
    timer = setInterval(() => {
      void runTick("sweep");
    }, SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
}

export function stopOrphanWebhookDeliverySweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - graceMs());
  const orphans = await db.outboundWebhookDelivery.findMany({
    where: {
      attemptCount: 0,
      deliveredAt: null,
      failedAt: null,
      createdAt: { lt: cutoff },
    },
    // minor#8: pull the persisted chainDepth so the re-enqueue preserves the
    // cross-system loop-guard counter instead of resetting it to 1 on recovery.
    // Also pull the owning teamId so the re-enqueued job carries it (worker's
    // per-team gate then needs no DB lookup) — cheap here, we're already
    // reading the row.
    select: { id: true, chainDepth: true, webhook: { select: { teamId: true } } },
    take: MAX_PER_SWEEP,
    orderBy: { createdAt: "asc" },
  });
  if (orphans.length === 0) return;

  // Re-enqueue in parallel — each is an independent Redis write and the
  // queue's own idempotency (we never see the same row twice with attempt=0
  // after the worker picks it up) keeps this safe under double-runs.
  const results = await Promise.allSettled(
    orphans.map((o) => enqueueWebhookDelivery(o.id, o.chainDepth, o.webhook.teamId)),
  );
  const recovered = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - recovered;
  console.log(
    `[sweeper.orphan-webhook-delivery] recovered ${recovered} orphan deliveries` +
      (failed > 0 ? ` (${failed} re-enqueue failures)` : ""),
  );
}
