import type { PrismaClient } from "@prisma/client";

import {
  overrideExpiryFor,
  resolveEffectiveAvailability,
  type EffectiveAvailability,
} from "@ccp/shared/presence";
import type { UserAvailabilityStatus } from "@ccp/shared/types";
import type { AvailabilitySource, WorkHours } from "@ccp/shared/work-hours";

import { publish } from "@/lib/events/bus";

import { resolveUserSchedule } from "./schedule";

/**
 * The ONE writer of availability.
 *
 * Three callers change a user's availability — the person themselves
 * (`PATCH /api/users/me/availability`), an admin acting for them
 * (`PATCH /api/users/:id/availability`), and the working-hours sweeper at a
 * shift boundary. Routing all three through here is what guarantees the
 * effective columns, the manual columns, the override expiry, and the
 * `user.availability_changed` event can never drift apart — the bug class this
 * whole feature would otherwise invite.
 *
 * It is also the reason nothing else needs to know the rule: readers just read
 * `availabilityStatus`.
 */

/** Exactly the columns this module reads. Use as a Prisma `select`. */
export const AVAILABILITY_SELECT = {
  id: true,
  teamId: true,
  availabilityStatus: true,
  availabilityMessage: true,
  availabilityManualStatus: true,
  availabilityManualMessage: true,
  availabilitySource: true,
  availabilitySetByUserId: true,
  availabilityOverrideUntil: true,
  workHoursMode: true,
  workHours: true,
} as const;

export interface AvailabilityRow {
  id: string;
  teamId: string;
  availabilityStatus: string | null;
  availabilityMessage: string | null;
  availabilityManualStatus: string | null;
  availabilityManualMessage: string | null;
  availabilitySource: string | null;
  availabilitySetByUserId: string | null;
  availabilityOverrideUntil: Date | null;
  workHoursMode: string;
  workHours: unknown;
}

/** Injected Prisma surface — same narrowing style as round-robin.ts. */
export type AvailabilityDb = Pick<PrismaClient, "user">;

/**
 * What the caller wants to change.
 *
 *  - `pick`: someone chose a status and/or note. `actorUserId` different from
 *    the target means an admin did it (source "admin").
 *  - `followSchedule`: drop the override so the schedule takes over right now
 *    ("Reset to schedule"). Keeps the manual pick on file for next time.
 *  - `sync`: no new intent — just re-resolve against the clock. What the
 *    sweeper sends, and what a schedule edit sends.
 */
export type AvailabilityIntent =
  | {
      kind: "pick";
      status?: UserAvailabilityStatus;
      message?: string | null;
      /**
       * Who is picking. Equal to the target = their own pick ("manual").
       * A different id = a supervisor ("admin", attributed to them). `null` =
       * an external actor with no member identity (an API key), which is still
       * "admin" but has nobody to attribute it to.
       */
      actorUserId: string | null;
    }
  | { kind: "followSchedule" }
  | {
      /**
       * The schedule itself just changed (org default or this member's own).
       * Keeps the manual pick, but RE-ANCHORS a live override's expiry to the
       * new schedule — its old expiry pointed at a boundary that may no longer
       * exist, which would let the override outlive the new shift and break the
       * one invariant this feature exists for.
       */
      kind: "rescheduled";
    }
  | { kind: "sync" };

export interface ApplyAvailabilityArgs {
  db: AvailabilityDb;
  user: AvailabilityRow;
  /** The team's default schedule, already narrowed (see teamScheduleOf). */
  teamSchedule: WorkHours | null;
  intent: AvailabilityIntent;
  nowMs: number;
  /** Drop the 15s ApiSession snapshot for this user. Nest paths pass this. */
  bustSessionCache?: (userId: string) => void;
}

export interface ApplyAvailabilityResult {
  /** True when something actually changed and an event was published. */
  changed: boolean;
  effective: EffectiveAvailability;
  /** The user's own pick after this call — what the picker UI displays. */
  manualStatus: UserAvailabilityStatus;
  manualMessage: string | null;
  overrideUntil: Date | null;
}

/** Compute-only — no write, no event. Used by read paths that want a preview. */
export function computeEffective(
  user: AvailabilityRow,
  teamSchedule: WorkHours | null,
  nowMs: number,
): EffectiveAvailability {
  return resolveEffectiveAvailability({
    manualStatus: user.availabilityManualStatus as UserAvailabilityStatus | null,
    manualMessage: user.availabilityManualMessage,
    overrideUntil: user.availabilityOverrideUntil,
    manualSource: user.availabilitySource as AvailabilitySource | null,
    schedule: resolveUserSchedule(user, teamSchedule),
    nowMs,
  });
}

export async function applyAvailability(
  args: ApplyAvailabilityArgs,
): Promise<ApplyAvailabilityResult> {
  const { db, user, teamSchedule, intent, nowMs } = args;
  const schedule = resolveUserSchedule(user, teamSchedule);

  // --- 1. Fold the intent into the manual pick -----------------------------
  let manualStatus = (user.availabilityManualStatus ??
    user.availabilityStatus ??
    "available") as UserAvailabilityStatus;
  let manualMessage = user.availabilityManualMessage ?? null;
  let source: AvailabilitySource =
    (user.availabilitySource as AvailabilitySource | null) ?? "manual";
  let setByUserId = user.availabilitySetByUserId ?? null;
  let overrideUntil = user.availabilityOverrideUntil ?? null;

  if (intent.kind === "pick") {
    if (intent.status !== undefined) manualStatus = intent.status;
    if (intent.message !== undefined) manualMessage = intent.message;
    // A status note is context for being UNavailable ("eating", "back at 3pm").
    // Coming back to "available" means it no longer applies, so clear it — a
    // stale note sitting next to a green dot is exactly the confusion users
    // hit. "available" wins over any `message` sent in the same call.
    if (intent.status === "available") manualMessage = null;

    source = intent.actorUserId === user.id ? "manual" : "admin";
    setByUserId = source === "admin" ? intent.actorUserId : null;
    // The override lives until the schedule next flips — never longer. With no
    // schedule there's nothing to expire back to, so it holds indefinitely,
    // exactly as availability behaved before working hours existed.
    overrideUntil = overrideExpiryFor(schedule, nowMs);
  } else if (intent.kind === "followSchedule") {
    overrideUntil = null;
    setByUserId = null;
  } else if (intent.kind === "rescheduled" && overrideUntil !== null) {
    // Only a LIVE override needs re-anchoring; an expired one is about to be
    // dropped by the resolver anyway.
    overrideUntil =
      overrideUntil.getTime() > nowMs ? overrideExpiryFor(schedule, nowMs) : overrideUntil;
  }

  // --- 2. Resolve what teammates should see --------------------------------
  const effective = resolveEffectiveAvailability({
    manualStatus,
    manualMessage,
    overrideUntil,
    manualSource: source,
    schedule,
    nowMs,
  });

  // Attribution only makes sense while an admin's pick is the thing being
  // shown. Once the override expires and the schedule takes over, a lingering
  // `setByUserId` would have a later reader render "set by Ali" next to a
  // status Ali had nothing to do with.
  if (effective.source !== "admin") setByUserId = null;

  // --- 3. Write + announce, but ONLY on a real change ----------------------
  // The sweeper calls this for every scheduled member every 60s; without this
  // guard that would be a write and a socket frame per user per minute, for a
  // value nobody changed.
  const sameEffective =
    (user.availabilityStatus ?? "available") === effective.status &&
    (user.availabilityMessage ?? null) === effective.message;
  const sameManual =
    (user.availabilityManualStatus ?? null) === manualStatus &&
    (user.availabilityManualMessage ?? null) === manualMessage &&
    (user.availabilitySource ?? "manual") === effective.source &&
    (user.availabilitySetByUserId ?? null) === setByUserId &&
    (user.availabilityOverrideUntil?.getTime() ?? null) ===
      (effective.overrideUntil?.getTime() ?? null);

  if (sameEffective && sameManual) {
    return {
      changed: false,
      effective,
      manualStatus,
      manualMessage,
      overrideUntil: effective.overrideUntil,
    };
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      availabilityStatus: effective.status,
      availabilityMessage: effective.message,
      availabilityManualStatus: manualStatus,
      availabilityManualMessage: manualMessage,
      availabilitySource: effective.source,
      availabilitySetByUserId: setByUserId,
      availabilityOverrideUntil: effective.overrideUntil,
    },
  });

  // Availability lives on the User row `loadActiveUser` reads, so the next
  // request from this user needs to see it without a 15s session-cache wait.
  args.bustSessionCache?.(user.id);

  await publish({
    type: "user.availability_changed",
    teamId: user.teamId,
    userId: user.id,
    status: effective.status,
    message: effective.message,
    source: effective.source,
    until: effective.overrideUntil?.toISOString() ?? null,
    // The picker's NOTE INPUT needs the user's OWN pick, not the
    // schedule-derived value — otherwise an off-shift agent's note box would
    // fill with "Outside working hours" and save it back as their personal
    // note on the next edit.
    manual: { status: manualStatus, message: manualMessage },
  });

  return {
    changed: true,
    effective,
    manualStatus,
    manualMessage,
    overrideUntil: effective.overrideUntil,
  };
}
