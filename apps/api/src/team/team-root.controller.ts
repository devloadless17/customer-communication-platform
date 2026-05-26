import { Body, Controller, Delete, Get, NotFoundException, Patch, UseGuards } from "@nestjs/common";
import { z } from "zod";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";
import { TeamRootService } from "./team-root.service";

/**
 * Current-team root.
 *
 *   GET    /api/team   — id + name (used by every layout for sidebar chrome)
 *   PATCH  /api/team   — admin: rename the org
 *   DELETE /api/team   — admin: permanently delete the current team
 *
 * GET is session-gated (any agent); PATCH + DELETE keep the admin gate.
 * Splitting the auth requirements via method-level @RequireRole inside an
 * otherwise session-gated controller class.
 */
const RenameTeamSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
type RenameTeamInput = z.infer<typeof RenameTeamSchema>;

@Controller("api/team")
@UseGuards(SessionGuard)
export class TeamRootController {
  constructor(
    private readonly teamRoot: TeamRootService,
    private readonly db: DbService,
  ) {}

  @Get()
  async get(@CurrentSession() session: ApiSession) {
    const team = await this.db.team.findUnique({
      where: { id: session.teamId },
      select: { id: true, name: true },
    });
    if (!team) throw new NotFoundException({ error: "team not found" });
    return { team };
  }

  @RequireRole("admin")
  @Patch()
  async rename(
    @CurrentSession() session: ApiSession,
    @Body(zBody(RenameTeamSchema)) body: RenameTeamInput,
  ) {
    const { name } = await this.teamRoot.rename(session.teamId, body.name, session.userId);
    return { team: { id: session.teamId, name } };
  }

  @RequireRole("admin")
  @Delete()
  async remove(@CurrentSession() session: ApiSession) {
    await this.teamRoot.destroy(session.teamId, "api/team");
    return { ok: true };
  }
}
