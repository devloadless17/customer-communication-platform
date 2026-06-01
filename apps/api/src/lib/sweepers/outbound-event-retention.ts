import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

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
 * Cadence: daily. Same shape as the other daily sweepers; deletes in
 * bounded batches so a large backlog doesn't lock the table.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const INITIAL_DELAY_MS = 30 * 60_000; // 30min after boot — let waiting sweepers go first
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_PER_SWEEP = 20_000;
const MAX_BATCHES = 4;

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
