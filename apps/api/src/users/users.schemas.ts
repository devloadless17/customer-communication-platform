import { z } from "zod";

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@ccp/shared/auth/password-policy";
import { isValidTimezone, parseTimeOfDay } from "@ccp/shared/work-hours";

/**
 * Query for GET /api/users/stats. `period` windows the assigned / messages-sent
 * / closed counts (rolling windows ending now); `all` = all-time. The "active"
 * (currently-assigned) count ignores this — it's always point-in-time.
 */
export const StatsQuerySchema = z.object({
  period: z.enum(["day", "week", "month", "year", "all"]).default("all"),
});
export type StatsQuery = z.infer<typeof StatsQuerySchema>;

export const UpdateUserSchema = z
  .object({
    role: z.string().optional(),
    deactivated: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no changes" });
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

/**
 * Admin-initiated password reset for a teammate. No `currentPassword` — the
 * admin is acting *on behalf of* a locked-out user, not changing their own
 * credentials, so the self-service `change-password` gate (which proves
 * knowledge of the old password) doesn't apply. Authorization is the
 * `canModifyUser` role gate in the service instead.
 *
 * Length is policy-validated here so the structural check matches the
 * self-service path; deeper structural rules live in `validatePasswordStructure`
 * (called in the service to stay in lockstep with change-password).
 */
export const ResetUserPasswordSchema = z.object({
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});
export type ResetUserPasswordInput = z.infer<typeof ResetUserPasswordSchema>;

/**
 * Self-edit schema for `PATCH /api/users/me`. Deliberately narrow — name +
 * avatarUrl only. Email is identity-bound (Better Auth login) and changing
 * it needs an out-of-band verification flow; role is admin-managed; team is
 * fixed at signup. `avatarUrl` is SERVER-MANAGED: uploading is done via
 * `POST /api/users/me/avatar` (which sets the stable serve-route path), so the
 * only value a client may send here is `null` to CLEAR it (revert to initials).
 * Accepting an arbitrary url would let this endpoint be abused as a hot-link
 * target and would let a client point their avatar at a bogus/foreign object.
 */
export const UpdateMyProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    avatarUrl: z.null().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no changes" });
export type UpdateMyProfileInput = z.infer<typeof UpdateMyProfileSchema>;

/**
 * Self-edit schema for `PATCH /api/users/me/availability`. Status enum mirrors
 * the shared `UserAvailabilityStatus` type. Message is bounded short — it's
 * read inline in the teammate sidebar, not a long bio. `null` clears it.
 *
 * This is its own endpoint (not folded into PATCH /me) because it's a much
 * higher-frequency change with a separate capability gate; mixing the
 * permission check at the route level keeps the profile route simple.
 */
export const UpdateMyAvailabilitySchema = z
  .object({
    status: z.enum(["available", "busy", "away", "offline"]).optional(),
    message: z.union([z.string().trim().max(100), z.null()]).optional(),
    /**
     * "Follow my schedule" — drop the manual override so working hours take
     * over immediately, instead of waiting for the next shift boundary. Sent
     * on its own; combining it with a status would be contradictory.
     */
    followSchedule: z.literal(true).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no changes" })
  .refine((b) => !(b.followSchedule && (b.status !== undefined || b.message !== undefined)), {
    message: "followSchedule cannot be combined with a status or message",
  });
export type UpdateMyAvailabilityInput = z.infer<typeof UpdateMyAvailabilitySchema>;

/**
 * Admin-for-teammate availability (`PATCH /api/users/:id/availability`), gated
 * by `availability:manageOthers`. Same shape as the self schema — the
 * difference is authorization and the resulting `availabilitySource: "admin"`,
 * not the payload.
 */
export const SetUserAvailabilitySchema = UpdateMyAvailabilitySchema;
export type SetUserAvailabilityInput = z.infer<typeof SetUserAvailabilitySchema>;

/* -------------------------------------------------------------------------
 * Working hours
 * ------------------------------------------------------------------------- */

const TimeOfDay = z
  .string()
  .regex(/^\d{1,2}:\d{2}$/, "expected HH:MM")
  .refine((v) => parseTimeOfDay(v) !== null, { message: "invalid time" });

const TimeWindowSchema = z.object({ open: TimeOfDay, close: TimeOfDay });

// Four windows a day covers a split shift with breaks; beyond that the grid
// stops being readable and is almost certainly a mistake.
const DaySchema = z.array(TimeWindowSchema).max(4);

/**
 * The schedule payload. Mirrors `WorkHours` in @ccp/shared/work-hours — the
 * runtime gate for a value that lands in a JSON column, so a malformed
 * schedule can never reach the resolver (which would silently treat a broken
 * grid as "off shift" and mark a whole team away).
 */
export const WorkHoursSchema = z.object({
  timezone: z
    .string()
    .max(64)
    .refine(isValidTimezone, { message: "unknown timezone" }),
  weekly: z.object({
    mon: DaySchema.optional(),
    tue: DaySchema.optional(),
    wed: DaySchema.optional(),
    thu: DaySchema.optional(),
    fri: DaySchema.optional(),
    sat: DaySchema.optional(),
    sun: DaySchema.optional(),
  }),
  exceptions: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
        closed: z.boolean().optional(),
        windows: DaySchema.optional(),
      }),
    )
    .max(60)
    .optional(),
});

/** `PUT /api/workspace/work-hours` — null clears the org default. */
export const SetTeamWorkHoursSchema = z.object({
  workHours: z.union([WorkHoursSchema, z.null()]),
});
export type SetTeamWorkHoursInput = z.infer<typeof SetTeamWorkHoursSchema>;

/**
 * `PUT /api/users/:id/work-hours`. `custom` requires a schedule; the other two
 * modes ignore one, so sending it is a contradiction worth rejecting rather
 * than silently dropping.
 */
export const SetUserWorkHoursSchema = z
  .object({
    mode: z.enum(["inherit", "custom", "off"]),
    workHours: z.union([WorkHoursSchema, z.null()]).optional(),
  })
  .refine((b) => b.mode !== "custom" || (b.workHours != null), {
    message: "custom mode requires a schedule",
  });
export type SetUserWorkHoursInput = z.infer<typeof SetUserWorkHoursSchema>;
