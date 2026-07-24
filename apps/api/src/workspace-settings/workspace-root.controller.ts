import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Patch, Put, UseGuards } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";
import { WorkspaceRootService } from "./workspace-root.service";
import {
  SetTeamWorkHoursSchema,
  type SetTeamWorkHoursInput,
} from "../users/users.schemas";
import { UsersService } from "../users/users.service";
import { getBusinessNumberCountry } from "@/lib/providers/config";
import { isBicAllowedForBusinessNumber } from "@ccp/shared/providers/calling-regions";

/**
 * Current-team root.
 *
 *   GET    /api/workspace   — id + name (used by every layout for sidebar chrome)
 *   PATCH  /api/workspace   — admin: rename the org
 *   DELETE /api/workspace   — admin: permanently delete the current team
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

// AI behavior settings beyond the on/off toggle: what happens on a
// customer-initiated handoff, who greets first, and the session window. All
// optional so the UI can PATCH one field at a time.
const SetAiSettingsSchema = z.object({
  aiHandoffAction: z
    .enum(["none", "unassign", "assign_fixed", "round_robin"])
    .optional(),
  aiHandoffAssigneeId: z.string().min(1).nullable().optional(),
  firstTouchGreeter: z.enum(["ai", "workflow"]).optional(),
});
type SetAiSettingsInput = z.infer<typeof SetAiSettingsSchema>;

@Controller("api/workspace")
@UseGuards(SessionGuard)
export class WorkspaceRootController {
  constructor(
    private readonly teamRoot: WorkspaceRootService,
    private readonly db: DbService,
    // Working-hours edits re-resolve availability through the one writer in
    // UsersService rather than duplicating the rule here.
    private readonly users: UsersService,
  ) {}

  @Get()
  async get(@CurrentSession() session: ApiSession) {
    const team = await this.db.workspace.findUnique({
      where: { id: session.workspaceId },
      select: {
        id: true,
        name: true,
        aiAutopilotEnabled: true,
        aiHandoffAction: true,
        aiHandoffAssigneeId: true,
        firstTouchGreeter: true,
        // Read by the inbox shell so the client can react to live handovers
        // under agent-visibility scoping (the SERVER is the boundary; this is
        // purely so the list updates correctly).
        agentConversationVisibility: true,
      },
    });
    if (!team) throw new NotFoundException({ error: "team not found" });
    // Whether this org may place business-initiated calls at all. Follows OUR
    // business number's country — a number registered in a market where
    // business-initiated calling isn't offered can't call anyone, while an
    // eligible one can call customers anywhere. Sent once here rather than
    // derived per contact in the UI, because it is not a per-contact fact.
    const businessCountry = await getBusinessNumberCountry(session.workspaceId);
    return {
      team: {
        ...team,
        outboundCallingAvailable: isBicAllowedForBusinessNumber(businessCountry),
      },
    };
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
    await this.db.workspace.update({
      where: { id: session.workspaceId },
      data: { aiAutopilotEnabled: body.aiAutopilotEnabled },
    });
    return { ok: true, aiAutopilotEnabled: body.aiAutopilotEnabled };
  }

  // Admin configures AI handoff behavior + first-touch greeting + session
  // window. Validation (e.g. assign_fixed requires a real, active member)
  // lives in the service so the rule has one home.
  @RequireRole("admin")
  @Patch("ai-settings")
  async setAiSettings(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SetAiSettingsSchema)) body: SetAiSettingsInput,
  ) {
    const team = await this.teamRoot.updateAiSettings(session.workspaceId, body);
    return { ok: true, team };
  }

  /**
   * The org's default working hours — the schedule every member inherits
   * unless they're on `custom` or `off`. `workHours: null` clears it, which
   * returns the whole team to purely manual availability.
   *
   * Re-resolves every member's availability right after saving so the change is
   * visible immediately; the 60s sweeper then owns the ongoing boundaries.
   */
  @RequireRole("admin")
  @Put("work-hours")
  async setWorkHours(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SetTeamWorkHoursSchema)) body: SetTeamWorkHoursInput,
  ) {
    await this.db.workspace.update({
      where: { id: session.workspaceId },
      data: { workHours: body.workHours ?? Prisma.DbNull },
    });
    await this.users.resyncAvailability(session.workspaceId);
    return { ok: true, workHours: body.workHours };
  }

  @Get("work-hours")
  async getWorkHours(@CurrentSession() session: ApiSession) {
    const team = await this.db.workspace.findUnique({
      where: { id: session.workspaceId },
      select: { workHours: true },
    });
    return { workHours: team?.workHours ?? null };
  }

  @RequireRole("admin")
  @Patch()
  async rename(
    @CurrentSession() session: ApiSession,
    @Body(zBody(RenameTeamSchema)) body: RenameTeamInput,
  ) {
    const { name } = await this.teamRoot.rename(session.workspaceId, body.name, session.userId);
    return { team: { id: session.workspaceId, name } };
  }

  /**
   * Delete the whole ORGANIZATION — every workspace in it, then the org row
   * and its user directory.
   *
   * This used to destroy only `session.workspaceId`, which did not match what
   * the one UI that calls it promises ("removes the organization and EVERYTHING
   * in it — every teammate's account") and left the caller signed out into an
   * org with no workspace: unusable, invisible to the platform list (which
   * enumerates workspaces), and still holding every member's globally-unique
   * email. There is no per-workspace delete surface, so this is unambiguously
   * the tenant-level action.
   *
   * OWNER only, not workspace-admin. Now that it spans every workspace in the
   * org, a workspace-scoped `admin` would otherwise be able to destroy sibling
   * workspaces they are not even a member of.
   */
  @RequireRole("admin")
  @Delete()
  async remove(@CurrentSession() session: ApiSession) {
    if (session.orgRole !== "owner") {
      throw new ForbiddenException({
        error: "only the organization owner can delete the organization",
      });
    }
    await this.teamRoot.destroyOrganization(session.organizationId, "api/workspace");
    return { ok: true };
  }
}
