import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Reconciler for the `Ticket.lastActivityAt` denormalization.
 *
 * §7: "a denormalization is only as trustworthy as its reconciler", and every
 * one that CAN be recomputed has a drift sweeper. This one can: the truth is
 * `GREATEST(createdAt, max(TicketEvent.createdAt), max(TicketMessage.createdAt))`,
 * which is exactly what the column's backfill computed.
 *
 * The column is maintained inline by every ticket writer, so the normal paths
 * cannot diverge. Like its siblings, this exists for the paths that DON'T:
 *
 *   - a row edited by hand during an incident,
 *   - a future writer that forgets to touch it,
 *   - `touchTicketActivity`, which swallows its own failure on purpose (an
 *     ordering hint must never fail the write it decorates) and therefore can
 *     legitimately leave the column behind.
 *
 * Drift here is not cosmetic but it is not dangerous either: the board sorts on
 * it, so a stale value sinks a ticket someone is actively working. That is a
 * bad day for whoever is looking for it, not a correctness failure — which is
 * why this runs daily rather than on the hot path.
 *
 * NOT compared against `updatedAt`: an SLA sweep or a counter bump writes the
 * row without anything having HAPPENED on the ticket, so folding it in would
 * make every nightly sweep look like activity. The backfill included it once,
 * for rows that predate the column and have no other evidence.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Offset from the sibling drift sweepers (5/6/7min) so they don't land together. */
const INITIAL_DELAY_MS = 9 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("ticket-last-activity-drift", sweepTicketLastActivityOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is over.
    if (isPoolClosedError(err)) {
      stopTicketLastActivityDriftSweeper();
      return;
    }
    console.error(`[sweeper.ticket-last-activity-drift] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startTicketLastActivityDriftSweeper(): void {
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

export function stopTicketLastActivityDriftSweeper(): void {
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
 * Recompute each ticket's true last activity and correct any row that
 * disagrees. Returns the number of rows corrected — exported so a test or an
 * ops one-off can assert "zero drift" without waiting for the timer.
 *
 * Per-workspace, like the sibling reconcilers, so one tenant's lock-wait cannot
 * skip every later workspace for a full day.
 */
export async function sweepTicketLastActivityOnce(): Promise<number> {
  const workspaces = await db.workspace.findMany({ select: { id: true } });
  let totalDrifted = 0;

  for (const { id: workspaceId } of workspaces) {
    try {
      const drifted = await db.$executeRaw`
        UPDATE "Ticket" t
        SET "lastActivityAt" = sub.actual
        FROM (
          SELECT
            x."id",
            GREATEST(
              x."createdAt",
              COALESCE((SELECT MAX(e."createdAt") FROM "TicketEvent" e WHERE e."ticketId" = x."id"), x."createdAt"),
              COALESCE((SELECT MAX(m."createdAt") FROM "TicketMessage" m WHERE m."ticketId" = x."id"), x."createdAt"),
              -- The first agent REPLY bumps lastActivityAt (markFirstResponse)
              -- and writes neither an event nor a thread message, so a formula
              -- without this term reverts it: the ticket someone just answered
              -- sank back below ones nobody has touched, nightly, and the
              -- sweeper logged it as a correction. The stamp records exactly
              -- the moment that moved the clock, so truth stays derivable.
              COALESCE(x."firstResponseAt", x."createdAt")
            ) AS actual
          FROM "Ticket" x
          WHERE x."workspaceId" = ${workspaceId}
        ) sub
        WHERE t."id" = sub."id"
          AND t."lastActivityAt" IS DISTINCT FROM sub.actual
      `;
      totalDrifted += drifted;
      if (drifted > 0) {
        console.warn(
          `[sweeper.ticket-last-activity-drift] corrected ${drifted} ticket(s) in workspace ${workspaceId}`,
        );
      }
    } catch (err) {
      if (isPoolClosedError(err)) throw err;
      // One tenant's failure must not skip the rest — same isolation as the
      // sibling reconcilers.
      console.error(
        `[sweeper.ticket-last-activity-drift] workspace ${workspaceId} failed`,
        err,
      );
    }
  }
  return totalDrifted;
}
