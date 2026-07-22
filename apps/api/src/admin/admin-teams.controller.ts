import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { z } from "zod";

import {
  getTeamDetailForSuperAdmin,
  invalidateSuperAdminAggregates,
  listAllOrgsForSuperAdmin,
  listAllTeamsForSuperAdmin,
} from "@/lib/queries";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { type ApiSession } from "../auth/session.guard";
import { SessionInvalidationService } from "../auth/session-invalidation.service";
import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";
import { TeamRootService } from "../team/team-root.service";
import { ResetUserPasswordSchema } from "../users/users.schemas";
import type { ResetUserPasswordInput } from "../users/users.schemas";
import { UsersService } from "../users/users.service";

// Approve (→ active), reactivate (→ active), or suspend (→ suspended). `reason`
// is an operator note surfaced on the suspended org's gate screen; ignored for
// `active`. One endpoint, status in the body — fewer routes than verb-per-action
// and trivially Zod-validated.
const SetStatusSchema = z.object({
  status: z.enum(["active", "suspended"]),
  reason: z.string().trim().max(500).optional(),
});
type SetStatusInput = z.infer<typeof SetStatusSchema>;

// Per-WORKSPACE seat cap. Min 1 (a workspace always has at least its founder);
// a generous upper bound keeps a typo from creating a nonsensical value.
// Default is 2 on the Workspace row — this only raises/lowers it.
const SetMaxMembersSchema = z.object({
  maxMembers: z.number().int().min(1).max(1000),
});
type SetMaxMembersInput = z.infer<typeof SetMaxMembersSchema>;

// Per-ORGANISATION workspace cap. Min 1 — an org with zero workspaces has
// nowhere to work, and the signup flow provisions one immediately.
const SetMaxWorkspacesSchema = z.object({
  maxWorkspaces: z.number().int().min(1).max(100),
});
type SetMaxWorkspacesInput = z.infer<typeof SetMaxWorkspacesSchema>;

/**
 * superAdmin cross-team admin surface.
 *
 *   GET    /api/admin/teams            — list every team on the platform + counts
 *   GET    /api/admin/teams/:id        — one team's detail (aggregates + members)
 *   PATCH  /api/admin/teams/:id/status — approve / suspend / reactivate an org
 *   DELETE /api/admin/teams/:id        — hard-delete (refuses operator's own team)
 *
 * Visibility ends at aggregate counts + the member roster — never customer
 * message bodies or contact names (see super-admin.ts query comment).
 */
@Controller("api/admin/teams")
@RequireRole("superAdmin")
export class AdminTeamsController {
  constructor(
    private readonly db: DbService,
    private readonly teamRoot: TeamRootService,
    private readonly users: UsersService,
    private readonly sessionInvalidator: SessionInvalidationService,
  ) {}

  /**
   * Platform roster, ORGANISATION-first with each org's workspaces nested.
   *
   * `teams` is still returned (flat workspace list) so nothing that consumed
   * the old shape breaks; `orgs` is what the platform page renders.
   */
  @Get()
  async list() {
    const [teams, orgs] = await Promise.all([
      listAllTeamsForSuperAdmin(),
      listAllOrgsForSuperAdmin(),
    ]);
    return { teams, orgs };
  }

  @Get(":id")
  async get(@Param("id") workspaceId: string) {
    const detail = await getTeamDetailForSuperAdmin(workspaceId);
    if (!detail) throw new NotFoundException({ error: "team not found" });
    return detail;
  }

  @Patch(":id/status")
  async setStatus(
    @CurrentSession() session: ApiSession,
    @Param("id") workspaceId: string,
    @Body(zBody(SetStatusSchema)) body: SetStatusInput,
  ) {
    // Never let an operator lock themselves out of their own org. (superAdmins
    // bypass the gate anyway, but a `suspended` self-status is still confusing
    // and pointless — refuse it like the self-delete guard does.)
    if (workspaceId === session.workspaceId) {
      throw new BadRequestException({
        error: "cannot change your own organization's status",
      });
    }
    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, organizationId: true },
    });
    if (!team) throw new NotFoundException({ error: "team not found" });

    await this.db.organization.update({
      where: { id: team.organizationId },
      data: {
        status: body.status,
        // Reason is only meaningful while suspended; clear it on (re)activation.
        statusReason: body.status === "suspended" ? body.reason ?? null : null,
        statusUpdatedAt: new Date(),
        statusUpdatedById: session.userId,
      },
    });

    // Land the change immediately for every member of the target org (their
    // team, not the operator's, so the operator's own session is untouched).
    const members = await this.db.user.findMany({
      where: { workspaceMemberships: { some: { workspaceId } } },
      select: { id: true },
    });

    if (body.status === "suspended") {
      // A suspend is a hard access-cut (non-payment / abuse / TOS), so it must
      // drop LIVE connections — busting the 15s cache alone only gates the next
      // HTTP request and leaves any already-open Socket.io tab streaming the
      // org's inbound WhatsApp + realtime team data until it reconnects.
      // `revoke` busts the cache AND kicks every socket, and socket-auth's
      // team-status gate refuses any re-handshake. We deliberately do NOT
      // delete the Better Auth Session rows: org suspension ≠ user
      // deactivation. The member is still a valid user whose ORG is suspended,
      // so their persisted session must survive for the (app) layout to render
      // the "/pending → suspended" explanation screen (with statusReason). The
      // SessionGuard 403s every API call and the layout redirects to /pending
      // on that still-valid session — access is fully cut without dumping the
      // member onto a context-free /login. (Deleting sessions added nothing
      // security-wise — the gate already blocks everything — but broke the
      // suspended-org UX; regression caught by platform.spec.ts 2026-06-11.)
      for (const m of members) this.sessionInvalidator.revoke(m.id, "suspension");
    } else {
      // Approve / reactivate: only bust the cache so a re-approved member is let
      // in on their next request without waiting out the TTL — don't needlessly
      // kick their live sockets or force a re-login.
      for (const m of members) this.sessionInvalidator.bustCache(m.id);
    }

    // The roster + overview aggregates are memoized for 60s. An admin who just
    // approved or suspended an org will look straight at that list, so a stale
    // status there would read as "the action didn't work".
    invalidateSuperAdminAggregates();

    return { ok: true };
  }

  /**
   * Set an org's member cap (default 2). Lowering it below the current active
   * count is allowed — existing members are grandfathered; the cap only blocks
   * NEW joins (invite-accept enforces it). Returns the current active count so
   * the UI can warn when the new cap is already met/exceeded.
   *
   *   PATCH /api/admin/teams/:id/max-members   { maxMembers }
   */
  @Patch(":id/max-members")
  async setMaxMembers(
    @Param("id") workspaceId: string,
    @Body(zBody(SetMaxMembersSchema)) body: SetMaxMembersInput,
  ) {
    // No self-team guard here (unlike setStatus/remove): a member cap is NOT a
    // lockout. superAdmins don't count as seats (see the count below), so an
    // operator capping their own org can't lock anyone out, and it's trivially
    // reversible by raising it again. Guarding it added zero safety and only
    // created a UI/server mismatch — the platform org-detail "Limit" control is
    // rendered for every org including the operator's own.
    // The seat cap is a WORKSPACE-level fact: a member holds a seat in a
    // workspace, not in the organisation as a whole.
    const updated = await this.db.workspace.updateMany({
      where: { id: workspaceId },
      data: { maxMembers: body.maxMembers },
    });
    if (updated.count === 0) {
      throw new NotFoundException({ error: "team not found" });
    }
    const activeMembers = await this.db.user.count({
      where: { workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null, isSuperAdmin: false },
    });
    return { ok: true, maxMembers: body.maxMembers, activeMembers };
  }

  /**
   * Raise/lower how many WORKSPACES an organisation may create.
   *
   *   PATCH /api/admin/teams/:id/max-workspaces   { maxWorkspaces }
   *
   * Addressed by a workspace id like the sibling routes (the platform detail
   * page is workspace-keyed), but writes the ORGANISATION that owns it.
   *
   * Deliberately NOT retroactive: setting a cap below the number of workspaces
   * an org already has does not delete any. It only refuses the next `create`.
   * Destroying a workspace full of conversations because someone typed a small
   * number into an admin box would be indefensible.
   */
  @Patch(":id/max-workspaces")
  async setMaxWorkspaces(
    @Param("id") workspaceId: string,
    @Body(zBody(SetMaxWorkspacesSchema)) body: SetMaxWorkspacesInput,
  ) {
    const updated = await this.db.organization.updateMany({
      where: { workspaces: { some: { id: workspaceId } } },
      data: { maxWorkspaces: body.maxWorkspaces },
    });
    if (updated.count === 0) {
      throw new NotFoundException({ error: "team not found" });
    }
    const workspace = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    const workspaceCount = workspace
      ? await this.db.workspace.count({
          where: { organizationId: workspace.organizationId },
        })
      : 0;
    return { ok: true, maxWorkspaces: body.maxWorkspaces, workspaceCount };
  }

  /**
   * Reset a member's password from the platform org-detail view. The
   * cross-team analog of `POST /api/users/:id/reset-password` (which is
   * scoped to the caller's own org). The superAdmin sets a new password and
   * hands it to the locked-out user out-of-band — same recovery story, just
   * reachable for any org the operator manages. The service scopes the lookup
   * to `workspaceId`, so a userId from another org 404s rather than leaking.
   */
  @Post(":id/members/:userId/reset-password")
  @HttpCode(200)
  async resetMemberPassword(
    @CurrentSession() session: ApiSession,
    @Param("id") workspaceId: string,
    @Param("userId") userId: string,
    @Body(zBody(ResetUserPasswordSchema)) body: ResetUserPasswordInput,
  ) {
    // Resetting your own credentials would sign you out mid-request — the
    // superAdmin uses change-password for their own account.
    if (userId === session.userId) {
      throw new BadRequestException({
        error: "Use change password to update your own account",
      });
    }
    await this.users.resetPassword(workspaceId, { role: session.role, isSuperAdmin: session.isSuperAdmin }, userId, body.newPassword);
    return { ok: true };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") workspaceId: string,
  ) {
    if (workspaceId === session.workspaceId) {
      throw new BadRequestException({
        error: "use /api/team to delete your own organization",
      });
    }
    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!team) throw new NotFoundException({ error: "team not found" });
    await this.teamRoot.destroy(workspaceId, `api/admin/teams ${workspaceId}`);
    invalidateSuperAdminAggregates();
    return { ok: true };
  }
}
