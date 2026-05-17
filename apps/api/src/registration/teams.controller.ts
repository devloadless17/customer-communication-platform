import { Body, Controller, Post } from "@nestjs/common";

import { zBody } from "../common/zod-validation.pipe";
import { CreateTeamSchema, type CreateTeamInput } from "./teams.schemas";
import { TeamsService } from "./teams.service";

/**
 * Team creation. Called by the register server action AFTER Better Auth
 * signs the new user up — at that point the user exists but has no team.
 *
 * No SessionGuard here because the register flow runs BEFORE the user has
 * a session. We trust the server-action caller to only invoke this from
 * the bootstrap flow; in prod, only the Next.js process (same VPS, same
 * trust zone) can reach this endpoint via the internal URL.
 *
 * Phase 8+ tightening (post-deploy): add a one-shot bootstrap token the
 * register action passes through. For MVP, the network boundary is enough.
 */
@Controller("api/teams")
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Post()
  async create(@Body(zBody(CreateTeamSchema)) body: CreateTeamInput) {
    const team = await this.teams.create(body);
    return { team };
  }
}
