/**
 * SLA due-date arithmetic for tickets. PURE — no DB, no clock of its own (every
 * entry point takes `nowMs`), so the whole thing is unit-testable and the
 * breach sweeper and the create path provably agree.
 *
 * Two design decisions worth stating, because both are easy to get wrong:
 *
 *  1. **Due dates are STORED, not derived on read.** A workspace can edit its
 *     SLA policy at any time; a ticket must keep the commitment it was created
 *     under. Recomputing on read would silently rewrite history the moment an
 *     admin tightened a policy — every open ticket would appear to have been
 *     breached retroactively.
 *
 *  2. **Paused time is ACCUMULATED on the ticket** (`slaPausedMs` + an open
 *     `slaPausedAt`), not replayed from the event log. The breach sweeper is a
 *     single indexed range scan over due dates; replaying every status change
 *     per candidate would turn it into an N-query walk of the busiest table.
 */

import { shiftIntervals, type WorkHours } from "@ccp/shared/work-hours";
import type { TicketStatus } from "@ccp/shared/types";

/** The policy fields the arithmetic needs. Deliberately not the Prisma row. */
export interface SlaPolicyInput {
  firstResponseMins: number | null;
  resolutionMins: number | null;
  pauseOnHold: boolean;
  pauseWhenPending: boolean;
  businessHoursOnly: boolean;
}

/** Does this status park the clock under this policy? */
export function isSlaPaused(status: TicketStatus, policy: SlaPolicyInput | null): boolean {
  if (!policy) return false;
  if (status === "on_hold") return policy.pauseOnHold;
  if (status === "pending") return policy.pauseWhenPending;
  return false;
}

/**
 * The due date `minutes` of WORKING time after `fromMs`.
 *
 * With `businessHoursOnly` off (the default) this is plain wall-clock addition.
 * With it on, the minutes are consumed only inside the workspace's open
 * windows, walking forward day by day.
 *
 * Returns null when `minutes` is null (no commitment on this leg) — null is not
 * zero: nothing is due, so nothing can breach.
 */
export function dueAt(
  fromMs: number,
  minutes: number | null,
  businessHoursOnly: boolean,
  schedule: WorkHours | null,
): Date | null {
  if (minutes === null || minutes <= 0) return null;
  if (!businessHoursOnly || !schedule) return new Date(fromMs + minutes * 60_000);

  let remaining = minutes * 60_000;
  let cursor = fromMs;
  // 60 civil days of lookahead. A commitment that can't be met inside two
  // months of working time is not a commitment — falling back to wall-clock is
  // both honest and finite, and beats returning null (which would silently mean
  // "never due" for a ticket the org does expect to be answered).
  for (let day = 0; day < 60; day++) {
    const intervals = shiftIntervals(schedule, cursor, 0, 1);
    for (const iv of intervals) {
      if (iv.end <= cursor) continue;
      const start = Math.max(iv.start, cursor);
      const available = iv.end - start;
      if (available >= remaining) return new Date(start + remaining);
      remaining -= available;
      cursor = iv.end;
    }
    // Nothing left today — jump to the start of the next civil day and retry.
    cursor = Math.max(cursor, fromMs + (day + 1) * 86_400_000);
  }
  return new Date(fromMs + minutes * 60_000);
}

export interface SlaDueDates {
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
}

/** Both legs of a commitment, computed from one starting instant. */
export function computeDueDates(
  fromMs: number,
  policy: SlaPolicyInput | null,
  schedule: WorkHours | null,
): SlaDueDates {
  if (!policy) return { firstResponseDueAt: null, resolutionDueAt: null };
  return {
    firstResponseDueAt: dueAt(
      fromMs,
      policy.firstResponseMins,
      policy.businessHoursOnly,
      schedule,
    ),
    resolutionDueAt: dueAt(fromMs, policy.resolutionMins, policy.businessHoursOnly, schedule),
  };
}

/**
 * Shift both due dates forward by the time the clock spent parked.
 *
 * Called when a ticket LEAVES a paused status: the pause consumed real time
 * that was never ours, so the deadline moves by exactly that much. Splitting
 * this from `computeDueDates` matters — recomputing from scratch on resume
 * would restart the whole commitment, handing an agent a fresh 4 hours every
 * time they bounced a ticket through `on_hold`.
 */
export function shiftDueDates(dates: SlaDueDates, pausedMs: number): SlaDueDates {
  if (pausedMs <= 0) return dates;
  return {
    firstResponseDueAt: dates.firstResponseDueAt
      ? new Date(dates.firstResponseDueAt.getTime() + pausedMs)
      : null,
    resolutionDueAt: dates.resolutionDueAt
      ? new Date(dates.resolutionDueAt.getTime() + pausedMs)
      : null,
  };
}
