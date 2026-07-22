import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Retention sweeper for the `OutboundEvent` (event-bus outbox) table.
 *
 * Without this table grows unboundedly: every domain-event publish writes
 * one row, every active team produces ~10-100 events/hour, every active
 * minute of a busy team produces tens of rows. At pilot scale that's
 * fine; at month 2 the partial index degrades and the table dominates
 * pg_dump size.
 *
 * Retention policy:
 *   - publishedAt NOT NULL AND createdAt < cutoff  → safe to delete
 *     (subscribers already ran, audit row served its purpose)
 *   - failedAt NOT NULL                            → KEEP (operator triage)
 *   - publishedAt NULL AND failedAt NULL            → KEEP (the drainer
 *     will pick this up; deleting could lose an event)
 *
 * Cutoff: 7 days. Matches the BullMQ removeOnFail window so the operator's
 * "what happened in the last week" investigation surface is consistent
 * across the queue + bus.
 *
 * Cadence: hourly, draining the full backlog each tick. The platform's primary
 * workload — broadcast campaigns — produces 250k-350k outbox rows per 100k
 * recipients (one `broadcast.recipient_message_sent` per send + status frames).
 * The old daily×4-batch ceiling deleted at most 80k rows/day, so a single day's
 * campaigns outran retention and the table grew without bound. The per-batch
 * 20k findMany+deleteMany still bounds lock time, and the sweeper mutex
 * serializes this against the other heavy sweepers, so looping to empty is safe.
 * MAX_BATCHES is now a large runaway-backstop, not the steady-state limit.
 */

const SWEEP_INTERVAL_MS = 60 * 60_000; // hourly
const INITIAL_DELAY_MS = 30 * 60_000; // 30min after boot — let waiting sweepers go first
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_PER_SWEEP = 20_000;
const MAX_BATCHES = 2_000; // safety backstop only (≤40M rows/tick); normal draining stops at empty

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Mutex serializes batched-DELETE retention against other heavy sweepers.
    await withSweeperMutex("outbound-event-retention", sweepOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopOutboundEventRetentionSweeper();
      return;
    }
    console.error(`[sweeper.outbound-event-retention] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startOutboundEventRetentionSweeper(): void {
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

export function stopOutboundEventRetentionSweeper(): void {
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
  const cutoff = new Date(Date.now() - RETENTION_MS);
  let totalDeleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const stale = await db.outboundEvent.findMany({
      where: {
        publishedAt: { not: null, lt: cutoff },
        failedAt: null,
        // EVT-2: only GC rows that FULLY dispatched. A row with publishedAt set
        // but dispatchedAt NULL is the hard-crash-mid-dispatch loss-window
        // signal (see the OutboundEvent.dispatchedAt doc) — keep it for operator
        // forensics instead of silently reaping the very evidence of a lost
        // fan-out after 7 days.
        dispatchedAt: { not: null },
      },
      select: { id: true },
      take: MAX_PER_SWEEP,
    });
    if (stale.length === 0) break;
    const ids = stale.map((r) => r.id);
    const { count } = await db.outboundEvent.deleteMany({
      where: { id: { in: ids } },
    });
    totalDeleted += count;
    if (stale.length < MAX_PER_SWEEP) break;
  }
  if (totalDeleted > 0) {
    console.log(
      `[sweeper.outbound-event-retention] removed ${totalDeleted} published row(s) older than ${RETENTION_MS / 86_400_000}d`,
    );
  }
}
