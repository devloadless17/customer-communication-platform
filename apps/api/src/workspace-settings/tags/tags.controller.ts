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
  CreateTagSchema,
  UpdateTagSchema,
  type CreateTagInput,
  type UpdateTagInput,
} from "./tags.schemas";
import { TagsService } from "./tags.service";

/**
 * Team-wide tag catalog. Any signed-in user can LIST; creating / renaming /
 * deleting a tag is gated by the admin-configurable `tags:manage` capability
 * (default true for manager + agent, so today's behavior is unchanged until an
 * admin locks it down). Tags are team-wide shared catalog like stages + contact
 * fields — a rename/delete affects everyone's inbox, so it belongs behind the
 * same capability tier.
 *
 * Route shape (relative to api root):
 *   GET    /api/workspace/tags                — anyone signed in
 *   POST   /api/workspace/tags                — tags:manage
 *   PATCH  /api/workspace/tags/:id            — tags:manage
 *   DELETE /api/workspace/tags/:id            — tags:manage
 */
@Controller("api/workspace/tags")
@UseGuards(SessionGuard)
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const tags = await this.tags.list(session.workspaceId);
    return { tags };
  }

  // Per-tag contact-count map, used by settings/tags to warn before delete.
  // Static segment must come before :id routes.
  @Get("usage")
  async usage(@CurrentSession() session: ApiSession) {
    const usage = await this.tags.usage(session.workspaceId);
    return { usage };
  }

  @Post()
  @RequireCapability("tags:manage")
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateTagSchema)) body: CreateTagInput,
  ) {
    const tag = await this.tags.create(session.workspaceId, body);
    return { tag };
  }

  @Patch(":id")
  @RequireCapability("tags:manage")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateTagSchema)) body: UpdateTagInput,
  ) {
    const tag = await this.tags.update(session.workspaceId, id, body);
    return { tag };
  }

  @Delete(":id")
  @RequireCapability("tags:manage")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.tags.remove(session.workspaceId, id);
    return { ok: true };
  }
}
