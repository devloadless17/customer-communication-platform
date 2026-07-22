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

import { RequireCapability } from "../../auth/capability.guard";
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
 *   GET    /api/team/snippets        — anyone signed in
 *   POST   /api/team/snippets        — snippets:manage
 *   PATCH  /api/team/snippets/:id    — snippets:manage
 *   DELETE /api/team/snippets/:id    — snippets:manage
 *
 * Create / edit / delete is gated by the admin-configurable `snippets:manage`
 * capability (default true for manager + agent — unchanged from before until an
 * admin locks it down). Snippets are team-wide shared content; deleting one
 * removes a canned reply for everyone, so it sits at the same tier as the other
 * team-catalog mutations. The model carries `createdById` for a future
 * per-user (private snippet) layer.
 */
@Controller("api/team/snippets")
@UseGuards(SessionGuard)
export class SnippetsController {
  constructor(private readonly snippets: SnippetsService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const snippets = await this.snippets.list(session.workspaceId);
    return { snippets };
  }

  @Post()
  @RequireCapability("snippets:manage")
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateSnippetSchema)) body: CreateSnippetInput,
  ) {
    const created = await this.snippets.create(session.workspaceId, session.userId, body);
    return { ok: true, id: created.id };
  }

  @Patch(":id")
  @RequireCapability("snippets:manage")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateSnippetSchema)) body: UpdateSnippetInput,
  ) {
    await this.snippets.update(session.workspaceId, id, body);
    return { ok: true };
  }

  @Delete(":id")
  @RequireCapability("snippets:manage")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.snippets.remove(session.workspaceId, id);
    return { ok: true };
  }
}
