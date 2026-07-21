import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Reconciler for the `Conversation.openFlagCount` denormalization.
 *
 * The denorm is maintained transactionally by
 * [message-flags/mutations.ts](../message-flags/mutations.ts) — every status
 * change moves the counter inside the SAME transaction as the flag write, so
 * the two can't diverge through the normal paths. This sweeper exists for the
 * paths that DON'T go through that code:
 *
 *   - a `Message` or `Conversation` hard-delete cascading `MessageFlag` rows
 *     away (the FK does the delete; nothing decrements the parent's counter),
 *   - a manual DB fix-up,
 *   - any future writer that forgets the rule.
 *
 * Stale here is not cosmetic: the "Flagged" inbox preset filters on
 * `openFlagCount > 0`, so an inflated counter parks a thread in a triage queue
 * with nothing to triage, and a deflated one hides real open work.
 *
 * Cadence: 24h, per-team, mirroring the contact-lastInboundAt reconciler
 * (including its per-team isolation — one tenant's lock-wait must not skip
 * every later team for a full day).
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 6 * 60 * 1000; // offset from the sibling sweepers' 5min

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("message-flag-count-drift", sweepOnce);
  } catch (err) {
    console.error(`[sweeper.message-flag-count-drift] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startMessageFlagCountDriftSweeper(): void {
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

export function stopMessageFlagCountDriftSweeper(): void {
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
 * Recompute the true open-flag count per conversation and correct any row that
 * disagrees. Returns the number of rows corrected — exported so a test or an
 * ops one-off can assert "zero drift" without waiting for the timer.
 *
 * Only touches conversations that either HAVE flags or currently claim a
 * non-zero count, so the statement never rewrites the (overwhelming majority
 * of) threads that have never been flagged.
 */
export async function sweepMessageFlagCountsOnce(): Promise<number> {
  const teams = await db.team.findMany({ select: { id: true } });
  let totalDrifted = 0;

  for (const { id: teamId } of teams) {
    try {
      const drifted = await db.$executeRaw`
        UPDATE "Conversation" c
        SET "openFlagCount" = sub.actual
        FROM (
          SELECT
            c2.id AS conversation_id,
            COALESCE(f.open_count, 0)::int AS actual
          FROM "Conversation" c2
          LEFT JOIN (
            SELECT "conversationId", COUNT(*) AS open_count
            FROM "MessageFlag"
            WHERE "teamId" = ${teamId} AND status = 'open'
            GROUP BY "conversationId"
          ) f ON f."conversationId" = c2.id
          WHERE c2."teamId" = ${teamId}
            -- Skip the never-flagged majority: a thread with no flag rows and a
            -- counter already at 0 is by definition correct, and rewriting it
            -- would touch nearly every conversation in the team every day.
            AND (f.open_count IS NOT NULL OR c2."openFlagCount" <> 0)
        ) sub
        WHERE c.id = sub.conversation_id
          AND c."teamId" = ${teamId}
          AND c."openFlagCount" IS DISTINCT FROM sub.actual
      `;
      totalDrifted += Number(drifted);
    } catch (err) {
      console.warn(
        `[sweeper.message-flag-count-drift] reconcile failed for team=${teamId}; continuing`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (totalDrifted > 0) {
    console.warn(
      `[sweeper.message-flag-count-drift] reconciled ${totalDrifted} conversation(s) with a stale openFlagCount across ${teams.length} team(s)`,
    );
  }
  return totalDrifted;
}

async function sweepOnce(): Promise<void> {
  await sweepMessageFlagCountsOnce();
}
