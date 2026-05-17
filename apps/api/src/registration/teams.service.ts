import { Injectable } from "@nestjs/common";

import { DbService } from "../db/db.service";
import type { CreateTeamInput } from "./teams.schemas";

@Injectable()
export class TeamsService {
  constructor(private readonly db: DbService) {}

  /**
   * Create a new Team row. Called by the register flow AFTER Better Auth
   * has created the User (so the user can be linked to the team in a
   * follow-up patch). Idempotent? No — every call creates a new team.
   * Caller (the register server action) is responsible for one-call-per-signup.
   */
  async create(input: CreateTeamInput): Promise<{ id: string; name: string }> {
    const created = await this.db.team.create({
      data: { name: input.name },
      select: { id: true, name: true },
    });
    return created;
  }
}
