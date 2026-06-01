import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Periodic sweep for the `ApiIdempotencyKey` table.
 *
 * Two retention rules:
 *   1. `expiresAt < now` — Stripe-style 24h TTL for completed claims plus
 *      the 5min TTL for pending claims that crashed mid-handler. Both
 *      live in the same column; we don't need to discriminate at delete time.
 *   2. Volume ceiling — bounded delete-per-tick so a large backlog after a
 *      multi-week sweeper outage doesn't lock the table.
 *
 * Without this sweeper the table grows monotonically: a partner running
 * 60 req/min × 24h retention × 365 days = ~31M rows/year per team. The
 * (expiresAt) btree index is in place; a scheduled deleteMany costs almost
 * nothing per tick at that volume.
 *
 * Cadence: hourly. Aligns with the median row's expiration shape (most
 * deletes target rows that turned stale ≥1h ago) and minimizes the window
 * where a partner sees a "stale completed" cache hit for an Idempotency-Key
 * whose response has gone past its declared 24h window.
 */

const SWEEP_INTERVAL_MS = 60 * 60_000;
const INITIAL_DELAY_MS = 15 * 60_000; // 15min after boot — let drift + webhook-delivery sweepers go first
const MAX_PER_SWEEP = 10_000;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
// In-flight guard — a large backlog could push a sweep tail past the next
// tick. Guard makes the safety contract explicit and prevents two parallel
// delete batches racing for the same rows.
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Mutex serializes the batched DELETE against other heavy sweepers.
    await withSweeperMutex("api-idempotency", sweepOnce);
  } catch (err) {
    console.error(`[sweeper.api-idempotency] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startApiIdempotencyCleanupSweeper(): void {
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

export function stopApiIdempotencyCleanupSweeper(): void {
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
  const cutoff = new Date();
  let totalDeleted = 0;
  // Bounded loop so a backlog past MAX_PER_SWEEP doesn't lock the table or
  // delay the next sweep. Each iteration is a small DELETE — Postgres holds
  // row-level locks only, no full-table lock.
  for (let i = 0; i < 4; i++) {
    const stale = await db.apiIdempotencyKey.findMany({
      where: { expiresAt: { lt: cutoff } },
      select: { id: true },
      take: MAX_PER_SWEEP,
    });
    if (stale.length === 0) break;
    const ids = stale.map((r) => r.id);
    const { count } = await db.apiIdempotencyKey.deleteMany({
      where: { id: { in: ids } },
    });
    totalDeleted += count;
    if (stale.length < MAX_PER_SWEEP) break;
  }
  if (totalDeleted > 0) {
    console.log(`[sweeper.api-idempotency] removed ${totalDeleted} expired row(s)`);
  }
}
