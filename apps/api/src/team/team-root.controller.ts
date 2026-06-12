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

const SetAiAutopilotSchema = z.object({
  aiAutopilotEnabled: z.boolean(),
});
type SetAiAutopilotInput = z.infer<typeof SetAiAutopilotSchema>;

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
      select: { id: true, name: true, aiAutopilotEnabled: true },
    });
    if (!team) throw new NotFoundException({ error: "team not found" });
    return { team };
  }

  // Admin toggles whether the org uses AI Autopilot. Default false; flipping it
  // shows/hides the inbox per-conversation AI controls + gates auto-pause. Not
  // on the session (loaded fresh per page via getCurrentTeam), so no cache to
  // bust — it lands on the next page load / navigation.
  @RequireRole("admin")
  @Patch("ai-autopilot")
  async setAiAutopilot(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SetAiAutopilotSchema)) body: SetAiAutopilotInput,
  ) {
    await this.db.team.update({
      where: { id: session.teamId },
      data: { aiAutopilotEnabled: body.aiAutopilotEnabled },
    });
    return { ok: true, aiAutopilotEnabled: body.aiAutopilotEnabled };
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
