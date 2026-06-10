import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
} from "@nestjs/common";
import { z } from "zod";

import {
  getTeamDetailForSuperAdmin,
  listAllTeamsForSuperAdmin,
} from "@/lib/queries";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { invalidateSessionCache, type ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";
import { TeamRootService } from "../team/team-root.service";

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

    // Bust the 15s session cache for every member of the target org so the
    // change lands immediately — a suspend cuts API + socket access on the very
    // next request instead of waiting out the TTL; an approval lets them in at
    // once. Their team, not the operator's, so the operator's session is intact.
    const members = await this.db.user.findMany({
      where: { teamId },
      select: { id: true },
    });
    for (const m of members) invalidateSessionCache(m.id);

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
