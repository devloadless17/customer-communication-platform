import { Controller, Delete, Get, NotFoundException, UseGuards } from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { PrismaService } from "../prisma/prisma.service";
import { TeamRootService } from "./team-root.service";

/**
 * Current-team root.
 *
 *   GET    /api/team   — id + name (used by every layout for sidebar chrome)
 *   DELETE /api/team   — admin: permanently delete the current team
 *
 * GET is session-gated (any agent); DELETE keeps the admin gate. Splitting
 * the auth requirements via a method-level @RequireRole inside an otherwise
 * session-gated controller class.
 */
@Controller("api/team")
@UseGuards(SessionGuard)
export class TeamRootController {
  constructor(
    private readonly teamRoot: TeamRootService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async get(@CurrentSession() session: ApiSession) {
    const team = await this.prisma.team.findUnique({
      where: { id: session.teamId },
      select: { id: true, name: true },
    });
    if (!team) throw new NotFoundException({ error: "team not found" });
    return { team };
  }

  @RequireRole("admin")
  @Delete()
  async remove(@CurrentSession() session: ApiSession) {
    await this.teamRoot.destroy(session.teamId, "api/team");
    return { ok: true };
  }
}
