import { db } from "@/lib/db";
import { markSlaBreached } from "@/lib/tickets/mutations";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";
import { TICKET_ACTIVE_STATUSES } from "@ccp/shared/tickets/types";
import type { TicketStatus } from "@ccp/shared/tickets/types";

/**
 * Flags tickets whose SLA clock has run out.
 *
 * A breach is a TIME-BASED event with no request behind it, so nothing else in
 * the system can notice it: the deadline simply passes while everyone is
 * looking elsewhere. That is exactly what a sweeper is for. Mirrors
 * `stale-calls.ts` — a mutex so only one process sweeps, a CAS-then-publish so
 * a lost race is a silent skip, and a bounded batch so a backlog can't turn one
 * tick into a table scan.
 *
 * The scan is served by the two PARTIAL indexes created in raw SQL in the
 * 0_init baseline's hand-maintained section (`Ticket_first_response_due_idx` /
 * `Ticket_resolution_due_idx`): they cover exactly the rows that can still
 * breach — non-terminal, not-already-flagged, with a due date — which is a tiny
 * fraction of the table. Without them this is a seq scan of every ticket the
 * platform has ever held, every minute.
 *
 * PAUSED tickets are excluded here rather than in the index, because "paused"
 * is a live column (`slaPausedAt`) not a static predicate: a ticket parked on
 * hold has already had its deadline pushed out on resume, and flagging it while
 * it waits would breach a promise the clock isn't counting against.
 *
 * The write itself is `markSlaBreached`, which CASes on the not-yet-breached
 * flag — so an overlapping tick, or a second app instance, produces exactly one
 * breach event however many times this runs.
 */

const SWEEP_INTERVAL_MS = 60 * 1000;
// Bounded so a workspace that just imported a backlog of overdue work can't
// make one tick unbounded. The next tick picks up where this one stopped;
// nothing is lost, it just drains over a few minutes.
const BATCH = 200;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("ticket-sla-breach", sweepOnce);
  } catch (err) {
    // The pool is gone (hot-reload / shutdown) — there is nothing left to
    // sweep, so stop rather than logging a stack trace on every tick forever.
    if (isPoolClosedError(err)) {
      stopTicketSlaBreachSweeper();
      return;
    }
    console.error(`[sweeper.ticket-sla-breach] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startTicketSlaBreachSweeper(): void {
  if (timer) return;
  // Run once on boot so deadlines that passed while the process was down are
  // flagged immediately rather than up to a minute later.
  void runTick("initial sweep");
  timer = setInterval(() => {
    void runTick("sweep");
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export function stopTicketSlaBreachSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const now = new Date();
  const active = { in: TICKET_ACTIVE_STATUSES as TicketStatus[] };

  // ---- First response ----
  // Only tickets nobody has replied to yet: `firstResponseAt` being set means
  // the promise was kept, whatever the due date says now.
  const lateFirstResponse = await db.ticket.findMany({
    where: {
      status: active,
      firstResponseBreached: false,
      firstResponseAt: null,
      slaPausedAt: null,
      firstResponseDueAt: { lt: now },
    },
    select: { id: true, workspaceId: true },
    take: BATCH,
  });

  for (const row of lateFirstResponse) {
    // Isolated per row: one failed publish must not abort the loop and leave
    // every later overdue ticket unflagged — the same stuck-badge class the
    // stale-calls sweeper guards against.
    try {
      await markSlaBreached(db, {
        workspaceId: row.workspaceId,
        ticketId: row.id,
        leg: "first_response",
      });
    } catch (err) {
      console.warn(`[sweeper.ticket-sla-breach] first_response failed for ${row.id}`, err);
    }
  }

  // ---- Resolution ----
  const lateResolution = await db.ticket.findMany({
    where: {
      status: active,
      resolutionBreached: false,
      slaPausedAt: null,
      resolutionDueAt: { lt: now },
    },
    select: { id: true, workspaceId: true },
    take: BATCH,
  });

  for (const row of lateResolution) {
    try {
      await markSlaBreached(db, {
        workspaceId: row.workspaceId,
        ticketId: row.id,
        leg: "resolution",
      });
    } catch (err) {
      console.warn(`[sweeper.ticket-sla-breach] resolution failed for ${row.id}`, err);
    }
  }
}
