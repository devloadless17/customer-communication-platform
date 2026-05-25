import { db } from "@/lib/db";

/**
 * Reconciler for the `Conversation` analytics MESSAGE COUNTERS
 * (`incomingMessagesCount` / `outgoingMessagesCount`).
 *
 * Those two are maintained incrementally by
 * [conversations/analytics.ts](../conversations/analytics.ts), whose helpers
 * are fire-and-forget — they swallow + log on error so analytics bookkeeping
 * can never break a real send/assign/close. The trade-off is drift: a swallowed
 * exception (transient DB blip) leaves a counter low forever with no operator
 * signal. F3 in docs/architecture-review-2026-05-25.md.
 *
 * Scope is DELIBERATELY narrow — ONLY the two counters that re-derive EXACTLY
 * and CHEAPLY from `Message` (a plain COUNT by direction). We do NOT reconcile:
 *   - `responsesCount`       — needs replaying inbound-before-outbound ordering,
 *                              not a set-based COUNT.
 *   - `assignmentsCount`     — no per-assignment log table to count from.
 *   - `firstAssignedAt` / `firstResponseAt` — point-in-time stamps with no
 *                              cheap exact source; re-deriving would guess.
 * Reconciling those would mean either a new event-log table or a heuristic
 * replay — both over-engineering for fields that today feed only the
 * (deferred) workflow-analytics payload. If/when analytics become a
 * user-visible dashboard, revisit with a proper derivation, not a guess.
 *
 * Mirrors `contact-last-inbound-drift.ts` exactly: one set-based UPDATE, 24h,
 * NO clever self-disabling (that variant's disable-state was in-memory only and
 * reset every restart — more debug cost than the scan ever saved).
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 6 * 60 * 1000; // 6min after boot — staggered behind the contact-drift sweep (5min)

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await sweepOnce();
  } catch (err) {
    console.error(`[sweeper.analytics-drift] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startConversationAnalyticsDriftSweeper(): void {
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

export function stopConversationAnalyticsDriftSweeper(): void {
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
  // One-pass: join Conversation against per-conversation direction counts from
  // Message, update only where either denorm disagrees. COALESCE the aggregate
  // to 0 so a conversation with zero messages of a direction reconciles to 0
  // rather than being skipped. IS DISTINCT FROM is moot here (both sides are
  // non-null ints) but the COALESCE makes the "no rows" case explicit.
  const drifted = await db.$executeRaw`
    UPDATE "Conversation" conv
    SET
      "incomingMessagesCount" = sub.in_count,
      "outgoingMessagesCount" = sub.out_count
    FROM (
      SELECT
        c2.id AS conversation_id,
        COALESCE(cnt.in_count, 0) AS in_count,
        COALESCE(cnt.out_count, 0) AS out_count
      FROM "Conversation" c2
      LEFT JOIN (
        SELECT
          m."conversationId" AS conversation_id,
          COUNT(*) FILTER (WHERE m.direction = 'in') AS in_count,
          COUNT(*) FILTER (WHERE m.direction = 'out') AS out_count
        FROM "Message" m
        GROUP BY m."conversationId"
      ) cnt ON cnt.conversation_id = c2.id
    ) sub
    WHERE conv.id = sub.conversation_id
      AND (
        conv."incomingMessagesCount" <> sub.in_count
        OR conv."outgoingMessagesCount" <> sub.out_count
      )
  `;

  if (drifted > 0) {
    console.warn(
      `[sweeper.analytics-drift] reconciled ${drifted} conversation(s) with stale message counters`,
    );
  }
}
