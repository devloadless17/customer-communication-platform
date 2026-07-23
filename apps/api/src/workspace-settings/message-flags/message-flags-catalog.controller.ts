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
  CreateFlagDefinitionSchema,
  UpdateFlagDefinitionSchema,
  type CreateFlagDefinitionInput,
  type UpdateFlagDefinitionInput,
} from "./message-flags-catalog.schemas";
import { MessageFlagsCatalogService } from "./message-flags-catalog.service";

/**
 * The team-wide message-flag catalog (which triage flags exist).
 *
 * Any signed-in user can LIST — every agent needs the picker. Mutating the
 * catalog is gated by `messageFlags:manage`, exactly like `tags:manage`: a
 * rename or archive changes what the whole team sees.
 *
 * Note the split: this gates the CATALOG only. RAISING and RESOLVING a flag is
 * triage work every agent must be able to do and is deliberately ungated —
 * see apps/api/src/message-flags/message-flags.controller.ts.
 *
 *   GET    /api/workspace/message-flags          — anyone signed in (live only)
 *   GET    /api/workspace/message-flags/usage    — messageFlags:manage (settings)
 *   POST   /api/workspace/message-flags          — messageFlags:manage
 *   PATCH  /api/workspace/message-flags/:id      — messageFlags:manage
 *   DELETE /api/workspace/message-flags/:id      — messageFlags:manage
 */
@Controller("api/workspace/message-flags")
@UseGuards(SessionGuard)
export class MessageFlagsCatalogController {
  constructor(private readonly catalog: MessageFlagsCatalogService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const definitions = await this.catalog.list(session.workspaceId);
    return { definitions };
  }

  /** Settings view — archived included, plus usage counts. Static segment must
   *  come before the `:id` routes. */
  @Get("usage")
  @RequireCapability("messageFlags:manage")
  async usage(@CurrentSession() session: ApiSession) {
    const definitions = await this.catalog.listWithUsage(session.workspaceId);
    return { definitions };
  }

  @Post()
  @RequireCapability("messageFlags:manage")
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateFlagDefinitionSchema)) body: CreateFlagDefinitionInput,
  ) {
    const definition = await this.catalog.create(session.workspaceId, body);
    return { definition };
  }

  @Patch(":id")
  @RequireCapability("messageFlags:manage")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateFlagDefinitionSchema)) body: UpdateFlagDefinitionInput,
  ) {
    const definition = await this.catalog.update(session.workspaceId, id, body);
    return { definition };
  }

  @Delete(":id")
  @RequireCapability("messageFlags:manage")
  async remove(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    await this.catalog.remove(session.workspaceId, id);
    return { ok: true };
  }
}
