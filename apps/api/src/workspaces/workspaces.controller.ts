import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { setActiveWorkspaceCookie } from "../auth/active-workspace-cookie";
import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard, type ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { WorkspacesService } from "./workspaces.service";
import {
  CreateWorkspaceSchema,
  RenameOrganizationSchema,
  RenameWorkspaceSchema,
  SetMembershipSchema,
  SwitchWorkspaceSchema,
  type CreateWorkspaceInput,
  type RenameOrganizationInput,
  type RenameWorkspaceInput,
  type SetMembershipInput,
  type SwitchWorkspaceInput,
} from "./workspaces.schemas";

/**
 * Workspace switching.
 *
 *   GET   /api/workspaces          — the workspaces this user may act in
 *   POST  /api/workspaces/active   — switch this device's active workspace
 *   POST  /api/workspaces          — create one (org owner/admin)
 *   PATCH /api/workspaces/:id      — rename one (org owner/admin)
 *   DELETE /api/workspaces/:id     — delete it and everything in it
 *   POST  /api/workspaces/:id/members — add / re-role / remove someone
 *
 * Reads and switching carry no role gate: switching is not a privileged action,
 * and the service re-validates membership before honoring the requested id.
 * Every MUTATION of the org's shape is gated on `orgRole` inside the service,
 * not here — so the rule lives next to the data it protects and the /v1 surface
 * (if it ever gains these) can't bypass it.
 */
@Controller("api/workspaces")
@UseGuards(SessionGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    return { workspaces: await this.workspaces.list(session) };
  }

  /** Everything Organization settings renders — org, workspaces, members. */
  @Get("organization")
  organization(@CurrentSession() session: ApiSession) {
    return this.workspaces.organization(session);
  }

  @Patch("organization")
  renameOrganization(
    @CurrentSession() session: ApiSession,
    @Body(zBody(RenameOrganizationSchema)) body: RenameOrganizationInput,
  ) {
    return this.workspaces.renameOrganization(session, body.name);
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateWorkspaceSchema)) body: CreateWorkspaceInput,
  ) {
    const workspace = await this.workspaces.create(session, body.name);
    return { workspace };
  }

  @Patch(":id")
  async rename(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(RenameWorkspaceSchema)) body: RenameWorkspaceInput,
  ) {
    const workspace = await this.workspaces.rename(session, id, body.name);
    return { workspace };
  }

  /** Delete a workspace AND everything in it. Guarded in the service. */
  @Delete(":id")
  async remove(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    await this.workspaces.remove(session, id);
    return { ok: true };
  }

  /** Add, re-role, or (with `role: null`) remove a member of one workspace. */
  @Post(":id/members")
  async setMembership(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(SetMembershipSchema)) body: SetMembershipInput,
  ) {
    await this.workspaces.setMembership(session, id, body.userId, body.role);
    return { ok: true };
  }

  @Post("active")
  async setActive(
    @CurrentSession() session: ApiSession,
    @Body(zBody(SwitchWorkspaceSchema)) body: SwitchWorkspaceInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.workspaces.setActive(session, body.workspaceId);

    // Mirror the durable choice into the cookie so the NEXT request (and the
    // socket handshake, which only sees cookies) resolves the new scope without
    // waiting on a session re-read. Shared writer — operator entry
    // (`POST /api/admin/operator-access`) sets the same cookie, and the two
    // must not drift on attributes.
    setActiveWorkspaceCookie(res, body.workspaceId);

    return { ok: true, workspaceId: body.workspaceId };
  }
}
