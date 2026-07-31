import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { canModifyUser, type UserActor } from "@ccp/shared/auth/permissions";
import type { Role, User } from "@ccp/shared/types";

import { SessionInvalidationService } from "../auth/session-invalidation.service";
import { DbService } from "../db/db.service";
import { AVAILABILITY_SELECT, applyAvailability } from "../lib/availability/apply";
import { loadAvailabilityScope } from "../lib/availability/schedule";
import { assignedUserSelect, mapUser } from "../lib/queries/_shared";
import type {
  SetUserAvailabilityInput,
  SetUserWorkHoursInput,
  UpdateMyAvailabilityInput,
} from "./users.schemas";

/**
 * Availability + working-hours orchestration, split out of `UsersService`
 * (which had grown into profile + roster + lifecycle + availability in one
 * class). This service owns exactly the callers-of-`applyAvailability` half:
 * the self route, the admin route, the working-hours CRUD and the post-edit
 * resync. The WRITE rules themselves stay in `lib/availability/apply.ts` —
 * the single writer shared with the shift-boundary sweeper — so the split
 * moves orchestration, never the invariant.
 */
@Injectable()
export class UserAvailabilityService {
  constructor(
    private readonly db: DbService,
    private readonly sessionInvalidator: SessionInvalidationService,
  ) {}

  /**
   * Self-edit availability.
   *   - Only mutates what's sent (`status` → only status, `message: null`
   *     clears, omitted = unchanged); `followSchedule: true` drops the override
   *     so working hours take over right now.
   *   - Refuses an empty/contradictory body via the Zod refines in
   *     users.schemas.ts.
   *   - Returns the full User row so the client can swap its local mirror in
   *     one round-trip.
   *
   * The pick itself is applied by `applyAvailability` — the single writer
   * shared with the admin route and the working-hours sweeper. It owns the
   * "available clears the note" rule, the override expiry, the write, and the
   * `user.availability_changed` publish, so those can't drift between the
   * three callers.
   *
   * Capability `availability:manage` is enforced at the controller via the
   * `@RequireCapability` decorator — not here, so the service stays
   * orchestration-agnostic.
   */
  async updateMyAvailability(
    workspaceId: string,
    userId: string,
    input: UpdateMyAvailabilityInput,
  ): Promise<User> {
    return this.writeAvailability(workspaceId, userId, input, userId);
  }

  /**
   * Admin/manager sets a TEAMMATE's availability — "he left without flipping
   * off". Gated by `availability:manageOthers` at the controller, plus the same
   * role-hierarchy check the role/deactivate route uses so a manager can't
   * override an admin.
   *
   * The result is marked `availabilitySource: "admin"` and carries the actor's
   * id, so the target (and everyone else) can see who set it rather than
   * wondering why their status changed by itself.
   */
  async setUserAvailability(
    workspaceId: string,
    /** Null when the caller is an API key rather than a member. */
    actorUserId: string | null,
    actor: UserActor,
    targetUserId: string,
    input: SetUserAvailabilityInput,
  ): Promise<User> {
    const target = await this.db.user.findFirst({
      where: { id: targetUserId, workspaceMemberships: { some: { workspaceId } } },
      select: { id: true, isSuperAdmin: true, workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 } },
    });
    if (!target) throw new NotFoundException({ error: "not_found" });
    if (!canModifyUser(actor, { role: (target.workspaceMemberships[0]?.role ?? "agent") as Role, isSuperAdmin: target.isSuperAdmin })) {
      throw new ForbiddenException({ error: "forbidden" });
    }
    return this.writeAvailability(workspaceId, targetUserId, input, actorUserId);
  }

  /**
   * Shared body of the two availability routes. `actorUserId === userId` is
   * what makes the write count as the user's own pick rather than an admin's.
   */
  private async writeAvailability(
    workspaceId: string,
    userId: string,
    input: UpdateMyAvailabilityInput,
    actorUserId: string | null,
  ): Promise<User> {
    const user = await this.db.user.findFirstOrThrow({
      where: { id: userId, workspaceMemberships: { some: { workspaceId } } },
      select: { ...AVAILABILITY_SELECT, ...assignedUserSelect(workspaceId) },
    });
    // The governing schedule + every workspace to announce to. NOT
    // `workspaceId`'s own schedule: availability is one column on the shared
    // User row, so exactly one schedule may drive it (see loadAvailabilityScope)
    // and every workspace the person is in has to hear about the result — an
    // admin flipping someone's status from workspace A must not leave workspace
    // B showing yesterday's dot.
    const scope = await loadAvailabilityScope(this.db, userId);

    await applyAvailability({
      db: this.db,
      user,
      workspaceIds: scope.workspaceIds,
      teamSchedule: scope.teamSchedule,
      intent: input.followSchedule
        ? { kind: "followSchedule" }
        : { kind: "pick", status: input.status, message: input.message, actorUserId },
      nowMs: Date.now(),
      bustSessionCache: (id) => this.sessionInvalidator.bustCache(id),
    });

    // Re-read rather than trusting the pre-write row: applyAvailability may
    // have resolved the effective status differently from the pick (off shift),
    // and the caller renders what it returns.
    // Team-scoped, and SELECTED: the default select pulls every User column
    // (including auth material) to feed mapUser, which reads ~10 fields.
    const updated = await this.db.user.findFirstOrThrow({
      where: { id: userId, workspaceMemberships: { some: { workspaceId } } },
      select: { ...AVAILABILITY_SELECT, ...assignedUserSelect(workspaceId) },
    });
    return mapUser(updated, workspaceId);
  }

  /**
   * A teammate's schedule config + the default they'd inherit.
   *
   * The inherited default is the GOVERNING one (`loadAvailabilityScope`), not
   * whichever workspace the admin happens to be looking from. For anyone in a
   * single workspace those are the same thing; for a member of two, showing the
   * viewing workspace's grid would have the editor preview a schedule that will
   * never be applied to them.
   */
  async getUserWorkHours(
    workspaceId: string,
    userId: string,
  ): Promise<{ mode: string; workHours: unknown; teamWorkHours: unknown }> {
    const user = await this.db.user.findFirst({
      where: { id: userId, workspaceMemberships: { some: { workspaceId } } },
      select: { workHoursMode: true, workHours: true },
    });
    if (!user) throw new NotFoundException({ error: "not_found" });
    const { teamSchedule } = await loadAvailabilityScope(this.db, userId);
    return {
      mode: user.workHoursMode,
      workHours: user.workHours ?? null,
      teamWorkHours: teamSchedule,
    };
  }

  /**
   * Set a teammate's working-hours mode/schedule, then immediately re-resolve
   * their availability so the change is visible now instead of at the next
   * 60s sweeper tick.
   */
  async setUserWorkHours(
    workspaceId: string,
    actor: UserActor,
    targetUserId: string,
    input: SetUserWorkHoursInput,
  ): Promise<User> {
    const target = await this.db.user.findFirst({
      where: { id: targetUserId, workspaceMemberships: { some: { workspaceId } } },
      select: { id: true, isSuperAdmin: true, workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 } },
    });
    if (!target) throw new NotFoundException({ error: "not_found" });
    if (!canModifyUser(actor, { role: (target.workspaceMemberships[0]?.role ?? "agent") as Role, isSuperAdmin: target.isSuperAdmin })) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    await this.db.user.update({
      where: { id: targetUserId },
      data: {
        workHoursMode: input.mode,
        // Keep a custom schedule on file when switching to inherit/off, so
        // flipping back doesn't lose the grid someone filled in. Only an
        // explicit `workHours: null` clears it.
        ...(input.workHours !== undefined
          ? { workHours: input.workHours ?? Prisma.DbNull }
          : {}),
      },
    });

    await this.resyncAvailability(workspaceId, [targetUserId]);
    const updated = await this.db.user.findFirstOrThrow({
      where: { id: targetUserId, workspaceMemberships: { some: { workspaceId } } },
      select: { ...AVAILABILITY_SELECT, ...assignedUserSelect(workspaceId) },
    });
    return mapUser(updated, workspaceId);
  }

  /**
   * Re-resolve availability for the given users (or the whole team when no ids
   * are passed) against the current clock and schedules. Called after any
   * schedule edit so the effect is immediate; the sweeper does the same thing
   * on its own cadence for the boundaries nobody is around to trigger.
   */
  async resyncAvailability(workspaceId: string, userIds?: string[]): Promise<void> {
    const users = await this.db.user.findMany({
      where: {
        workspaceMemberships: { some: { workspaceId } },
        deactivatedAt: null,
        ...(userIds ? { id: { in: userIds } } : {}),
      },
      select: { ...AVAILABILITY_SELECT, ...assignedUserSelect(workspaceId) },
    });
    const nowMs = Date.now();
    for (const user of users) {
      // Per user, because the governing schedule is a property of the PERSON
      // (their own grid, else their primary workspace's default) rather than of
      // the workspace this edit was made from.
      const scope = await loadAvailabilityScope(this.db, user.id);
      if (scope.workspaceIds.length === 0) continue;
      await applyAvailability({
        db: this.db,
        user,
        workspaceIds: scope.workspaceIds,
        teamSchedule: scope.teamSchedule,
        // Every caller of this method is a SCHEDULE EDIT (org default or a
        // member's own), so a live override must be re-anchored to the new
        // schedule rather than keep an expiry pointing at the old one's
        // boundary. The sweeper uses the plain "sync" intent instead.
        intent: { kind: "rescheduled" },
        nowMs,
        bustSessionCache: (id) => this.sessionInvalidator.bustCache(id),
      });
    }
  }
}
