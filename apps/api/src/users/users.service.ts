import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { assignableRoles, canModifyUser, type UserActor } from "@ccp/shared/auth/permissions";
import type { Role, User } from "@ccp/shared/types";

import { rebalanceDeactivatedUser } from "@/lib/sweepers/assignment-rebalance";

import { hashPassword, validatePasswordStructure } from "../auth/password";
import { SessionInvalidationService } from "../auth/session-invalidation.service";
import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import {
  AvatarUploadError,
  deleteAvatar,
  uploadAvatar,
} from "../lib/blob-storage/avatar";
import { AVAILABILITY_SELECT, applyAvailability } from "../lib/availability/apply";

import { teamScheduleOf } from "../lib/availability/schedule";
import { assignedUserSelect, mapUser } from "../lib/queries/_shared";
import type {
  SetUserAvailabilityInput,
  SetUserWorkHoursInput,
  UpdateMyAvailabilityInput,
  UpdateMyProfileInput,
  UpdateUserInput,
} from "./users.schemas";

/**
 * Multer-style upload payload for the avatar route. Re-declared here so the
 * service stays decoupled from Express types.
 */
export interface AvatarUploadFile {
  bytes: Uint8Array;
  mimeType: string;
  originalFilename: string | null;
}

/** Per-member activity row for the team-activity settings page. */
export interface MemberStat {
  userId: string;
  name: string;
  email: string;
  role: Role;
  deactivated: boolean;
  /** Chats CURRENTLY assigned to them (point-in-time — ignores the period). */
  activeAssigned: number;
  /** Assignment actions TO them within the period. */
  assigned: number;
  /** Outbound messages they authored within the period. */
  messagesSent: number;
  /** Close actions they performed within the period. */
  closed: number;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
    private readonly sessionInvalidator: SessionInvalidationService,
  ) {}

  /**
   * GET /api/users. Whole team roster — used by the assignment dropdown,
   * sidebar avatars, and the message-attribution path. Every agent needs
   * this on every page load, which is why it's session-gated, not admin-gated.
   *
   * Sort by name to match the historical `listTeamMembers` unstable_cache
   * shape so the post-Step-7b switch is a wire-shape no-op.
   */
  /**
   * Self-profile update. Bypasses the admin-only PATCH /:id because the user
   * is editing themselves — the four-layered admin gate at .update() would
   * forbid this for non-admin agents who legitimately want to change their
   * own name or avatar.
   *
   * Only mutates the fields actually sent. `avatarUrl: null` clears it,
   * `avatarUrl: "<url>"` swaps it, omitting the field leaves it alone.
   */
  async updateMyProfile(
    workspaceId: string,
    userId: string,
    input: UpdateMyProfileInput,
  ): Promise<User> {
    const data: { name?: string; avatarUrl?: string | null } = {};
    if (typeof input.name === "string") data.name = input.name;
    // `avatarUrl` is server-managed (see users.schemas): clients may only send
    // `null` to clear. Setting it is done by uploadMyAvatar. On clear, GC the
    // R2 object too (the orphan sweeper skips the `avatars/` prefix, so it
    // would otherwise leak forever).
    if (input.avatarUrl === null) {
      data.avatarUrl = null;
      await deleteAvatar(userId);
    }

    // Default-select returns the full row — including the availability
    // columns mapUser carries through. Cheap (single-row read), and lets
    // us share one mapper across every list/edit path.
    const updated = await this.db.user.update({
      where: { id: userId },
      data,
      select: assignedUserSelect(workspaceId),
    });
    // Bust the session cache so the next request from this user sees the
    // new name/avatar without a 15s lag.
    this.sessionInvalidator.bustCache(userId);

    await this.bus.publish({
      type: "user.profile_updated",
      workspaceId,
      userId,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.avatarUrl !== undefined ? { avatarUrl: data.avatarUrl } : {}),
    });

    return mapUser(updated, workspaceId);
  }

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
    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { workHours: true },
    });

    await applyAvailability({
      db: this.db,
      user,
      workspaceId,
      teamSchedule: teamScheduleOf(team),
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

  /** A teammate's schedule config + the org default they'd inherit. */
  async getUserWorkHours(
    workspaceId: string,
    userId: string,
  ): Promise<{ mode: string; workHours: unknown; teamWorkHours: unknown }> {
    const user = await this.db.user.findFirst({
      where: { id: userId, workspaceMemberships: { some: { workspaceId } } },
      select: { workHoursMode: true, workHours: true },
    });
    if (!user) throw new NotFoundException({ error: "not_found" });
    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { workHours: true },
    });
    return {
      mode: user.workHoursMode,
      workHours: user.workHours ?? null,
      teamWorkHours: team?.workHours ?? null,
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
    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { workHours: true },
    });
    const teamSchedule = teamScheduleOf(team);
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
      await applyAvailability({
        db: this.db,
        user,
        workspaceId,
        teamSchedule,
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

  /**
   * Upload a new avatar image. Stores via the dedicated avatar blob path
   * (see lib/blob-storage/avatar.ts for the mime / size constraints) and
   * writes the resulting URL back onto the user row + publishes the same
   * `user.profile_updated` event the URL-only path uses, so subscribers
   * don't need a separate handler.
   */
  async uploadMyAvatar(
    workspaceId: string,
    userId: string,
    file: AvatarUploadFile,
  ): Promise<{ url: string }> {
    try {
      await uploadAvatar({
        userId,
        bytes: file.bytes,
        mimeType: file.mimeType,
        originalFilename: file.originalFilename,
      });
      // `avatarUrl` holds a STABLE same-origin route path — the bucket is
      // private, so the UI can't render an R2 URL directly; it renders this
      // route, which auth-checks then 302s to a fresh presigned URL. The
      // avatar object key is deterministic (`avatars/{userId}`), so a replace
      // overwrites in place — no prior blob to GC.
      // `?v` busts the browser/img cache on replace — the route path itself is
      // stable (deterministic key), so without a version a swapped avatar would
      // keep showing the old cached image.
      const avatarUrl = `/api/users/${userId}/avatar?v=${Date.now()}`;
      await this.db.user.update({
        where: { id: userId },
        data: { avatarUrl },
      });
      this.sessionInvalidator.bustCache(userId);
      await this.bus.publish({
        type: "user.profile_updated",
        workspaceId,
        userId,
        avatarUrl,
      });
      return { url: avatarUrl };
    } catch (err) {
      if (err instanceof AvatarUploadError) {
        if (err.code === "unsupported_mime" || err.code === "empty_file" || err.code === "too_large") {
          throw new BadRequestException({ error: err.code, detail: err.message });
        }
        throw new BadRequestException({ error: err.code, detail: err.message });
      }
      throw err;
    }
  }

  /**
   * Does this user (scoped to the caller's team) have an avatar object? Gates
   * the `GET /api/users/:userId/avatar` presign route — 404 otherwise so we
   * never redirect to a nonexistent R2 object. Team-scoped so one team can't
   * probe another's avatars.
   */
  async hasAvatar(workspaceId: string, userId: string): Promise<boolean> {
    const row = await this.db.user.findFirst({
      where: { id: userId, workspaceMemberships: { some: { workspaceId } } },
      select: { avatarUrl: true },
    });
    return Boolean(row?.avatarUrl);
  }

  async list(workspaceId: string): Promise<User[]> {
    const rows = await this.db.user.findMany({
      where: { workspaceMemberships: { some: { workspaceId } } },
      orderBy: { name: "asc" },
      select: assignedUserSelect(workspaceId),
    });
    return rows.map((u) => mapUser(u, workspaceId));
  }

  /**
   * Per-member activity for the team-activity settings page (admin-only).
   *   - activeAssigned — chats CURRENTLY assigned (Conversation.assignedUserId);
   *                      point-in-time, NOT windowed by `since`.
   *   - assigned       — assignment actions TO them in the window. Sourced from
   *                      the audit log (ConversationEvent kind=assigned,
   *                      after.assignedUserId), because the denormalized
   *                      Conversation columns can't tell us per-period counts.
   *   - messagesSent   — outbound messages authored in the window (by timestamp).
   *   - closed         — close actions in the window (audit kind=status_changed,
   *                      after.status=closed, by the acting user). The audit is
   *                      used (not Conversation.closedByUserId) because a reopen
   *                      clears the denormalized field, undercounting the period.
   *
   * `since` null = all-time. Five reads in parallel, merged in memory; all
   * team-scoped, all default to 0.
   */
  async getMemberStats(
    workspaceId: string,
    since: Date | null,
  ): Promise<MemberStat[]> {
    const atWindow = since ? { gte: since } : undefined;

    const [users, activeAssigned, sent, assignedCounts, closed] =
      await Promise.all([
        this.db.user.findMany({
          where: { workspaceMemberships: { some: { workspaceId } } },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            email: true,
            workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 },
            deactivatedAt: true,
          },
        }),
        // Currently assigned & OPEN (non-closed) — point-in-time, no window.
        // Mirrors getActiveAssignments + the inbox "Mine" view: a closed chat
        // isn't active work.
        this.db.conversation.groupBy({
          by: ["assignedUserId"],
          where: {
            workspaceId,
            assignedUserId: { not: null },
            status: { not: "closed" },
          },
          _count: { _all: true },
        }),
        // Outbound messages in window.
        this.db.message.groupBy({
          by: ["senderUserId"],
          where: {
            workspaceId,
            direction: "out",
            senderUserId: { not: null },
            ...(atWindow ? { timestamp: atWindow } : {}),
          },
          _count: { _all: true },
        }),
        // Assignment actions in window — assignee lives in `after` JSON, which
        // Prisma groupBy can't key on. Aggregate DB-side on the JSON path
        // instead of fetching every row into memory (the `all` default window
        // is unbounded and grows forever otherwise).
        this.db.$queryRaw<{ uid: string | null; count: bigint }[]>`
          SELECT "after"->>'assignedUserId' AS uid, COUNT(*) AS count
          FROM "ConversationEvent"
          WHERE "workspaceId" = ${workspaceId}
            AND kind = 'assigned'::"ConversationEventKind"
            ${since ? Prisma.sql`AND "at" >= ${since}` : Prisma.empty}
          GROUP BY 1
        `,
        // Close actions in window — group by the acting user.
        this.db.conversationEvent.groupBy({
          by: ["userId"],
          where: {
            workspaceId,
            kind: "status_changed",
            userId: { not: null },
            after: { path: ["status"], equals: "closed" },
            ...(atWindow ? { at: atWindow } : {}),
          },
          _count: { _all: true },
        }),
      ]);

    const activeBy = new Map(
      activeAssigned.map((r) => [r.assignedUserId, r._count._all]),
    );
    const sentBy = new Map(sent.map((r) => [r.senderUserId, r._count._all]));
    const closedBy = new Map(closed.map((r) => [r.userId, r._count._all]));

    const assignedBy = new Map<string, number>();
    for (const r of assignedCounts) {
      if (r.uid) assignedBy.set(r.uid, Number(r.count));
    }

    return users.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      role: (u.workspaceMemberships[0]?.role ?? "agent") as Role,
      deactivated: u.deactivatedAt != null,
      activeAssigned: activeBy.get(u.id) ?? 0,
      assigned: assignedBy.get(u.id) ?? 0,
      messagesSent: sentBy.get(u.id) ?? 0,
      closed: closedBy.get(u.id) ?? 0,
    }));
  }

  /**
   * Just the live "current activity" numbers: open (non-closed) conversations
   * assigned to each user, right now. A single grouped count — cheap enough to
   * be re-polled on every assignment/status socket event. Keyed by userId;
   * users with zero are simply absent (the client defaults them to 0).
   */
  async getActiveAssignments(workspaceId: string): Promise<Record<string, number>> {
    const rows = await this.db.conversation.groupBy({
      by: ["assignedUserId"],
      where: {
        workspaceId,
        assignedUserId: { not: null },
        status: { not: "closed" },
      },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (r.assignedUserId) out[r.assignedUserId] = r._count._all;
    }
    return out;
  }

  /**
   * PATCH /api/users/:id. Four layered guards:
   *   1. canModifyUser(actor, target) — admin can't touch a superAdmin.
   *   2. assignableRoles(actor) — admin can't promote to superAdmin.
   *   3. self-edit safeguards — no self-demote / self-deactivate.
   *   4. last-active-admin guard — never strip the team of every manager.
   */
  async update(
    workspaceId: string,
    actor: UserActor,
    actorUserId: string,
    targetId: string,
    input: UpdateUserInput,
  ) {
    const target = await this.db.user.findFirst({
      where: { id: targetId, workspaceMemberships: { some: { workspaceId } } },
      select: { id: true, isSuperAdmin: true, deactivatedAt: true, workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 } },
    });
    if (!target) throw new NotFoundException({ error: "user not found" });

    if (!canModifyUser(actor, { role: (target.workspaceMemberships[0]?.role ?? "agent") as Role, isSuperAdmin: target.isSuperAdmin })) {
      throw new ForbiddenException({ error: "cannot modify this user" });
    }

    // Role now lives on `WorkspaceMember`, not `User` — the tenancy
    // restructure removed `User.role`. Writing `role` into a `user.update`
    // `data` throws PrismaClientValidationError at runtime (a `data` write, so
    // the field checker's where/select coverage never saw it). So the two
    // changes go to two tables: the per-workspace ROLE to WorkspaceMember, and
    // DEACTIVATION (a user-global fact) to User.
    const allowed = assignableRoles(actor);
    const currentRole = (target.workspaceMemberships[0]?.role ?? "agent") as Role;

    let nextRole: Role | undefined;
    if (typeof input.role === "string") {
      if (!(allowed as string[]).includes(input.role)) {
        throw new ForbiddenException({ error: "role not assignable by you" });
      }
      nextRole = input.role as Role;
    }
    const userData: { deactivatedAt?: Date | null } = {};
    if (typeof input.deactivated === "boolean") {
      userData.deactivatedAt = input.deactivated ? new Date() : null;
    }

    // Self-edit safeguards.
    if (targetId === actorUserId) {
      if (nextRole && nextRole !== actor.role) {
        throw new BadRequestException({ error: "cannot change your own role" });
      }
      if (userData.deactivatedAt) {
        throw new BadRequestException({ error: "cannot deactivate yourself" });
      }
    }

    // Last-active-manager guard.
    const willLoseManagerPowers =
      (nextRole && nextRole !== "admin") || Boolean(userData.deactivatedAt);
    const targetCurrentlyManages =
      (target.workspaceMemberships[0]?.role === "admin" || target.isSuperAdmin) &&
      !target.deactivatedAt;

    const userSelect = {
      id: true,
      name: true,
      email: true,
      workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 },
      deactivatedAt: true,
      createdAt: true,
    } satisfies Prisma.UserSelect;

    // Apply both writes on one client: the membership role FIRST, so the
    // `user.update`'s `userSelect` re-reads the fresh role. Wrapped in a
    // transaction whenever a role changes so the pair is atomic.
    const applyWrites = async (client: Prisma.TransactionClient | DbService) => {
      if (nextRole !== undefined && nextRole !== currentRole) {
        await client.workspaceMember.update({
          where: { userId_workspaceId: { userId: targetId, workspaceId } },
          data: { role: nextRole },
        });
      }
      return client.user.update({ where: { id: targetId }, data: userData, select: userSelect });
    };

    // When the write could strip the last manager, the re-count + update must
    // be serialized per team — otherwise two concurrent demote/deactivate
    // mutations each see the OTHER admin still active and both commit, leaving
    // zero managers (check-then-write TOCTOU). A `SELECT ... FOR UPDATE` on the
    // team row serializes them so the second waits and re-reads. Same pattern
    // as invites.accept()'s member-cap enforcement.
    const updated =
      willLoseManagerPowers && targetCurrentlyManages
        ? await this.db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
            // "Another active admin exists" = an admin MEMBERSHIP in this
            // workspace, or a platform operator. Role lives on WorkspaceMember.
            const otherManagers = await tx.user.count({
              where: {
                OR: [
                  { workspaceMemberships: { some: { workspaceId, role: "admin" } } },
                  { isSuperAdmin: true, workspaceMemberships: { some: { workspaceId } } },
                ],
                deactivatedAt: null,
                NOT: { id: targetId },
              },
            });
            if (otherManagers === 0) {
              throw new BadRequestException({ error: "cannot remove the last active admin" });
            }
            return applyWrites(tx);
          })
        : nextRole !== undefined && nextRole !== currentRole
          ? await this.db.$transaction((tx) => applyWrites(tx))
          : await this.db.user.update({ where: { id: targetId }, data: userData, select: userSelect });

    // Privilege-altering changes — delete every Session row + revoke so
    // the user has to re-authenticate on every device with the new role
    // (or, if deactivated, doesn't get to authenticate at all). Without
    // this:
    //   - A demoted admin keeps their cached "admin" ApiSession for up to
    //     15s, including the authorization check on every controller.
    //   - An admin who deactivates a user leaves that user's open sockets
    //     subscribed to team events until reload.
    //
    // For non-privilege updates (just a name / avatar change), we only
    // bust the cache so the next render shows the new value without a 15s
    // lag — sockets stay alive so the user isn't logged out on a profile
    // edit.
    const roleChanged = nextRole !== undefined && nextRole !== currentRole;
    const deactivated = Boolean(userData.deactivatedAt);
    if (roleChanged || deactivated) {
      await this.db.session.deleteMany({ where: { userId: targetId } });
      this.sessionInvalidator.revoke(
        targetId,
        deactivated ? "deactivation" : "role-change",
      );
    } else {
      this.sessionInvalidator.bustCache(targetId);
    }

    // A deactivated agent's open conversations would otherwise sit on a person
    // who can no longer log in — invisible in the Unassigned queue and owned by
    // nobody in practice. Route them to someone real through the team's
    // assignment policy (opt-out via AssignmentSettings.reassignOnDeactivate).
    //
    // Detached + best-effort ON PURPOSE: deactivation is a security action and
    // must return immediately and succeed regardless. Anything that fails to
    // re-route stays visible in the team inbox, and the deactivated user is
    // excluded from every future candidate pool anyway.
    if (deactivated) {
      void rebalanceDeactivatedUser(workspaceId, targetId)
        .then((moved) => {
          if (moved > 0) {
            this.logger.log(
              `reassigned ${moved} conversation(s) from deactivated user ${targetId}`,
            );
          }
        })
        .catch((err) => {
          this.logger.warn(
            `reassign-on-deactivate failed for ${targetId}: ${err instanceof Error ? err.message : err}`,
          );
        });
    }

    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "members" });
    return updated;
  }

  /**
   * Admin-initiated password reset. The recovery path for a locked-out
   * teammate: there's no self-serve email reset (no mail provider by design),
   * so an admin/superAdmin sets a new password directly and hands it to the
   * user out-of-band. Reuses the SAME bcrypt path as register / change-password
   * (`hashPassword`) and writes the same `Account.password` row Better Auth
   * verifies against — no separate hash scheme.
   *
   * Gates:
   *   1. canModifyUser(actor, target) — admin can't reset a superAdmin's
   *      password; superAdmin can reset anyone's.
   *   2. team scope — `targetId` must belong to `workspaceId` (a team admin can
   *      only touch their own org; the superAdmin path passes the org's id).
   *
   * On success EVERY session for the target is deleted + revoked, so any
   * device still holding the old password's session is kicked — the same
   * "credentials rotated, re-authenticate everywhere" guarantee
   * change-password gives. (The UI gates self-reset out of both entry points
   * — an admin rotates their OWN password via /settings/account — so this
   * always operates on someone else; the unconditional revoke is correct.)
   */
  async resetPassword(
    workspaceId: string,
    actor: UserActor,
    targetId: string,
    newPassword: string,
  ): Promise<void> {
    const policyError = validatePasswordStructure(newPassword);
    if (policyError) {
      throw new BadRequestException({ error: policyError });
    }

    const target = await this.db.user.findFirst({
      where: { id: targetId, workspaceMemberships: { some: { workspaceId } } },
      select: { id: true, isSuperAdmin: true, workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 } },
    });
    if (!target) throw new NotFoundException({ error: "user not found" });

    if (!canModifyUser(actor, { role: (target.workspaceMemberships[0]?.role ?? "agent") as Role, isSuperAdmin: target.isSuperAdmin })) {
      throw new ForbiddenException({ error: "cannot reset this user's password" });
    }

    const account = await this.db.account.findFirst({
      where: { userId: targetId, providerId: "credential" },
      select: { id: true },
    });
    // Every account is created with a credential row (invite-accept +
    // register both insert one). A missing row means the user never set a
    // password — nothing to reset, surface it rather than silently no-op.
    if (!account) {
      throw new BadRequestException({ error: "user has no password to reset" });
    }

    const newHash = await hashPassword(newPassword);
    await this.db.account.update({
      where: { id: account.id },
      data: { password: newHash },
    });

    // Credentials rotated — invalidate every session for the target so a
    // device still authenticated with the old password can't keep working
    // for the 15s cache window. Mirrors change-password's invalidation, but
    // drops ALL sessions (admin resetting someone else has no "this tab" to
    // preserve).
    await this.db.session.deleteMany({ where: { userId: targetId } });
    this.sessionInvalidator.revoke(targetId, "password-reset");
  }

  /**
   * DELETE /api/users/:id. Same gate stack as PATCH except self-delete is
   * always refused (admin must deactivate themselves first, deliberately
   * separating the two actions). Cascade clears Session + Account; attribution
   * survives via SetNull FKs.
   */
  async remove(
    workspaceId: string,
    actor: UserActor,
    actorUserId: string,
    targetId: string,
  ): Promise<void> {
    const target = await this.db.user.findFirst({
      where: { id: targetId, workspaceMemberships: { some: { workspaceId } } },
      select: { id: true, isSuperAdmin: true, deactivatedAt: true, workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 } },
    });
    if (!target) throw new NotFoundException({ error: "user not found" });

    if (!canModifyUser(actor, { role: (target.workspaceMemberships[0]?.role ?? "agent") as Role, isSuperAdmin: target.isSuperAdmin })) {
      throw new ForbiddenException({ error: "cannot delete this user" });
    }
    if (targetId === actorUserId) {
      throw new BadRequestException({ error: "cannot delete your own account" });
    }

    const targetCurrentlyManages =
      (target.workspaceMemberships[0]?.role === "admin" || target.isSuperAdmin) &&
      !target.deactivatedAt;

    // Serialize the last-active-manager re-check + delete under a per-team lock
    // (SELECT ... FOR UPDATE) so two concurrent deletes/demotes can't each see
    // the other admin still active and both commit → zero managers (TOCTOU).
    // Same pattern as update() and invites.accept().
    if (targetCurrentlyManages) {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
        // Role lives on WorkspaceMember now; a platform operator also counts.
        const otherManagers = await tx.user.count({
          where: {
            OR: [
              { workspaceMemberships: { some: { workspaceId, role: "admin" } } },
              { isSuperAdmin: true, workspaceMemberships: { some: { workspaceId } } },
            ],
            deactivatedAt: null,
            NOT: { id: targetId },
          },
        });
        if (otherManagers === 0) {
          throw new BadRequestException({ error: "cannot delete the last active admin" });
        }
        await tx.user.delete({ where: { id: targetId } });
      });
    } else {
      await this.db.user.delete({ where: { id: targetId } });
    }
    // GC this user's PERSONAL inbox views. `InboxView.createdById` is SetNull
    // (deliberately — a SHARED view must outlive the agent who created it), so
    // without this a personal view survives as a row nobody can ever see or
    // delete: it belongs to no one, and the visibility read requires a real
    // owner id. Shared views are untouched. Same best-effort GC placement as
    // the avatar below — the user row is already gone at this point, so these
    // rows are unreachable either way.
    await this.db.inboxView
      .deleteMany({ where: { visibility: "personal", createdById: null } })
      .catch(() => undefined);

    // GC the R2 avatar object — the orphan sweeper skips the `avatars/` prefix,
    // so a hard-deleted user's blob would otherwise leak forever. Best-effort
    // (never throws), same as the clear-avatar path in updateMyProfile.
    await deleteAvatar(targetId);
    // Cascade-deletes Session + Account rows via FK; this call drops the
    // per-process session cache + any live Socket.io connections so the
    // user is kicked instantly rather than waiting for the 15s TTL.
    this.sessionInvalidator.revoke(targetId, "deletion");
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "members" });
  }
}

