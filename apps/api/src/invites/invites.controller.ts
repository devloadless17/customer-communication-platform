import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { InvitesService } from "./invites.service";
import { CreateInviteSchema, type CreateInviteInput } from "./invites.schemas";
import { RateLimit } from "@/common/rate-limit.interceptor";

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
// Every write here sends real outbound mail to an address the caller types.
// The 300/min/user default is not a mail bound — see the resend cooldown in
// InvitesService.create for the per-recipient half of the same problem.
@RateLimit({ perMinute: 20 })
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const invites = await this.invites.list(session.workspaceId);
    return { invites };
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Req() req: Request,
    @Body(zBody(CreateInviteSchema)) body: CreateInviteInput,
  ) {
    const originUrl = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    // Inviting into ANOTHER workspace of the same org is allowed (Organization
    // settings does it); inviting into another ORG's workspace is not. The
    // check is here rather than trusting the body because `workspaceId` is
    // client input — the same rule as every other tenant-scoped id.
    const targetWorkspaceId = await this.invites.resolveTargetWorkspace(session, body.workspaceId);
    const invite = await this.invites.create(
      targetWorkspaceId,
      { role: session.role, isSuperAdmin: session.isSuperAdmin },
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
    await this.invites.revoke(session.workspaceId, id);
    return { ok: true };
  }
}
