import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { AVAILABILITY_SELECT, applyAvailability } from "@/lib/availability/apply";
import { teamScheduleOf } from "@/lib/availability/schedule";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

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
  // Only teams that could possibly have a schedule in force: one on the team
  // itself, or at least one member with their own. Teams with neither are the
  // common case pre-adoption and are skipped entirely.
  const teams = await db.team.findMany({
    where: {
      OR: [
        { workHours: { not: Prisma.DbNull } },
        { users: { some: { workHoursMode: "custom", workHours: { not: Prisma.DbNull } } } },
      ],
    },
    select: { id: true, workHours: true },
  });
  if (teams.length === 0) return;

  const nowMs = Date.now();
  let transitions = 0;

  for (const team of teams) {
    // Per-team isolation: one tenant's failure must not skip every later team.
    try {
      const teamSchedule = teamScheduleOf(team);
      const members = await db.user.findMany({
        where: { teamId: team.id, deactivatedAt: null },
        select: AVAILABILITY_SELECT,
      });
      for (const member of members) {
        const result = await applyAvailability({
          db,
          user: member,
          teamSchedule,
          intent: { kind: "sync" },
          nowMs,
        });
        if (result.changed) transitions++;
      }
    } catch (err) {
      console.warn(
        `[sweeper.work-hours] tick failed for team=${team.id}; continuing`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (transitions > 0) {
    console.log(
      `[sweeper.work-hours] applied ${transitions} availability transition(s) across ${teams.length} scheduled team(s)`,
    );
  }
}
