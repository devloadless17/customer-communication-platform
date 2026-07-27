import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Reconciler for the `Conversation.openTicketCount` denormalization.
 *
 * CLAUDE.md §7 names `openTicketCount` among the denormalizations that are
 * "each backed by a drift sweeper". It wasn't — this closes that gap, found by
 * the B-M4 seam audit when it enumerated the drift coverage and found three
 * columns claimed but unreconciled.
 *
 * The counter is maintained transactionally by `bumpOpenTicketCount` inside
 * every ticket mutation, so the normal paths cannot diverge. Like its sibling
 * `message-flag-count-drift`, this exists for the paths that DON'T go through
 * that code:
 *
 *   - a `Ticket` hard-delete cascading away (deleteTicket decrements, but a
 *     Conversation or Contact cascade takes tickets with it and nothing
 *     decrements the parent),
 *   - a manual DB fix-up,
 *   - any future writer that forgets the rule.
 *
 * Stale here is not cosmetic. The inbox reads `openTicketCount` as a plain
 * column on the hot path: an inflated counter shows a ticket badge on a thread
 * with no open work, and a deflated one hides real work from the board's
 * conversation-level cues.
 *
 * NOT DONE HERE, deliberately: `Conversation.unreadCount`, which §7 also
 * claims. It is NOT RECOMPUTABLE. There is no per-message read marker and no
 * `lastReadAt` watermark on the conversation — `unreadCount` is a pure counter,
 * incremented on inbound and CAS-zeroed by `markConversationRead`. With no
 * derivable truth there is nothing for a reconciler to compare against, so a
 * sweeper cannot exist for it by construction rather than by omission. Making
 * it reconcilable means adding a read watermark (a schema change), which is a
 * product decision, not a verification fix. §7 has been corrected to say so.
 *
 * Cadence: 24h, per-workspace, mirroring the flag-count reconciler — including
 * its per-tenant isolation, so one tenant's lock-wait can't skip every later
 * workspace for a full day.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Offset from the sibling sweepers (5min, 6min) so they don't land together. */
const INITIAL_DELAY_MS = 7 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("open-ticket-count-drift", sweepOpenTicketCountsOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is over, so
    // stop rather than log a stack trace every tick for the whole drain.
    if (isPoolClosedError(err)) {
      stopOpenTicketCountDriftSweeper();
      return;
    }
    console.error(`[sweeper.open-ticket-count-drift] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startOpenTicketCountDriftSweeper(): void {
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

export function stopOpenTicketCountDriftSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Recompute the true active-ticket count per conversation and correct any row
 * that disagrees. Returns the number of rows corrected — exported so a test or
 * an ops one-off can assert "zero drift" without waiting for the timer.
 *
 * Only touches conversations that either HAVE active tickets or currently claim
 * a non-zero count, so the statement never rewrites the overwhelming majority
 * of threads that have never had a ticket raised on them.
 */
export async function sweepOpenTicketCountsOnce(): Promise<number> {
  const workspaces = await db.workspace.findMany({ select: { id: true } });
  let totalDrifted = 0;

  for (const { id: workspaceId } of workspaces) {
    try {
      const drifted = await db.$executeRaw`
        UPDATE "Conversation" c
        SET "openTicketCount" = sub.actual
        FROM (
          SELECT
            c2.id AS conversation_id,
            COALESCE(t.open_count, 0)::int AS actual
          FROM "Conversation" c2
          LEFT JOIN (
            SELECT "conversationId", COUNT(*) AS open_count
            FROM "Ticket"
            WHERE "workspaceId" = ${workspaceId}
              -- ACTIVE = not terminal. Kept in step with
              -- TICKET_ACTIVE_STATUSES (@ccp/shared/tickets/types): every
              -- status except solved/closed counts as open work.
              AND status NOT IN ('solved', 'closed')
            GROUP BY "conversationId"
          ) t ON t."conversationId" = c2.id
          WHERE c2."workspaceId" = ${workspaceId}
            -- Skip the never-ticketed majority: no ticket rows and a counter
            -- already at 0 is correct by definition, and rewriting it would
            -- touch nearly every conversation in the workspace every day.
            AND (t.open_count IS NOT NULL OR c2."openTicketCount" <> 0)
        ) sub
        WHERE c.id = sub.conversation_id
          AND c."workspaceId" = ${workspaceId}
          AND c."openTicketCount" IS DISTINCT FROM sub.actual
      `;
      totalDrifted += Number(drifted);
    } catch (err) {
      // Per-tenant isolation: one workspace's failure must not skip the rest
      // for a full day.
      console.warn(
        `[sweeper.open-ticket-count-drift] reconcile failed for workspace=${workspaceId}; continuing`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (totalDrifted > 0) {
    console.warn(
      `[sweeper.open-ticket-count-drift] corrected ${totalDrifted} drifted conversation counter(s)`,
    );
  }
  return totalDrifted;
}
