import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Retention sweeper for the `Notification` bell table.
 *
 * The schema's `@@index([userId, workspaceId, readAt])` comment promised "the
 * badge count, and the retention sweep" — but the sweep was never built
 * (audit 2026-08-10), so rows were append-only forever: one per event × the
 * ticket audience (typically 2–6 people), reclaimed only by the rare
 * owner-only ticket delete. A busy escalated ticket alone is ~150 rows that
 * never go away.
 *
 * Retention policy: delete READ rows older than the cutoff. A read
 * notification is a delivered courtesy — the bell renders the newest 100 and
 * the ticket timeline is the durable history, so an old read row serves
 * nobody. UNREAD rows are kept 4× longer (then swept too): an unread bell
 * entry is the one thing telling a returning-from-leave agent what happened,
 * but past that horizon it is stale noise pointing at work someone else
 * finished. Tunable via NOTIFICATION_RETENTION_DAYS (default 30; unread =
 * 4× that).
 *
 * Cadence: daily, batched, bounded — mirrors conversation-event-retention.
 * The `[userId, workspaceId, readAt]` index doesn't lead on createdAt, so the
 * scan uses the pk-batched findMany/deleteMany shape the sibling sweepers use.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
// 50min after boot — unique slot behind conversation-event-retention (40min)
// and webchat-visitor-retention (45min); shared expiries collide on the mutex.
const INITIAL_DELAY_MS = 50 * 60_000;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_PER_SWEEP = 20_000;
const MAX_BATCHES = 4;

function retentionMs(): number {
  const raw = Number.parseInt(process.env.NOTIFICATION_RETENTION_DAYS ?? "", 10);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
  return days * 24 * 60 * 60_000;
}

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("notification-retention", sweepNotificationRetentionOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is over.
    if (isPoolClosedError(err)) {
      stopNotificationRetentionSweeper();
      return;
    }
    console.error(`[sweeper.notification-retention] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startNotificationRetentionSweeper(): void {
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

export function stopNotificationRetentionSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Exported for tests, matching the sibling sweepers' convention. */
export async function sweepNotificationRetentionOnce(): Promise<void> {
  const readCutoff = new Date(Date.now() - retentionMs());
  const unreadCutoff = new Date(Date.now() - 4 * retentionMs());
  let totalDeleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const stale = await db.notification.findMany({
      where: {
        OR: [
          { readAt: { not: null }, createdAt: { lt: readCutoff } },
          { readAt: null, createdAt: { lt: unreadCutoff } },
        ],
      },
      select: { id: true },
      take: MAX_PER_SWEEP,
    });
    if (stale.length === 0) break;
    const { count } = await db.notification.deleteMany({
      where: { id: { in: stale.map((r) => r.id) } },
    });
    totalDeleted += count;
    if (stale.length < MAX_PER_SWEEP) break;
  }
  if (totalDeleted > 0) {
    console.log(
      `[sweeper.notification-retention] removed ${totalDeleted} bell row(s) (read > ${retentionMs() / 86_400_000}d, unread > ${(4 * retentionMs()) / 86_400_000}d)`,
    );
  }
}
