import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import {
  assignableRoles,
  canDeleteMember,
  canModifyUser,
  canModifyUserAccount,
  type UserActor,
} from "@ccp/shared/auth/permissions";
import type { OrgRole, Role, User } from "@ccp/shared/types";

import { invalidateAssignmentCache } from "@/lib/assignment/resolve";
import { detachMemberFromWorkspace } from "@/lib/workspaces/remove-member";

import { hashPassword, validatePasswordStructure } from "../auth/password";
import { SessionInvalidationService } from "../auth/session-invalidation.service";
import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import {
  AvatarUploadError,
  deleteAvatar,
  uploadAvatar,
} from "../lib/blob-storage/avatar";
import { assignedUserSelect, mapUser } from "../lib/queries/_shared";
import type {
  UpdateMyProfileInput,
  UpdateUserInput,
} from "./users.schemas";
import { invalidateSuperAdminAggregates } from "@/lib/queries";

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
   * PATCH /api/users/:id. Five layered guards:
   *   1. canModifyUser(actor, target) — admin can't touch a superAdmin.
   *   2. assignableRoles(actor) — admin can't promote to superAdmin.
   *   3. canModifyUserAccount — DEACTIVATION additionally needs org authority.
   *   4. self-edit safeguards — no self-demote / self-deactivate.
   *   5. last-active-admin guard — never strip the team of every manager.
   *
   * Guard 3 exists because this one endpoint does two things of very different
   * reach. Changing `role` affects THIS workspace and is rightly a workspace
   * admin's call. Setting `deactivated` blocks sign-in to the whole
   * organization — every workspace, every device — so it is an org-directory
   * action and is gated as one.
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
      select: {
        id: true,
        isSuperAdmin: true,
        orgRole: true,
        organizationId: true,
        deactivatedAt: true,
        // ALL memberships, not just the acting workspace's: deactivation is an
        // ORG-wide action, so its last-admin guard has to span every workspace
        // the target administers (see the guard below). The acting workspace's
        // row is picked out of this list for the role checks.
        workspaceMemberships: { select: { workspaceId: true, role: true } },
      },
    });
    if (!target) throw new NotFoundException({ error: "user_not_found" });

    const activeMembership = target.workspaceMemberships.find(
      (m) => m.workspaceId === workspaceId,
    );

    const targetActor: UserActor = {
      role: (activeMembership?.role ?? "agent") as Role,
      isSuperAdmin: target.isSuperAdmin,
      orgRole: target.orgRole as OrgRole,
    };
    if (!canModifyUser(actor, targetActor)) {
      throw new ForbiddenException({ error: "cannot_modify_this_user" });
    }

    // Role now lives on `WorkspaceMember`, not `User` — the tenancy
    // restructure removed `User.role`. Writing `role` into a `user.update`
    // `data` throws PrismaClientValidationError at runtime (a `data` write, so
    // the field checker's where/select coverage never saw it). So the two
    // changes go to two tables: the per-workspace ROLE to WorkspaceMember, and
    // DEACTIVATION (a user-global fact) to User.
    const allowed = assignableRoles(actor);
    const currentRole = (activeMembership?.role ?? "agent") as Role;

    let nextRole: Role | undefined;
    if (typeof input.role === "string") {
      if (!(allowed as string[]).includes(input.role)) {
        throw new ForbiddenException({ error: "role_not_assignable_by_you" });
      }
      nextRole = input.role as Role;
    }
    const userData: { deactivatedAt?: Date | null } = {};
    if (typeof input.deactivated === "boolean") {
      // Org-wide effect → org-wide authority. See the method comment.
      if (!canModifyUserAccount(actor, targetActor)) {
        throw new ForbiddenException({
          error: "org_admin_required",
          detail:
            "Activating or deactivating an account affects every workspace in the organization, so it's an organization owner/admin action. You can still change this person's role in this workspace.",
        });
      }
      userData.deactivatedAt = input.deactivated ? new Date() : null;
    }

    // Self-edit safeguards.
    if (targetId === actorUserId) {
      if (nextRole && nextRole !== actor.role) {
        throw new BadRequestException({ error: "cannot_change_your_own_role" });
      }
      if (userData.deactivatedAt) {
        throw new BadRequestException({ error: "cannot_deactivate_yourself" });
      }
    }

    // Last-active-manager guard.
    const willLoseManagerPowers =
      (nextRole && nextRole !== "admin") || Boolean(userData.deactivatedAt);
    const targetCurrentlyManages =
      (activeMembership?.role === "admin" || target.isSuperAdmin) &&
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
    // DEACTIVATION is org-wide (it blocks sign-in everywhere), so its
    // last-admin guard must span every workspace the target administers — not
    // just the one the actor happens to be acting in. Checking only the acting
    // workspace let an admin deactivate someone who was an agent here and the
    // SOLE admin of another workspace, leaving that workspace unconfigurable:
    // exactly the state `remove()`'s guard was rewritten to prevent. A pure
    // ROLE change stays workspace-scoped (it only affects this workspace).
    const deactivating = Boolean(userData.deactivatedAt);
    const guardedWorkspaceIds =
      deactivating && !target.deactivatedAt
        ? target.isSuperAdmin
          ? target.workspaceMemberships.map((m) => m.workspaceId)
          : target.workspaceMemberships
              .filter((m) => m.role === "admin")
              .map((m) => m.workspaceId)
        : targetCurrentlyManages
          ? [workspaceId]
          : [];

    const updated =
      willLoseManagerPowers && guardedWorkspaceIds.length > 0
        ? await this.db.$transaction(async (tx) => {
            // Lock the ORG when the guard spans several workspaces (same
            // pattern as remove()); the single-workspace case keeps its
            // narrower workspace-row lock.
            if (guardedWorkspaceIds.length > 1 || deactivating) {
              await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${target.organizationId} FOR UPDATE`;
            } else {
              await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
            }
            for (const wsId of guardedWorkspaceIds) {
              // "Another active admin exists" = an admin MEMBERSHIP in that
              // workspace, or a platform operator. Role lives on WorkspaceMember.
              const otherManagers = await tx.user.count({
                where: {
                  OR: [
                    { workspaceMemberships: { some: { workspaceId: wsId, role: "admin" } } },
                    { isSuperAdmin: true, workspaceMemberships: { some: { workspaceId: wsId } } },
                  ],
                  deactivatedAt: null,
                  NOT: { id: targetId },
                },
              });
              if (otherManagers === 0) {
                const ws =
                  wsId === workspaceId
                    ? null
                    : await tx.workspace.findUnique({
                        where: { id: wsId },
                        select: { name: true },
                      });
                throw new BadRequestException({
                  error: "cannot_remove_the_last_active_admin",
                  ...(ws
                    ? {
                        detail: `They are the only admin of ${ws.name}. Promote someone else there first — a workspace with no admin can't be configured or repaired.`,
                      }
                    : {}),
                });
              }
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
      // Deactivation removes a live seat from every count the platform roster
      // reports — see the delete path for the same bust.
      if (deactivated) invalidateSuperAdminAggregates();
    } else {
      this.sessionInvalidator.bustCache(targetId);
    }

    // A deactivated agent's open conversations would otherwise sit on a person
    // who can no longer log in — invisible in the Unassigned queue and owned by
    // nobody in practice. Route them to someone real through each workspace's
    // assignment policy (opt-out per workspace via
    // AssignmentSettings.reassignOnDeactivate).
    //
    // EVERY workspace they belong to, not just the caller's. Deactivation blocks
    // sign-in org-wide, so scoping the rebalance to the acting workspace left
    // their queues in every OTHER workspace owned by someone who can't log in —
    // the exact state this is here to prevent, just one page further away.
    //
    // Detached + best-effort ON PURPOSE: deactivation is a security action and
    // must return immediately and succeed regardless. Anything that fails to
    // re-route stays visible in the workspace inbox, and the deactivated user is
    // excluded from every future candidate pool anyway.
    if (deactivated) {
      void this.detachFromAllWorkspaces(targetId).catch((err) => {
        this.logger.warn(
          `reassign-on-deactivate failed for ${targetId}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }

    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "members" });
    return updated;
  }

  /**
   * Re-home a deactivated user's work in EVERY workspace they belong to.
   *
   * Keeps the `reassignOnDeactivate` opt-out per workspace — it is a workspace
   * setting, and one workspace choosing to leave threads put doesn't bind
   * another. Membership rows are left alone: deactivation is reversible, and
   * re-enabling someone should restore their access, not require re-inviting
   * them to every workspace.
   */
  private async detachFromAllWorkspaces(userId: string): Promise<void> {
    const memberships = await this.db.workspaceMember.findMany({
      where: { userId },
      select: { workspaceId: true },
    });
    for (const { workspaceId } of memberships) {
      const settings = await this.db.assignmentSettings.findUnique({
        where: { workspaceId },
        select: { reassignOnDeactivate: true },
      });
      const { conversationsMoved, ticketsMoved } = await detachMemberFromWorkspace(
        this.db,
        workspaceId,
        userId,
        {
          // No row = the column default, which is ON.
          rebalance: settings?.reassignOnDeactivate ?? true,
          // Deactivation is REVERSIBLE, so their grants stay: re-enabling must
          // restore the account they had, not a stripped one. Deactivated users
          // are already excluded from every candidate pool.
          clearGrants: false,
          // A deactivated account may be re-enabled tomorrow, so "owned by
          // someone inactive" beats "owned by nobody" — the offline sweeper
          // reasons the same way. Removal is the case that unassigns.
          unassignWhenNoCandidate: false,
        },
      );
      if (conversationsMoved > 0 || ticketsMoved > 0) {
        this.logger.log(
          `deactivated ${userId}: re-homed ${conversationsMoved} conversation(s), ${ticketsMoved} ticket(s) in workspace ${workspaceId}`,
        );
      }
    }
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
   *   1. canModifyUserAccount(actor, target) — ORG authority required. A reset
   *      kicks every device and hands control of the account to whoever typed
   *      the new password; that reaches every workspace the person belongs to,
   *      so administering one of them is not enough. Nobody but an owner or a
   *      superAdmin may reset an org owner's password.
   *   2. workspace scope — `targetId` must belong to `workspaceId`, so an id
   *      from another tenant is not even addressable.
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
      select: { id: true, isSuperAdmin: true, orgRole: true, workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 } },
    });
    if (!target) throw new NotFoundException({ error: "user_not_found" });

    if (
      !canModifyUserAccount(actor, {
        role: (target.workspaceMemberships[0]?.role ?? "agent") as Role,
        isSuperAdmin: target.isSuperAdmin,
        orgRole: target.orgRole as OrgRole,
      })
    ) {
      throw new ForbiddenException({
        error: "org_admin_required",
        detail:
          "Resetting someone's password signs them out of every workspace, so it's an organization owner/admin action.",
      });
    }

    const account = await this.db.account.findFirst({
      where: { userId: targetId, providerId: "credential" },
      select: { id: true },
    });
    // Every account is created with a credential row (invite-accept +
    // register both insert one). A missing row means the user never set a
    // password — nothing to reset, surface it rather than silently no-op.
    if (!account) {
      throw new BadRequestException({ error: "user_has_no_password_to_reset" });
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
   * DELETE /api/users/:id — remove the account from the ORGANIZATION entirely.
   *
   * Gates:
   *   1. canDeleteMember — org owner/admin/superAdmin may delete any non-owner;
   *      a WORKSPACE admin may delete a member too (their team), but never the
   *      owner or a platform operator.
   *   2. cross-workspace guard — a delete is org-wide, so someone relying on the
   *      workspace-admin path may only delete a person whose every workspace is
   *      one the actor administers. Org authority skips this. Without it a Sales
   *      admin could strip a teammate's Support access.
   *   3. self-delete is always refused (an admin must deactivate themselves
   *      first, deliberately separating the two actions).
   *   4. last-active-admin, checked across EVERY workspace they administer —
   *      not just the caller's. Scoping it to one workspace let a delete
   *      performed from workspace A silently leave workspace B with no admin,
   *      which its own guard calls an unrecoverable state.
   *
   * Cascade clears Session + Account + WorkspaceMember; attribution survives
   * via SetNull FKs.
   */
  async remove(
    workspaceId: string,
    actor: UserActor,
    actorUserId: string,
    targetId: string,
  ): Promise<void> {
    const target = await this.db.user.findFirst({
      where: { id: targetId, workspaceMemberships: { some: { workspaceId } } },
      select: {
        id: true,
        isSuperAdmin: true,
        orgRole: true,
        organizationId: true,
        deactivatedAt: true,
        // EVERY membership, not just the caller's workspace — the delete reaches
        // all of them, so the last-admin guard has to as well.
        workspaceMemberships: { select: { workspaceId: true, role: true } },
      },
    });
    if (!target) throw new NotFoundException({ error: "user_not_found" });

    const targetActor = {
      role: (target.workspaceMemberships.find((m) => m.workspaceId === workspaceId)?.role ??
        "agent") as Role,
      isSuperAdmin: target.isSuperAdmin,
      orgRole: target.orgRole as OrgRole,
    };

    if (!canDeleteMember(actor, targetActor)) {
      throw new ForbiddenException({
        error: "cannot_delete_member",
        detail:
          "You can remove teammates you administer, but not the organization's owner or a platform operator.",
      });
    }

    // Cross-workspace guard for the WORKSPACE-admin path. A delete is org-wide —
    // it ends the target's access to EVERY workspace — so someone acting on a
    // workspace-admin role (not org-directory authority) may only delete a
    // person whose whole footprint is inside workspaces the actor also
    // administers. Without this, an admin of Sales could remove a teammate from
    // Support, a workspace they have no authority over. Org owner/admin and
    // superAdmin have org-wide authority already, so they skip the check.
    if (!canModifyUserAccount(actor, targetActor)) {
      const actorAdminWorkspaceIds = new Set(
        (
          await this.db.workspaceMember.findMany({
            where: { userId: actorUserId, role: "admin" },
            select: { workspaceId: true },
          })
        ).map((m) => m.workspaceId),
      );
      const reachesForeignWorkspace = target.workspaceMemberships.some(
        (m) => !actorAdminWorkspaceIds.has(m.workspaceId),
      );
      if (reachesForeignWorkspace) {
        throw new ForbiddenException({
          error: "cross_workspace_delete",
          detail:
            "This person also belongs to a workspace you don't administer, and deleting them would remove them from it too. An organization owner or admin has to remove them.",
        });
      }
    }

    if (targetId === actorUserId) {
      throw new BadRequestException({ error: "cannot_delete_your_own_account" });
    }

    // Every workspace this delete could strip of its last admin.
    const administeredWorkspaceIds = target.deactivatedAt
      ? [] // already deactivated → holds no live admin seat anywhere
      : target.isSuperAdmin
        ? target.workspaceMemberships.map((m) => m.workspaceId)
        : target.workspaceMemberships
            .filter((m) => m.role === "admin")
            .map((m) => m.workspaceId);
    const memberWorkspaceIds = target.workspaceMemberships.map((m) => m.workspaceId);

    // Serialize the last-active-admin re-check + delete under an ORG-row lock
    // (SELECT ... FOR UPDATE) so two concurrent deletes/demotes can't each see
    // the other admin still active and both commit → zero admins (TOCTOU). The
    // lock is on the ORG rather than one workspace because the invariant now
    // spans every workspace the target administers. Same pattern as update()
    // and invites.accept().
    if (administeredWorkspaceIds.length > 0) {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${target.organizationId} FOR UPDATE`;
        for (const wsId of administeredWorkspaceIds) {
          // Role lives on WorkspaceMember now; a platform operator also counts.
          const otherAdmins = await tx.user.count({
            where: {
              OR: [
                { workspaceMemberships: { some: { workspaceId: wsId, role: "admin" } } },
                { isSuperAdmin: true, workspaceMemberships: { some: { workspaceId: wsId } } },
              ],
              deactivatedAt: null,
              NOT: { id: targetId },
            },
          });
          if (otherAdmins === 0) {
            const ws = await tx.workspace.findUnique({
              where: { id: wsId },
              select: { name: true },
            });
            throw new BadRequestException({
              error: "cannot_delete_the_last_active_admin",
              detail: `They are the only admin of ${ws?.name ?? "another workspace"}. Promote someone else there first — a workspace with no admin can't be configured or repaired.`,
            });
          }
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
    //
    // SCOPED to the workspaces this user actually belonged to. Without the
    // `workspaceId` clause this ran platform-wide: deleting one user swept
    // orphaned personal views out of EVERY tenant on the box. §18 — workspaceId
    // belongs in the where of every query, and this is why.
    if (memberWorkspaceIds.length > 0) {
      await this.db.inboxView
        .deleteMany({
          where: {
            workspaceId: { in: memberWorkspaceIds },
            visibility: "personal",
            createdById: null,
          },
        })
        .catch(() => undefined);
    }

    // Null the no-FK pointer columns that name this user. The delete cascaded
    // their WorkspaceMember / TeamChannelMember / TeamMember rows and
    // SetNull'd every real FK (assigned conversations, message flags, audit
    // authors), but four columns hold a user id WITHOUT a foreign key — a
    // deliberate choice so a deleted user degrades a policy rather than cascading
    // into it — and nothing clears those automatically. A `fixed`/`fallback`
    // policy still naming a now-deleted user routes every matching conversation
    // to a person who no longer exists, and the picker finds no candidate, so
    // traffic silently stops. (`cursorUserId` / the round-robin cursor dangling
    // is harmless — a rotation restart — but cleared in the same pass for
    // tidiness.) Scoped to the workspaces this user belonged to; best-effort,
    // like the GC below.
    if (memberWorkspaceIds.length > 0) {
      await Promise.all([
        this.db.team
          .updateMany({
            where: { workspaceId: { in: memberWorkspaceIds }, fixedUserId: targetId },
            data: { fixedUserId: null },
          })
          .catch(() => undefined),
        this.db.team
          .updateMany({
            where: { workspaceId: { in: memberWorkspaceIds }, fallbackUserId: targetId },
            data: { fallbackUserId: null },
          })
          .catch(() => undefined),
        this.db.team
          .updateMany({
            where: { workspaceId: { in: memberWorkspaceIds }, cursorUserId: targetId },
            data: { cursorUserId: null },
          })
          .catch(() => undefined),
        this.db.workspace
          .updateMany({
            where: { id: { in: memberWorkspaceIds }, aiRoundRobinCursorUserId: targetId },
            data: { aiRoundRobinCursorUserId: null },
          })
          .catch(() => undefined),
      ]);
      // The routing config is cached in-process per workspace; without this the
      // picker keeps handing work to a now-null `fixedUserId` until the TTL.
      for (const wsId of memberWorkspaceIds) invalidateAssignmentCache(wsId);
    }

    // GC the R2 avatar object — the orphan sweeper skips the `avatars/` prefix,
    // so a hard-deleted user's blob would otherwise leak forever. Best-effort
    // (never throws), same as the clear-avatar path in updateMyProfile.
    await deleteAvatar(targetId);
    // Cascade-deletes Session + Account rows via FK; this call drops the
    // per-process session cache + any live Socket.io connections so the
    // user is kicked instantly rather than waiting for the 15s TTL.
    this.sessionInvalidator.revoke(targetId, "deletion");
    // The platform roster's userCount / memberCount are memoized for 60s; a
    // delete changes both, and an operator who just acted must not watch the
    // console contradict them for a minute.
    invalidateSuperAdminAggregates();
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "members" });
  }
}

