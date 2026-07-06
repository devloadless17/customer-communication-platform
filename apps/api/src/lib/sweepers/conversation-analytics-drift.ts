import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Reconciler for the `Conversation` analytics MESSAGE COUNTERS
 * (`incomingMessagesCount` / `outgoingMessagesCount`).
 *
 * Those two are maintained incrementally by
 * [conversations/analytics.ts](../conversations/analytics.ts), whose helpers
 * are fire-and-forget — they swallow + log on error so analytics bookkeeping
 * can never break a real send/assign/close. The trade-off is drift: a swallowed
 * exception (transient DB blip) leaves a counter low forever with no operator
 * signal. F3 in docs/audit-guide.md.
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
 * Mirrors `contact-last-inbound-drift.ts`: a per-team loop of teamId-scoped
 * set-based UPDATEs, 24h, NO clever self-disabling (that variant's disable-state
 * was in-memory only and reset every restart — more debug cost than the scan
 * ever saved).
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
    // Serialize through the shared sweeper mutex — this is the heaviest
    // full-Message-table UPDATE and must not run concurrently with the other
    // pool-pressuring sweepers (contact-drift, retention scans).
    await withSweeperMutex("conversation-analytics-drift", sweepOnce);
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
  // bjadded-1: page PER-TEAM rather than one cross-tenant full-table UPDATE.
  // The old single statement joined the ENTIRE Conversation table against the
  // ENTIRE Message table's per-conversation direction counts — at scale (many
  // teams × millions of messages) that's a long-running, high-lock, whole-table
  // scan in one transaction. Scoping each statement to a single team (via the
  // indexed Message.teamId / Conversation.teamId) bounds the footprint and lets
  // unrelated tenants' writes proceed between iterations.
  //
  // Per team: join Conversation against per-conversation direction counts from
  // Message, update only where either denorm disagrees. COALESCE the aggregate
  // to 0 so a conversation with zero messages of a direction reconciles to 0
  // rather than being skipped. IS DISTINCT FROM is moot here (both sides are
  // non-null ints) but the COALESCE makes the "no rows" case explicit.
  const teams = await db.team.findMany({ select: { id: true } });
  let totalDrifted = 0;
  for (const { id: teamId } of teams) {
    // Per-team isolation: a lock-wait / deadlock on one tenant's hot Message
    // table must not throw out of the whole sweep and skip every later-ordered
    // team — with a 24h cadence the next retry is a full day away.
    try {
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
              -- minor#1: EXCLUDE broadcast messages from out_count so the reconcile
              -- matches the incremental definition. The live counter
              -- (trackOnOutboundMessage) is driven by the message.sent event;
              -- broadcasts publish broadcast.recipient_message_sent, which is
              -- structurally excluded from the analytics subscriber (a 1k-recipient
              -- broadcast must not bump per-conversation counters). Without this
              -- filter the daily reconcile re-added broadcast rows and the counter
              -- drifted upward every sweep relative to the incremental source of
              -- truth. Broadcast rows are stamped rawPayload.sentVia = broadcast by
              -- the runner (createOutboundMessageIdempotent), and the
              -- rawPayload-retention sweeper (message-rawpayload-retention.ts)
              -- PRESERVES that discriminator (collapsing aged broadcast payloads to
              -- the {'sentVia':'broadcast'} stub rather than NULLing them). So a
              -- broadcast row stays classifiable forever, and a NULL rawPayload now
              -- provably means a NORMAL send that merely shed its (bulky) body —
              -- which IS DISTINCT FROM 'broadcast' evaluates TRUE for, so it's
              -- correctly counted. That's why there is no longer an
              -- "unclassifiable" escape hatch: aged conversations recount cleanly.
              COUNT(*) FILTER (
                WHERE m.direction = 'out'
                  AND (m."rawPayload"->>'sentVia') IS DISTINCT FROM 'broadcast'
              ) AS out_count
            FROM "Message" m
            WHERE m."teamId" = ${teamId}
            GROUP BY m."conversationId"
          ) cnt ON cnt.conversation_id = c2.id
          WHERE c2."teamId" = ${teamId}
        ) sub
        WHERE conv.id = sub.conversation_id
          AND conv."teamId" = ${teamId}
          AND (
            conv."incomingMessagesCount" <> sub.in_count
            OR conv."outgoingMessagesCount" <> sub.out_count
          )
      `;
      totalDrifted += Number(drifted);
    } catch (err) {
      console.warn(
        `[sweeper.analytics-drift] reconcile failed for team=${teamId}; continuing`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (totalDrifted > 0) {
    console.warn(
      `[sweeper.analytics-drift] reconciled ${totalDrifted} conversation(s) with stale message counters across ${teams.length} team(s)`,
    );
  }
}
