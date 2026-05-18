import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
} from "@nestjs/common";

import {
  getTeamDetailForSuperAdmin,
  listAllTeamsForSuperAdmin,
} from "@/lib/queries";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import type { ApiSession } from "../auth/session.guard";
import { DbService } from "../db/db.service";
import { TeamRootService } from "../team/team-root.service";

/**
 * superAdmin cross-team admin surface.
 *
 *   GET    /api/admin/teams       — list every team on the platform + counts
 *   GET    /api/admin/teams/:id   — one team's detail (aggregates + members)
 *   DELETE /api/admin/teams/:id   — hard-delete (refuses operator's own team)
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
