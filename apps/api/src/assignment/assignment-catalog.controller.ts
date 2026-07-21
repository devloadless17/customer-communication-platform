import { Controller, Get, UseGuards } from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { DbService } from "../db/db.service";

/**
 * Read-only policy catalog: `[{ id, name, isDefault }]`.
 *
 * A separate controller from `AssignmentController` purely because that one is
 * `@RequireRole("admin")` at the class level, and `RequireRole` registers the
 * guard via `UseGuards` — method-level metadata can narrow the requirement but
 * can't remove the guard. Rather than unpick the class decorator (and risk
 * accidentally exposing a write route), the one endpoint that genuinely needs a
 * wider audience lives here.
 *
 * Who needs it: the workflow builder's `assign_to` step and the broadcast
 * composer, both of which managers use. A policy NAME is not sensitive — unlike
 * the admin overview, which exposes every member's live workload.
 */
@Controller("api/team/assignment-policies")
@UseGuards(SessionGuard)
export class AssignmentCatalogController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const policies = await this.db.assignmentPolicy.findMany({
      where: { teamId: session.teamId, archivedAt: null },
      select: { id: true, name: true, isDefault: true, strategy: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    return { policies };
  }
}
