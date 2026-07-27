import { Prisma } from "@prisma/client";

import { invalidateSessionCache } from "@/auth/session.guard";
import { db } from "@/lib/db";
import { AVAILABILITY_SELECT, applyAvailability } from "@/lib/availability/apply";
import { loadAvailabilityScope } from "@/lib/availability/schedule";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Working-hours boundary tick — the thing that makes availability self-correct.
 *
 * A schedule only helps if something notices the moment it flips. Nothing else
 * does: a user who shut their laptop at 17:00 isn't around to trigger a
 * recompute, and every read path deliberately reads the stored effective status
 * rather than deriving it (so a sync mapper with only the User row can't answer
 * differently from the realtime gateway). This tick is the single writer that
 * moves people across shift boundaries and expires their manual overrides.
 *
 * It is ALSO its own drift sweeper: it re-resolves every scheduled member from
 * scratch each pass, so a missed tick, a process restart, or a schedule edited
 * while the process was down all self-heal within one cadence. That's what
 * makes the effective-status denormalization safe (CLAUDE.md §7).
 *
 * Cadence: 60s. Cost is bounded by "members of teams that actually configured
 * hours" — a team with no schedule is filtered out in SQL and costs nothing, so
 * this stays free until someone opts in. Writes and socket frames only happen
 * on a real transition (`applyAvailability` no-ops when nothing changed), so
 * the steady state is one cheap SELECT per scheduled team per minute.
 */

const SWEEP_INTERVAL_MS = 60 * 1000;
// Short boot delay: presence/realtime wiring settles first, and a fresh process
// shouldn't fire a fleet-wide availability recompute while it's still booting.
const INITIAL_DELAY_MS = 20 * 1000;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("work-hours", sweepOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopWorkHoursSweeper();
      return;
    }
    console.error(`[sweeper.work-hours] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startWorkHoursSweeper(): void {
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

export function stopWorkHoursSweeper(): void {
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
  // Iterate PEOPLE, once each — not workspace × member.
  //
  // This used to loop workspaces and, inside each, every member. Availability
  // columns live on the shared `User` row, so a person in two workspaces was
  // resolved twice per tick against two different `Workspace.workHours` grids,
  // each write clobbering the last. With a 09:00–17:00 workspace and a
  // 17:00–01:00 one that is a status flip, a socket frame and a session-cache
  // bust EVERY 60 SECONDS, landing on whichever workspace sorted last. Resolving
  // each person once against their single governing schedule is what makes the
  // stored effective status a fact rather than a race.
  //
  // Only people who could possibly have a schedule in force: their own custom
  // grid, or membership of a workspace that has a default. Everyone else is the
  // common pre-adoption case and is filtered out in SQL, so this stays free
  // until someone opts in.
  const users = await db.user.findMany({
    where: {
      deactivatedAt: null,
      OR: [
        { workHoursMode: "custom", workHours: { not: Prisma.DbNull } },
        {
          workspaceMemberships: {
            some: { workspace: { workHours: { not: Prisma.DbNull } } },
          },
        },
      ],
    },
    select: AVAILABILITY_SELECT,
  });
  if (users.length === 0) return;

  const nowMs = Date.now();
  let transitions = 0;

  for (const user of users) {
    // Per-user isolation: one failure must not skip everyone after it.
    try {
      const { workspaceIds, teamSchedule } = await loadAvailabilityScope(db, user.id);
      if (workspaceIds.length === 0) continue;
      // RE-READ inside the loop. The findMany above is a point-in-time
      // snapshot, and a 300-member sweep takes seconds — long enough for an
      // agent to set themselves `busy` mid-sweep. Applying the stale row
      // recomputed their status from schedule and silently reverted the
      // override they had just chosen (applyAvailability's write is
      // unconditional). Skipping a row that changed under us is correct: the
      // write that changed it already published its own frame, and the next
      // tick (60s) re-evaluates from fresh state.
      const fresh = await db.user.findFirst({
        // deactivatedAt in the WHERE, not the select: AVAILABILITY_SELECT
        // doesn't carry it, and a member deactivated mid-sweep should simply
        // drop out.
        where: { id: user.id, deactivatedAt: null },
        select: AVAILABILITY_SELECT,
      });
      if (!fresh) continue;
      const result = await applyAvailability({
        db,
        user: fresh,
        workspaceIds,
        teamSchedule,
        intent: { kind: "sync" },
        nowMs,
        // Every other caller of applyAvailability busts the 15s ApiSession
        // cache; the sweeper is the one path where NOBODY triggered the
        // change, which is exactly where a stale read is most likely. Without
        // this, an RSC render in the 15s after a shift boundary seeds the
        // availability picker with the pre-boundary status while the socket
        // frame has already said otherwise.
        bustSessionCache: invalidateSessionCache,
      });
      if (result.changed) transitions++;
    } catch (err) {
      console.warn(
        `[sweeper.work-hours] tick failed for user=${user.id}; continuing`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (transitions > 0) {
    console.log(
      `[sweeper.work-hours] applied ${transitions} availability transition(s) across ${users.length} scheduled member(s)`,
    );
  }
}
