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
export function teamScheduleOf(team: { workHours?: unknown } | null): WorkHours | null {
  const schedule = asWorkHours(team?.workHours);
  return schedule && !isScheduleEmpty(schedule) ? schedule : null;
}
