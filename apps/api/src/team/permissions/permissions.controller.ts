import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";

import {
  ALL_CAPABILITIES,
  resolvePermissions,
  type RolePermissionsConfig,
} from "@ccp/shared/auth/permissions";
import { zRolePermissions } from "@ccp/shared/auth/permissions-schema";

import { RequireRole } from "../../auth/role.guard";
import { CurrentSession } from "../../auth/current-session.decorator";
import { invalidateSessionCache } from "../../auth/session.guard";
import { SessionGuard } from "../../auth/session.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import { DbService } from "../../db/db.service";
import { EventBus } from "../../events/event-bus.module";

/**
 * Admin-configurable per-role capability matrix.
 *
 *   GET   /api/team/permissions   — any signed-in member; returns the EFFECTIVE
 *                                   grid (defaults overlaid with the team's
 *                                   stored overrides) so the UI can render the
 *                                   true state, and so a restricted member can
 *                                   see what they're allowed to do.
 *   PATCH /api/team/permissions   — admin only; persists overrides for the
 *                                   editable roles (manager / agent).
 *
 * admin/superAdmin are never stored and always resolve to all-true — the org
 * owner can't lock themselves out.
 */
@Controller("api/team/permissions")
@UseGuards(SessionGuard)
export class PermissionsController {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  @Get()
  async get(@CurrentSession() session: ApiSession) {
    const config = await this.load(session.workspaceId);
    return {
      capabilities: ALL_CAPABILITIES,
      // Effective resolved map per editable role (defaults + overrides).
      permissions: {
        manager: resolvePermissions("manager", config),
        agent: resolvePermissions("agent", config),
      },
    };
  }

  @RequireRole("admin")
  @Patch()
  async update(
    @CurrentSession() session: ApiSession,
    @Body(zBody(zRolePermissions)) body: RolePermissionsConfig,
  ) {
    await this.db.workspace.update({
      where: { id: session.workspaceId },
      data: { rolePermissions: body },
    });

    // Bust the per-user session cache for the whole team so the new matrix
    // lands immediately instead of waiting out the 15s TTL. A team has tens of
    // users, not thousands, so this loop is cheap. (Mirrors the deactivation
    // invalidation pattern in session.guard.ts.)
    const members = await this.db.user.findMany({
      where: { workspaceMemberships: { some: { workspaceId: session.workspaceId } } },
      select: { id: true },
    });
    for (const m of members) invalidateSessionCache(m.id);

    // Fan a catalog-change frame so every open tab on the team re-renders
    // capability-gated UI on the next router.refresh. Without this, a
    // demoted user still sees the buttons they no longer have access to
    // (the server still 403s, but the gated control stays visible) until
    // they navigate.
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId: session.workspaceId,
      scope: "members",
    });

    return {
      ok: true,
      permissions: {
        manager: resolvePermissions("manager", body),
        agent: resolvePermissions("agent", body),
      },
    };
  }

  private async load(workspaceId: string): Promise<RolePermissionsConfig> {
    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { rolePermissions: true },
    });
    return (team?.rolePermissions ?? {}) as RolePermissionsConfig;
  }
}
