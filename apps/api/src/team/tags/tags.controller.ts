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
  CreateTagSchema,
  UpdateTagSchema,
  type CreateTagInput,
  type UpdateTagInput,
} from "./tags.schemas";
import { TagsService } from "./tags.service";

/**
 * Team-wide tag catalog. Any signed-in user can list + create; mutations of
 * an existing tag are also allowed for any agent (write access matches the
 * pre-migration Next.js routes exactly — admin gate is per-team, not
 * per-catalog-row).
 *
 * Route shape (relative to api root):
 *   GET    /api/team/tags
 *   POST   /api/team/tags
 *   PATCH  /api/team/tags/:id
 *   DELETE /api/team/tags/:id
 *
 * Caddy will route `/api/team/*` to the api process as Phase 3a flips.
 */
@Controller("api/team/tags")
@UseGuards(SessionGuard)
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const tags = await this.tags.list(session.teamId);
    return { tags };
  }

  // Per-tag contact-count map, used by settings/tags to warn before delete.
  // Static segment must come before :id routes.
  @Get("usage")
  async usage(@CurrentSession() session: ApiSession) {
    const usage = await this.tags.usage(session.teamId);
    return { usage };
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateTagSchema)) body: CreateTagInput,
  ) {
    const tag = await this.tags.create(session.teamId, body);
    return { tag };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateTagSchema)) body: UpdateTagInput,
  ) {
    const tag = await this.tags.update(session.teamId, id, body);
    return { tag };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.tags.remove(session.teamId, id);
    return { ok: true };
  }
}
