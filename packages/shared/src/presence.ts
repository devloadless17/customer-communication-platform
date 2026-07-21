/**
 * Shared catalog for user-controlled availability. Used by:
 *   - The Zod schema at the API boundary (PATCH /api/users/me).
 *   - The realtime fanout filter that decides which "online" socket
 *     identities appear in `presence:update`.
 *   - Every client surface that paints the user-state dot/label (sidebar
 *     teammate list, user menu, assignment dropdown).
 *
 * Order is the canonical UI order (matches the picker). Don't depend on the
 * order for logic — switch on the literal value.
 */
import type { UserAvailabilityStatus } from "./types";
import {
  isScheduleEmpty,
  isWithinWorkHours,
  nextBoundary,
  nextLocalMidnight,
  offShiftMessage,
  type AvailabilitySource,
  type WorkHours,
} from "./work-hours";

export const ALL_AVAILABILITY_STATUSES: UserAvailabilityStatus[] = [
  "available",
  "busy",
  "away",
  "offline",
];

export const AVAILABILITY_LABELS: Record<UserAvailabilityStatus, string> = {
  available: "Available",
  busy: "Busy",
  away: "Away",
  offline: "Appear offline",
};

/**
 * Tailwind class for the small status dot teammates see. Kept here so the
 * sidebar, the user menu, and any future surface (assignment dropdown, viewer
 * pill) all paint the SAME color for a given status — single source of truth
 * means swapping a hue is a one-file edit.
 */
export const AVAILABILITY_DOT_CLASSES: Record<UserAvailabilityStatus, string> = {
  available: "bg-emerald-500",
  busy: "bg-amber-500",
  away: "bg-zinc-400",
  // Offline matches the "no socket" dot color in the sidebar — a user marked
  // offline must be visually indistinguishable from one who's literally gone.
  offline: "bg-muted-foreground/40",
};

/**
 * Resolve a possibly-missing status into the canonical one. The wire format
 * allows `undefined` so the migration doesn't have to backfill; every UI
 * consumer should pass through this helper so "no value" reads as
 * "available" instead of falling through a switch unhandled.
 */
export function resolveAvailabilityStatus(
  status: UserAvailabilityStatus | null | undefined,
): UserAvailabilityStatus {
  return status ?? "available";
}

/* -------------------------------------------------------------------------
 * Effective availability = manual pick + working-hours schedule
 * ------------------------------------------------------------------------- */

export interface EffectiveAvailabilityInput {
  /** What the person (or an admin) last picked. Null = never picked. */
  manualStatus: UserAvailabilityStatus | null | undefined;
  /** Their own status note. Preserved across an off-shift stretch. */
  manualMessage: string | null | undefined;
  /** While in the future, the manual pick wins over the schedule. */
  overrideUntil: Date | null | undefined;
  /** "manual" or "admin" — carried through while the override is live. */
  manualSource: AvailabilitySource | null | undefined;
  /** The schedule that applies to this user, already resolved (inherit/custom/off). */
  schedule: WorkHours | null | undefined;
  nowMs: number;
}

export interface EffectiveAvailability {
  status: UserAvailabilityStatus;
  message: string | null;
  source: AvailabilitySource;
  /** When the manual pick stops winning. Null when nothing is overriding. */
  overrideUntil: Date | null;
}

/**
 * THE availability rule. Every write path (self, admin, the boundary sweeper)
 * resolves through this one function, so "what status is this person actually
 * showing" can never be answered two different ways in two places.
 *
 *   1. No schedule            → the manual pick, forever. Byte-for-byte the
 *                               behavior that existed before working hours, and
 *                               what every un-configured team keeps getting.
 *   2. Override still live    → the manual pick, until `overrideUntil`.
 *   3. On shift               → available, with the manual note dropped (a note
 *                               explaining an absence is stale once you're back).
 *   4. Off shift              → away + "Outside working hours · back Mon 09:00".
 *
 * The manual pick is never destroyed by (3)/(4) — it lives in its own columns,
 * so an override that expires overnight doesn't lose the note the user typed.
 */
export function resolveEffectiveAvailability(
  input: EffectiveAvailabilityInput,
): EffectiveAvailability {
  const manualStatus = resolveAvailabilityStatus(input.manualStatus);
  const manualMessage = input.manualMessage ?? null;
  const manualSource: AvailabilitySource =
    input.manualSource === "admin" ? "admin" : "manual";
  const schedule = isScheduleEmpty(input.schedule) ? null : input.schedule!;

  if (!schedule) {
    return {
      status: manualStatus,
      message: manualMessage,
      source: manualSource,
      overrideUntil: null,
    };
  }

  const until = input.overrideUntil ?? null;
  if (until !== null && until.getTime() > input.nowMs) {
    return {
      status: manualStatus,
      message: manualMessage,
      source: manualSource,
      overrideUntil: until,
    };
  }

  if (isWithinWorkHours(schedule, input.nowMs)) {
    return { status: "available", message: null, source: "schedule", overrideUntil: null };
  }
  return {
    status: "away",
    message: offShiftMessage(schedule, input.nowMs),
    source: "schedule",
    overrideUntil: null,
  };
}

/**
 * How long a fresh manual pick should out-rank the schedule: until the next
 * time the schedule flips (shift end if you're on, shift start if you're off).
 *
 * This is the whole point of the feature — an override can't outlive the shift
 * that motivated it, so "set busy at 2pm and drive home at 5" self-corrects.
 * Returns null when there's no schedule (the pick then holds indefinitely,
 * exactly as it did before).
 */
export function overrideExpiryFor(
  schedule: WorkHours | null | undefined,
  nowMs: number,
): Date | null {
  if (isScheduleEmpty(schedule)) return null;
  const boundary = nextBoundary(schedule, nowMs);
  if (boundary) return new Date(boundary.at);
  // A schedule with no boundary ahead — a 24/7 grid — still has to bound the
  // override, or a team that runs around the clock gets the exact
  // forgot-to-flip-it problem this feature exists to kill. Anchor to the next
  // local midnight in the SCHEDULE's zone: the override can't outlive the day.
  //
  // Returning null here instead would be worse than useless: null means "no
  // override", so the schedule would reclaim the status on the very next
  // resolve and a 24/7 team could never mark themselves busy at all.
  return new Date(nextLocalMidnight(schedule!.timezone, nowMs));
}
