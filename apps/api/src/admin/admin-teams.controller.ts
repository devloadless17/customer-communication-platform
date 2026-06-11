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

  @Get()
  async list() {
    const teams = await listAllTeamsForSuperAdmin();
    return { teams };
  }

  @Get(":id")
  async get(@Param("id") teamId: string) {
    const detail = await getTeamDetailForSuperAdmin(teamId);
    if (!detail) throw new NotFoundException({ error: "team not found" });
    return detail;
  }

  @Patch(":id/status")
  async setStatus(
    @CurrentSession() session: ApiSession,
    @Param("id") teamId: string,
    @Body(zBody(SetStatusSchema)) body: SetStatusInput,
  ) {
    // Never let an operator lock themselves out of their own org. (superAdmins
    // bypass the gate anyway, but a `suspended` self-status is still confusing
    // and pointless — refuse it like the self-delete guard does.)
    if (teamId === session.teamId) {
      throw new BadRequestException({
        error: "cannot change your own organization's status",
      });
    }
    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) throw new NotFoundException({ error: "team not found" });

    await this.db.team.update({
      where: { id: teamId },
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
      where: { teamId },
      select: { id: true },
    });

    if (body.status === "suspended") {
      // A suspend is a hard access-cut (non-payment / abuse / TOS), so it must
      // also drop LIVE connections — busting the 15s cache alone only gates the
      // next HTTP request and leaves any already-open Socket.io tab streaming
      // the org's inbound WhatsApp + realtime team data until it reconnects.
      // `revoke` busts the cache AND kicks every socket; deleting the Session
      // rows first means a kicked tab can't simply re-handshake with its still
      // -valid Better Auth session (the socket-auth + SessionGuard team-status
      // gate would refuse it, but a full sign-out is the cleaner contract and
      // mirrors user deactivation exactly). superAdmin members are exempt from
      // the gate, but revoking them here is harmless — they re-auth normally.
      await this.db.session.deleteMany({
        where: { userId: { in: members.map((m) => m.id) } },
      });
      for (const m of members) this.sessionInvalidator.revoke(m.id, "suspension");
    } else {
      // Approve / reactivate: only bust the cache so a re-approved member is let
      // in on their next request without waiting out the TTL — don't needlessly
      // kick their live sockets or force a re-login.
      for (const m of members) this.sessionInvalidator.bustCache(m.id);
    }

    return { ok: true };
  }

  /**
   * Reset a member's password from the platform org-detail view. The
   * cross-team analog of `POST /api/users/:id/reset-password` (which is
   * scoped to the caller's own org). The superAdmin sets a new password and
   * hands it to the locked-out user out-of-band — same recovery story, just
   * reachable for any org the operator manages. The service scopes the lookup
   * to `teamId`, so a userId from another org 404s rather than leaking.
   */
  @Post(":id/members/:userId/reset-password")
  @HttpCode(200)
  async resetMemberPassword(
    @CurrentSession() session: ApiSession,
    @Param("id") teamId: string,
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
    await this.users.resetPassword(teamId, session.role, userId, body.newPassword);
    return { ok: true };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") teamId: string,
  ) {
    if (teamId === session.teamId) {
      throw new BadRequestException({
        error: "use /api/team to delete your own organization",
      });
    }
    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) throw new NotFoundException({ error: "team not found" });
    await this.teamRoot.destroy(teamId, `api/admin/teams ${teamId}`);
    return { ok: true };
  }
}
