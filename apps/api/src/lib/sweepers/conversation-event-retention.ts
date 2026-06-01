import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Retention sweeper for the `ConversationEvent` audit-timeline table.
 *
 * Append-only: one row per assign / status / tag / stage / note change on a
 * conversation, forever ([prisma/schema.prisma] ConversationEvent). It cascades
 * on conversation delete, so it's bounded by live conversations — but on an
 * active account it's the fastest-growing audit surface after `Message`. Every
 * other high-churn table has a retention sweep; this one was the gap (N2 in
 * docs/architecture-review-2026-05-25-pass2.md).
 *
 * Retention policy: delete rows older than the cutoff, full stop. Unlike the
 * outbox sweep there's no "keep failed rows" carve-out — every row is a
 * past-tense audit fact, not a pending work item. The history panel that reads
 * these only ever shows recent activity; a 90-day window keeps "who closed this
 * last quarter" answerable without unbounded growth. Tunable via
 * CONVERSATION_EVENT_RETENTION_DAYS (default 90).
 *
 * Cadence: daily, batched, bounded — a large backlog can't lock the table.
 * Mirrors outbound-event-retention.ts. Uses the `@@index([at])` added alongside
 * this sweeper so the cutoff scan is index-driven, not a seq scan (the existing
 * [conversationId, at] index leads with conversationId and can't serve an
 * at-only filter).
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const INITIAL_DELAY_MS = 35 * 60_000; // 35min after boot — staggered behind outbound-event-retention (30min)
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
    await withSweeperMutex("conversation-event-retention", sweepOnce);
  } catch (err) {
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

async function sweepOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - retentionMs());
  let totalDeleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const stale = await db.conversationEvent.findMany({
      where: { at: { lt: cutoff } },
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
