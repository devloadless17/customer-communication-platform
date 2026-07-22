import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";

import { resolvePermissions } from "@ccp/shared/auth/permissions";

import { CurrentSession } from "../../auth/current-session.decorator";
import { SessionGuard } from "../../auth/session.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  CreateStageSchema,
  ReorderStagesSchema,
  UpdateStageSchema,
  type CreateStageInput,
  type ReorderStagesInput,
  type UpdateStageInput,
} from "./stages.schemas";
import { StagesService } from "./stages.service";

/**
 * Contact stages (customer-lifecycle catalog).
 *
 *   GET    /api/team/stages              — anyone signed in
 *   POST   /api/team/stages              — admin / manager / superAdmin
 *   PATCH  /api/team/stages/:id          — admin / manager / superAdmin
 *   DELETE /api/team/stages/:id          — admin / manager / superAdmin
 *   PATCH  /api/team/stages/reorder      — admin / manager / superAdmin
 *
 * The write gate is the admin-configurable `stages:manage` capability,
 * resolved from the session role + the team's per-role overrides and passed
 * into StagesService as a boolean (keeps the service framework-agnostic).
 */
@Controller("api/team/stages")
@UseGuards(SessionGuard)
export class StagesController {
  constructor(private readonly stages: StagesService) {}

  private canManage(session: ApiSession): boolean {
    return resolvePermissions(session.role, session.rolePermissions)["stages:manage"];
  }

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const stages = await this.stages.list(session.workspaceId);
    return { stages };
  }

  // Static segment must come before :id routes so /counts isn't matched
  // as a stage id.
  @Get("counts")
  async counts(@CurrentSession() session: ApiSession) {
    return this.stages.counts(session.workspaceId);
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateStageSchema)) body: CreateStageInput,
  ) {
    const stage = await this.stages.create(session.workspaceId, this.canManage(session), body);
    return { stage };
  }

  // Reorder must come BEFORE the :id PATCH so /reorder isn't matched as an id.
  @Patch("reorder")
  async reorder(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ReorderStagesSchema)) body: ReorderStagesInput,
  ) {
    await this.stages.reorder(session.workspaceId, this.canManage(session), body);
    return { ok: true };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateStageSchema)) body: UpdateStageInput,
  ) {
    const stage = await this.stages.update(session.workspaceId, this.canManage(session), id, body);
    return { stage };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.stages.remove(session.workspaceId, this.canManage(session), id);
    return { ok: true };
  }
}
