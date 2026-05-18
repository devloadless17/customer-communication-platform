import { Body, Controller, Delete, Get, Param, Patch, UseGuards } from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { UpdateUserSchema, type UpdateUserInput } from "./users.schemas";
import { UsersService } from "./users.service";

/**
 * Team member roster + management.
 *
 *   GET    /api/users        — list teammates (any session — the assignment
 *                              dropdown + sidebar need this for every agent)
 *   PATCH  /api/users/:id    — change role, activate/deactivate (admin)
 *   DELETE /api/users/:id    — hard-delete (admin)
 *
 * Auth split: SessionGuard at class level (any logged-in user can list),
 * RequireRole on mutating methods. Authorization details in UsersService.
 */
@Controller("api/users")
@UseGuards(SessionGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const users = await this.users.list(session.teamId);
    return { users };
  }

  @RequireRole("admin")
  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateUserSchema)) body: UpdateUserInput,
  ) {
    const user = await this.users.update(
      session.teamId,
      session.role,
      session.userId,
      id,
      body,
    );
    return { user };
  }

  @RequireRole("admin")
  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.users.remove(session.teamId, session.role, session.userId, id);
    return { ok: true };
  }
}
