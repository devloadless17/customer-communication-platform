import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { assignableRoles, canModifyUser } from "@ccp/shared/auth/permissions";
import type { Role, User } from "@ccp/shared/types";

import { SessionInvalidationService } from "../auth/session-invalidation.service";
import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import {
  AvatarUploadError,
  uploadAvatar,
} from "../lib/blob-storage/avatar";
import type { UpdateMyProfileInput, UpdateUserInput } from "./users.schemas";

/**
 * Multer-style upload payload for the avatar route. Re-declared here so the
 * service stays decoupled from Express types.
 */
export interface AvatarUploadFile {
  bytes: Uint8Array;
  mimeType: string;
  originalFilename: string | null;
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

    const updated = await this.db.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        teamId: true,
        role: true,
        name: true,
        email: true,
        avatarUrl: true,
        createdAt: true,
        deactivatedAt: true,
      },
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

    return {
      id: updated.id,
      teamId: updated.teamId,
      role: updated.role as Role,
      name: updated.name,
      email: updated.email,
      ...(updated.avatarUrl ? { avatarUrl: updated.avatarUrl } : {}),
      createdAt: updated.createdAt.toISOString(),
      isActive: updated.deactivatedAt === null,
    };
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
    return rows.map((u) => ({
      id: u.id,
      teamId: u.teamId,
      role: u.role as Role,
      name: u.name,
      email: u.email,
      ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
      createdAt: u.createdAt.toISOString(),
      isActive: u.deactivatedAt === null,
    }));
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
