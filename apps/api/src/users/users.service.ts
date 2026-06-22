import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { assignableRoles, canModifyUser } from "@ccp/shared/auth/permissions";
import type { Role, User, UserAvailabilityStatus } from "@ccp/shared/types";

import { hashPassword, validatePasswordStructure } from "../auth/password";
import { SessionInvalidationService } from "../auth/session-invalidation.service";
import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import {
  AvatarUploadError,
  deleteAvatarByUrl,
  uploadAvatar,
} from "../lib/blob-storage/avatar";
import { mapUser } from "../lib/queries/_shared";
import type {
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
    teamId: string,
    userId: string,
    input: UpdateMyProfileInput,
  ): Promise<User> {
    const data: { name?: string; avatarUrl?: string | null } = {};
    if (typeof input.name === "string") data.name = input.name;
    if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl;

    // Default-select returns the full row — including the availability
    // columns mapUser carries through. Cheap (single-row read), and lets
    // us share one mapper across every list/edit path.
    const updated = await this.db.user.update({
      where: { id: userId },
      data,
    });
    // Bust the session cache so the next request from this user sees the
    // new name/avatar without a 15s lag.
    this.sessionInvalidator.bustCache(userId);

    await this.bus.publish({
      type: "user.profile_updated",
      teamId,
      userId,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.avatarUrl !== undefined ? { avatarUrl: data.avatarUrl } : {}),
    });

    return mapUser(updated);
  }

  /**
   * Self-edit availability. Mirrors updateMyProfile's shape:
   *   - Only mutates the fields actually sent (`status` → only status,
   *     `message: null` clears, `message: "x"` sets, omitted = unchanged).
   *   - Refuses an empty body via the Zod refine in users.schemas.ts.
   *   - Publishes a dedicated `user.availability_changed` domain event so the
   *     fanout subscriber can update teammates without piggybacking on
   *     `user.profile_updated` (heavier subscribers don't need to run).
   *   - Returns the full User row so the client can swap its local mirror
   *     in one round-trip.
   *
   * Capability `availability:manage` is enforced at the controller via the
   * `@RequireCapability` decorator — not here, so the service stays
   * orchestration-agnostic.
   */
  async updateMyAvailability(
    teamId: string,
    userId: string,
    input: UpdateMyAvailabilityInput,
  ): Promise<User> {
    const data: { availabilityStatus?: string; availabilityMessage?: string | null } = {};
    if (typeof input.status === "string") data.availabilityStatus = input.status;
    if (input.message !== undefined) data.availabilityMessage = input.message;
    // A status note is context for being UNavailable ("eating", "back at 3pm").
    // Coming back to "available" means it no longer applies, so clear it — a
    // stale note sitting next to a green dot is exactly the confusion users
    // hit. "available" wins over any `message` sent in the same PATCH.
    if (input.status === "available") data.availabilityMessage = null;

    const updated = await this.db.user.update({
      where: { id: userId },
      data,
    });
    // Availability lives on the User row that `loadActiveUser` reads, so the
    // next request from this user needs to see the new status without a 15s
    // session-cache wait — matches the profile-update pattern.
    this.sessionInvalidator.bustCache(userId);

    // Broadcast `message` whenever it changed — sent explicitly in the PATCH, OR
    // cleared implicitly by going available — so every client drops the note in
    // the same frame. `updated.availabilityMessage` is the authoritative value.
    const messageChanged =
      input.message !== undefined || input.status === "available";
    await this.bus.publish({
      type: "user.availability_changed",
      teamId,
      userId,
      status: (updated.availabilityStatus ?? "available") as UserAvailabilityStatus,
      ...(messageChanged ? { message: updated.availabilityMessage } : {}),
    });

    return mapUser(updated);
  }

  /**
   * Upload a new avatar image. Stores via the dedicated avatar blob path
   * (see lib/blob-storage/avatar.ts for the mime / size constraints) and
   * writes the resulting URL back onto the user row + publishes the same
   * `user.profile_updated` event the URL-only path uses, so subscribers
   * don't need a separate handler.
   */
  async uploadMyAvatar(
    teamId: string,
    userId: string,
    file: AvatarUploadFile,
  ): Promise<{ url: string }> {
    try {
      const prev = await this.db.user.findUnique({
        where: { id: userId },
        select: { avatarUrl: true },
      });
      const out = await uploadAvatar({
        userId,
        bytes: file.bytes,
        mimeType: file.mimeType,
        originalFilename: file.originalFilename,
      });
      await this.db.user.update({
        where: { id: userId },
        data: { avatarUrl: out.url },
      });
      // GC the prior avatar blob now that the row points at the new one — the
      // timestamped customId means the old blob would otherwise leak forever
      // (the orphan sweeper skips the `avatar-` prefix). Best-effort.
      if (prev?.avatarUrl && prev.avatarUrl !== out.url) {
        await deleteAvatarByUrl(prev.avatarUrl);
      }
      this.sessionInvalidator.bustCache(userId);
      await this.bus.publish({
        type: "user.profile_updated",
        teamId,
        userId,
        avatarUrl: out.url,
      });
      return { url: out.url };
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

  async list(teamId: string): Promise<User[]> {
    const rows = await this.db.user.findMany({
      where: { teamId },
      orderBy: { name: "asc" },
    });
    return rows.map((u) => mapUser(u));
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
    teamId: string,
    since: Date | null,
  ): Promise<MemberStat[]> {
    const atWindow = since ? { gte: since } : undefined;

    const [users, activeAssigned, sent, assignedEvents, closed] =
      await Promise.all([
        this.db.user.findMany({
          where: { teamId },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            deactivatedAt: true,
          },
        }),
        // Currently assigned & OPEN (non-closed) — point-in-time, no window.
        // Mirrors getActiveAssignments + the inbox "Mine" view: a closed chat
        // isn't active work.
        this.db.conversation.groupBy({
          by: ["assignedUserId"],
          where: {
            teamId,
            assignedUserId: { not: null },
            status: { not: "closed" },
          },
          _count: { _all: true },
        }),
        // Outbound messages in window.
        this.db.message.groupBy({
          by: ["senderUserId"],
          where: {
            teamId,
            direction: "out",
            senderUserId: { not: null },
            ...(atWindow ? { timestamp: atWindow } : {}),
          },
          _count: { _all: true },
        }),
        // Assignment actions in window — assignee lives in `after` JSON, which
        // groupBy can't key on, so fetch + tally in memory.
        this.db.conversationEvent.findMany({
          where: { teamId, kind: "assigned", ...(atWindow ? { at: atWindow } : {}) },
          select: { after: true },
        }),
        // Close actions in window — group by the acting user.
        this.db.conversationEvent.groupBy({
          by: ["userId"],
          where: {
            teamId,
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
    for (const e of assignedEvents) {
      const after = e.after;
      if (after && typeof after === "object" && !Array.isArray(after)) {
        const a = (after as Record<string, unknown>).assignedUserId;
        if (typeof a === "string") {
          assignedBy.set(a, (assignedBy.get(a) ?? 0) + 1);
        }
      }
    }

    return users.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      role: u.role as Role,
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
  async getActiveAssignments(teamId: string): Promise<Record<string, number>> {
    const rows = await this.db.conversation.groupBy({
      by: ["assignedUserId"],
      where: {
        teamId,
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
    teamId: string,
    actorRole: Role,
    actorUserId: string,
    targetId: string,
    input: UpdateUserInput,
  ) {
    const target = await this.db.user.findFirst({
      where: { id: targetId, teamId },
      select: { id: true, role: true, deactivatedAt: true },
    });
    if (!target) throw new NotFoundException({ error: "user not found" });

    if (!canModifyUser(actorRole, target.role as Role)) {
      throw new ForbiddenException({ error: "cannot modify this user" });
    }

    const data: { role?: Role; deactivatedAt?: Date | null } = {};
    const allowed = assignableRoles(actorRole);

    if (typeof input.role === "string") {
      if (!(allowed as string[]).includes(input.role)) {
        throw new ForbiddenException({ error: "role not assignable by you" });
      }
      data.role = input.role as Role;
    }
    if (typeof input.deactivated === "boolean") {
      data.deactivatedAt = input.deactivated ? new Date() : null;
    }

    // Self-edit safeguards.
    if (targetId === actorUserId) {
      if (data.role && data.role !== actorRole) {
        throw new BadRequestException({ error: "cannot change your own role" });
      }
      if (data.deactivatedAt) {
        throw new BadRequestException({ error: "cannot deactivate yourself" });
      }
    }

    // Last-active-manager guard.
    const willLoseManagerPowers =
      (data.role && data.role !== "admin" && data.role !== "superAdmin") ||
      data.deactivatedAt;
    const targetCurrentlyManages =
      (target.role === "admin" || target.role === "superAdmin") &&
      !target.deactivatedAt;
    if (willLoseManagerPowers && targetCurrentlyManages) {
      const otherManagers = await this.db.user.count({
        where: {
          teamId,
          role: { in: ["admin", "superAdmin"] },
          deactivatedAt: null,
          NOT: { id: targetId },
        },
      });
      if (otherManagers === 0) {
        throw new BadRequestException({ error: "cannot remove the last active admin" });
      }
    }

    const updated = await this.db.user.update({
      where: { id: targetId },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        deactivatedAt: true,
        createdAt: true,
      },
    });

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
    const roleChanged = data.role !== undefined;
    const deactivated = Boolean(data.deactivatedAt);
    if (roleChanged || deactivated) {
      await this.db.session.deleteMany({ where: { userId: targetId } });
      this.sessionInvalidator.revoke(
        targetId,
        deactivated ? "deactivation" : "role-change",
      );
    } else {
      this.sessionInvalidator.bustCache(targetId);
    }

    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "members" });
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
   *   2. team scope — `targetId` must belong to `teamId` (a team admin can
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
    teamId: string,
    actorRole: Role,
    targetId: string,
    newPassword: string,
  ): Promise<void> {
    const policyError = validatePasswordStructure(newPassword);
    if (policyError) {
      throw new BadRequestException({ error: policyError });
    }

    const target = await this.db.user.findFirst({
      where: { id: targetId, teamId },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException({ error: "user not found" });

    if (!canModifyUser(actorRole, target.role as Role)) {
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
    teamId: string,
    actorRole: Role,
    actorUserId: string,
    targetId: string,
  ): Promise<void> {
    const target = await this.db.user.findFirst({
      where: { id: targetId, teamId },
      select: { id: true, role: true, deactivatedAt: true },
    });
    if (!target) throw new NotFoundException({ error: "user not found" });

    if (!canModifyUser(actorRole, target.role as Role)) {
      throw new ForbiddenException({ error: "cannot delete this user" });
    }
    if (targetId === actorUserId) {
      throw new BadRequestException({ error: "cannot delete your own account" });
    }

    const targetCurrentlyManages =
      (target.role === "admin" || target.role === "superAdmin") &&
      !target.deactivatedAt;
    if (targetCurrentlyManages) {
      const otherManagers = await this.db.user.count({
        where: {
          teamId,
          role: { in: ["admin", "superAdmin"] },
          deactivatedAt: null,
          NOT: { id: targetId },
        },
      });
      if (otherManagers === 0) {
        throw new BadRequestException({ error: "cannot delete the last active admin" });
      }
    }

    await this.db.user.delete({ where: { id: targetId } });
    // Cascade-deletes Session + Account rows via FK; this call drops the
    // per-process session cache + any live Socket.io connections so the
    // user is kicked instantly rather than waiting for the 15s TTL.
    this.sessionInvalidator.revoke(targetId, "deletion");
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "members" });
  }
}

