import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Nightly cleanup for `OutboundWebhookDelivery` rows.
 *
 * Every delivery — successful, failed, retried — persists a row so the
 * settings UI can render the per-webhook delivery log + the "Retry" button
 * has something to re-fire. Without a TTL the table grows unbounded: a busy
 * team at ~10k message events / month × N webhooks × 4 retries-worst-case
 * adds up to millions of rows over a year. Most of those are unread debug
 * artifacts a week after they landed.
 *
 * Cadence: 24h. Cheap enough to run unconditionally — a single set-based
 * deleteMany against an indexed `createdAt < cutoff` predicate. An earlier
 * variant self-disabled after a quiet week to save the daily scan, but the
 * disable state lived in-memory only (reset on every restart) so the
 * savings were illusory, and the extra state machine cost more in debug
 * time than the scan ever cost in DB time.
 *
 * Retention: 30 days. Longer than Stripe's 30-day "Events" tab is fine if
 * a partner asks, but most debugging happens within hours of the failure.
 * Override via `WEBHOOK_DELIVERY_RETENTION_DAYS` if a customer asks.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 60 * 1000; // 10min after boot so workflow + drift sweepers don't dogpile

function retentionDays(): number {
  const raw = Number.parseInt(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS ?? "30", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 365 ? raw : 30;
}

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
// In-flight guard — explicit safety so a large backlog deleteMany can't
// overlap with the next tick if the table is huge.
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Serialize through the shared sweeper mutex so this nightly deleteMany
    // can't pile pool pressure on top of the other heavy sweepers.
    await withSweeperMutex("outbound-webhook-delivery-cleanup", sweepOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopOutboundWebhookDeliveryCleanup();
      return;
    }
    console.error(`[sweeper.webhook-delivery-cleanup] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startOutboundWebhookDeliveryCleanup(): void {
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

export function stopOutboundWebhookDeliveryCleanup(): void {
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
  const cutoff = new Date(Date.now() - retentionDays() * 24 * 60 * 60 * 1000);
  const { count } = await db.outboundWebhookDelivery.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  if (count > 0) {
    console.log(
      `[sweeper.webhook-delivery-cleanup] removed ${count} rows older than ${retentionDays()}d`,
    );
  }
}
