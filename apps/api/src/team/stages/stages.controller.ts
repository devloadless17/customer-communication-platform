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
 * The write gate is enforced in StagesService via `canManageStages(role)`
 * — keeps the policy in one place, identical to the pre-migration routes.
 */
@Controller("api/team/stages")
@UseGuards(SessionGuard)
export class StagesController {
  constructor(private readonly stages: StagesService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const stages = await this.stages.list(session.teamId);
    return { stages };
  }

  // Static segment must come before :id routes so /counts isn't matched
  // as a stage id.
  @Get("counts")
  async counts(@CurrentSession() session: ApiSession) {
    return this.stages.counts(session.teamId);
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateStageSchema)) body: CreateStageInput,
  ) {
    const stage = await this.stages.create(session.teamId, session.role, body);
    return { stage };
  }

  // Reorder must come BEFORE the :id PATCH so /reorder isn't matched as an id.
  @Patch("reorder")
  async reorder(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ReorderStagesSchema)) body: ReorderStagesInput,
  ) {
    await this.stages.reorder(session.teamId, session.role, body);
    return { ok: true };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateStageSchema)) body: UpdateStageInput,
  ) {
    const stage = await this.stages.update(session.teamId, session.role, id, body);
    return { stage };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.stages.remove(session.teamId, session.role, id);
    return { ok: true };
  }
}
