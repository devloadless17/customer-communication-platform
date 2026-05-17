import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";

import { assignableRoles, canModifyUser } from "@ccp/shared/auth/permissions";
import type { Role, User } from "@ccp/shared/types";

import { EventBus } from "../events/event-bus.module";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import type { UpdateUserInput } from "./users.schemas";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * GET /api/users. Whole team roster — used by the assignment dropdown,
   * sidebar avatars, and the message-attribution path. Every agent needs
   * this on every page load, which is why it's session-gated, not admin-gated.
   *
   * Sort by name to match the historical `listTeamMembers` unstable_cache
   * shape so the post-Step-7b switch is a wire-shape no-op.
   */
  async list(teamId: string): Promise<User[]> {
    const rows = await this.prisma.user.findMany({
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
    const target = await this.prisma.user.findFirst({
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
      const otherManagers = await this.prisma.user.count({
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

    const updated = await this.prisma.user.update({
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

    // Deactivation: drop Session rows + kick live sockets. Without this an
    // already-connected socket keeps receiving team events until next reload.
    if (data.deactivatedAt) {
      await this.prisma.session.deleteMany({ where: { userId: targetId } });
      const dropped = this.realtime.disconnectUserSockets(targetId);
      if (dropped > 0) {
        this.logger.log(`deactivate: dropped ${dropped} live socket(s) for user=${targetId}`);
      }
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
    const target = await this.prisma.user.findFirst({
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
      const otherManagers = await this.prisma.user.count({
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

    await this.prisma.user.delete({ where: { id: targetId } });
    const dropped = this.realtime.disconnectUserSockets(targetId);
    if (dropped > 0) {
      this.logger.log(`delete: dropped ${dropped} live socket(s) for user=${targetId}`);
    }
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "members" });
  }
}
