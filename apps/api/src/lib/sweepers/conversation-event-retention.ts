import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Retention sweeper for the `ConversationEvent` audit-timeline table.
 *
 * Append-only: one row per assign / status / tag / stage / note change on a
 * conversation, forever ([prisma/schema.prisma] ConversationEvent). It cascades
 * on conversation delete, so it's bounded by live conversations — but on an
 * active account it's the fastest-growing audit surface after `Message`. Every
 * other high-churn table has a retention sweep; this one was the gap (N2 in
 * tests/VERIFICATION-2026-07-29.md).
 *
 * Retention policy: delete rows older than the cutoff — with ONE carve-out:
 * `kind = 'assigned'` rows are kept forever. They are the assignment ledger
 * behind the team report's "conversations assigned per agent" aggregate
 * (lib/analytics/team-report.ts); the max report range (90d) equals the
 * default retention window, so sweeping them would undercount exactly at the
 * range edge. They're tiny and low-volume, so exempting them is cheaper than
 * a second table. Everything else is a past-tense audit fact the history
 * panel only reads recently; a 90-day window keeps "who closed this last
 * quarter" answerable without unbounded growth. Tunable via
 * CONVERSATION_EVENT_RETENTION_DAYS (default 90).
 *
 * Cadence: daily, batched, bounded — a large backlog can't lock the table.
 * Mirrors outbound-event-retention.ts. Uses the `@@index([at])` added alongside
 * this sweeper so the cutoff scan is index-driven, not a seq scan (the existing
 * [conversationId, at] index leads with conversationId and can't serve an
 * at-only filter).
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
// 40min after boot — staggered behind outbound-event-retention (30min). NOT 35min:
// workflow-run-retention already owns 35min and shares this file's 24h cadence, so a
// shared expiry makes them collide deterministically every day and the mutex-loser
// (this sweep) can be starved out once the WorkflowRun delete runs long. Unique slot.
const INITIAL_DELAY_MS = 40 * 60_000;
const DEFAULT_RETENTION_DAYS = 90;
const MAX_PER_SWEEP = 20_000;
const MAX_BATCHES = 4;

function retentionMs(): number {
  const raw = Number.parseInt(process.env.CONVERSATION_EVENT_RETENTION_DAYS ?? "", 10);
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
    // Mutex serializes batched DELETE against other heavy sweepers.
    await withSweeperMutex(
      "conversation-event-retention",
      sweepConversationEventRetentionOnce,
    );
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopConversationEventRetentionSweeper();
      return;
    }
    console.error(`[sweeper.conversation-event-retention] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startConversationEventRetentionSweeper(): void {
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

export function stopConversationEventRetentionSweeper(): void {
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
export async function sweepConversationEventRetentionOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - retentionMs());
  let totalDeleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const stale = await db.conversationEvent.findMany({
      // `assigned` rows are exempt: they are the permanent assignment ledger
      // the team report's "conversations assigned per agent" aggregate reads
      // (lib/analytics/team-report.ts). Deleting them past the 90d horizon
      // would silently undercount a 90d report range. Tiny, low-volume rows.
      where: { at: { lt: cutoff }, kind: { not: "assigned" } },
      select: { id: true },
      take: MAX_PER_SWEEP,
    });
    if (stale.length === 0) break;
    const ids = stale.map((r) => r.id);
    const { count } = await db.conversationEvent.deleteMany({
      where: { id: { in: ids } },
    });
    totalDeleted += count;
    if (stale.length < MAX_PER_SWEEP) break;
  }
  if (totalDeleted > 0) {
    console.log(
      `[sweeper.conversation-event-retention] removed ${totalDeleted} timeline row(s) older than ${retentionMs() / 86_400_000}d`,
    );
  }
}
