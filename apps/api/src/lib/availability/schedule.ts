import type { PrismaClient } from "@prisma/client";

import {
  asWorkHours,
  isScheduleEmpty,
  type WorkHours,
  type WorkHoursMode,
} from "@ccp/shared/work-hours";

/**
 * Which schedule actually applies to a user.
 *
 * Three modes, one rule:
 *   inherit (default) — the team's schedule, or none if the team has none.
 *   custom            — their own, falling back to the team's if theirs is
 *                       blank (a half-filled custom grid must not silently
 *                       mark someone away forever — see isScheduleEmpty).
 *   off               — no schedule at all; their availability stays manual
 *                       even when the rest of the org is on a rota.
 *
 * Returns null whenever nothing usable applies, which is the signal the
 * resolver reads as "behave exactly like before working hours existed".
 */
export function resolveUserSchedule(
  user: { workHoursMode?: string | null; workHours?: unknown },
  teamWorkHours: WorkHours | null,
): WorkHours | null {
  const mode = (user.workHoursMode ?? "inherit") as WorkHoursMode;
  if (mode === "off") return null;
  if (mode === "custom") {
    const own = asWorkHours(user.workHours);
    if (own && !isScheduleEmpty(own)) return own;
    // Fall through to the team default rather than to "no schedule": a custom
    // mode with an empty grid is an unfinished edit, not an opt-out ("off" is
    // the opt-out), and inheriting is the less surprising of the two.
  }
  return teamWorkHours && !isScheduleEmpty(teamWorkHours) ? teamWorkHours : null;
}

/** Narrow a team's `workHours` JSON column, treating a blank grid as none. */
export function workspaceScheduleOf(team: { workHours?: unknown } | null): WorkHours | null {
  const schedule = asWorkHours(team?.workHours);
  return schedule && !isScheduleEmpty(schedule) ? schedule : null;
}

/**
 * Which workspaces are involved in one person's availability, and WHICH ONE's
 * default schedule governs them.
 *
 * Availability is a property of the PERSON, not of a workspace: the columns live
 * on `User`, there is one green dot, and "Back at 3pm" is true of a human rather
 * than of an inbox. But the schedule that DERIVES it (`Workspace.workHours`, the
 * thing `workHoursMode: "inherit"` inherits) is per-workspace — so a member of
 * two workspaces had two schedules writing one column.
 *
 * That was not a theoretical conflict. The sweeper looped workspace-by-workspace
 * and wrote the shared row each time, so a person in a 09:00–17:00 workspace and
 * a 17:00–01:00 one flip-flopped every 60 seconds — a write, a socket frame and
 * a session-cache bust per tick, landing on whichever workspace happened to be
 * iterated last, and wrong for the other one. Downstream, `eligibility:
 * available_only` then dropped them from routing in the workspace they were
 * actually on shift for.
 *
 * The rule: their OWN schedule when `workHoursMode = "custom"`, otherwise the
 * default of the first workspace they joined THAT ACTUALLY HAS ONE. One
 * schedule, one writer, one status.
 *
 * "That actually has one" is doing real work, not tidying. Picking the
 * first-joined workspace unconditionally is equally deterministic and quietly
 * wrong: an admin who fills in the working-hours grid on the workspace they are
 * standing in sees nothing happen, because the person's *other*, older workspace
 * has no schedule and wins the tie. Skipping the empty ones means the common
 * case — exactly one workspace in the org has hours configured — behaves the way
 * anyone would expect, while a person under two real schedules still gets a
 * single stable answer rather than a 60-second flip-flop.
 *
 * (If per-workspace availability is ever genuinely wanted — the same person
 * "available" for Sales and "away" for Support — that is a schema change:
 * the availability columns move onto `WorkspaceMember`. Don't approximate it by
 * letting several schedules fight over one column.)
 */
export async function loadAvailabilityScope(
  db: Pick<PrismaClient, "workspaceMember">,
  userId: string,
): Promise<{ workspaceIds: string[]; workspaceSchedule: WorkHours | null }> {
  const memberships = await db.workspaceMember.findMany({
    where: { userId },
    // Deterministic tie-break: join order, the same ordering the
    // active-workspace fallback uses.
    orderBy: { createdAt: "asc" },
    select: { workspaceId: true, workspace: { select: { workHours: true } } },
  });

  let workspaceSchedule: WorkHours | null = null;
  for (const m of memberships) {
    const schedule = workspaceScheduleOf(m.workspace);
    if (schedule) {
      workspaceSchedule = schedule;
      break;
    }
  }

  return { workspaceIds: memberships.map((m) => m.workspaceId), workspaceSchedule };
}
