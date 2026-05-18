import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { InvitesService } from "./invites.service";
import { CreateInviteSchema, type CreateInviteInput } from "./invites.schemas";

/**
 * Team invites — admin-only.
 *
 *   GET    /api/invites            — list pending invites
 *   POST   /api/invites            — create + return shareable URL
 *   DELETE /api/invites/:id        — revoke pending invite
 *
 * Already-accepted invites are NOT shown in list and cannot be revoked
 * (they're historical rows; remove the resulting User instead).
 */
@Controller("api/invites")
@RequireRole("admin")
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const invites = await this.invites.list(session.teamId);
    return { invites };
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Req() req: Request,
    @Body(zBody(CreateInviteSchema)) body: CreateInviteInput,
  ) {
    const originUrl = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    const invite = await this.invites.create(
      session.teamId,
      session.role,
      session.userId,
      originUrl,
      body,
    );
    return { invite };
  }

  @Delete(":id")
  async revoke(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.invites.revoke(session.teamId, id);
    return { ok: true };
  }
}
