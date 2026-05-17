import {
  Body,
  Controller,
  Delete,
  Get,
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
  CreateSnippetSchema,
  UpdateSnippetSchema,
  type CreateSnippetInput,
  type UpdateSnippetInput,
} from "./snippets.schemas";
import { SnippetsService } from "./snippets.service";

/**
 * Team snippets (reply-box quick replies).
 *
 *   GET    /api/team/snippets
 *   POST   /api/team/snippets
 *   PATCH  /api/team/snippets/:id
 *   DELETE /api/team/snippets/:id
 *
 * Any signed-in team member can create / edit / delete. The model carries
 * `createdById` for a future per-user permission layer.
 */
@Controller("api/team/snippets")
@UseGuards(SessionGuard)
export class SnippetsController {
  constructor(private readonly snippets: SnippetsService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const snippets = await this.snippets.list(session.teamId);
    return { snippets };
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateSnippetSchema)) body: CreateSnippetInput,
  ) {
    const created = await this.snippets.create(session.teamId, session.userId, body);
    return { ok: true, id: created.id };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateSnippetSchema)) body: UpdateSnippetInput,
  ) {
    await this.snippets.update(session.teamId, id, body);
    return { ok: true };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.snippets.remove(session.teamId, id);
    return { ok: true };
  }
}
