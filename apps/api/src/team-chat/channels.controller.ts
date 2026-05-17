import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { ChannelsService } from "./channels.service";
import {
  CreateChannelSchema,
  EditChannelMessageSchema,
  PostChannelMessageSchema,
  ToggleReactionSchema,
  UpdateChannelSchema,
  type CreateChannelInput,
  type EditChannelMessageInput,
  type PostChannelMessageInput,
  type ToggleReactionInput,
  type UpdateChannelInput,
} from "./channels.schemas";

/**
 * Team-chat channels: channels CRUD + messages CRUD + pins + reactions.
 *
 *   GET    /api/team/channels                              — list
 *   POST   /api/team/channels                              — create (admin/manager)
 *   PATCH  /api/team/channels/:id                          — rename / edit
 *   DELETE /api/team/channels/:id                          — admin only
 *   GET    /api/team/channels/:id/messages                 — list (?before / ?after / ?take)
 *   POST   /api/team/channels/:id/messages                 — post top-level
 *   PATCH  /api/team/channels/:id/messages/:mid            — edit (author-only, time-limited)
 *   DELETE /api/team/channels/:id/messages/:mid            — author or admin
 *   POST   /api/team/channels/:id/messages/:mid/pin        — pin (admin/manager)
 *   DELETE /api/team/channels/:id/messages/:mid/pin        — unpin
 *   POST   /api/team/channels/:id/messages/:mid/reactions  — toggle reaction
 *
 * Thread replies, media uploads, mark-read, and pins-list are not in this
 * batch — they're separate routes that follow the same delegation pattern.
 */
@Controller("api/team/channels")
@UseGuards(SessionGuard)
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const items = await this.channels.list(session.teamId, session.userId);
    return { items };
  }

  // `default` is a static segment — must come before any `:id` route below
  // so Express doesn't match it as a channel id.
  @Get("default")
  async getDefault(@CurrentSession() session: ApiSession) {
    const channel = await this.channels.getDefault(session.teamId);
    return { channel };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateChannelSchema)) body: CreateChannelInput,
  ) {
    const channel = await this.channels.create(session.teamId, session.userId, session.role, body);
    return { channel };
  }

  @Patch(":id")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateChannelSchema)) body: UpdateChannelInput,
  ) {
    const channel = await this.channels.update(session.teamId, session.role, id, body);
    return { channel };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.channels.remove(session.teamId, session.role, id);
    return { ok: true };
  }

  @Get(":id/messages")
  async listMessages(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query("after") after?: string,
    @Query("before") before?: string,
    @Query("take") take?: string,
  ) {
    return this.channels.listMessages(session.teamId, id, {
      after,
      before,
      take: take ? Number.parseInt(take, 10) : undefined,
    });
  }

  @Post(":id/messages")
  async postMessage(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(PostChannelMessageSchema)) body: PostChannelMessageInput,
  ) {
    const out = await this.channels.postMessage(session.teamId, session.userId, id, body);
    return { ok: true, ...out };
  }

  @Patch(":id/messages/:mid")
  async editMessage(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
    @Body(zBody(EditChannelMessageSchema)) body: EditChannelMessageInput,
  ) {
    const out = await this.channels.editMessage(session.teamId, session.userId, id, mid, body);
    return { ok: true, ...out };
  }

  @Delete(":id/messages/:mid")
  async deleteMessage(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
  ) {
    await this.channels.deleteMessage(
      session.teamId,
      session.userId,
      session.role,
      id,
      mid,
    );
    return { ok: true };
  }

  @Post(":id/messages/:mid/pin")
  async pin(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
  ) {
    await this.channels.pinMessage(session.teamId, session.userId, session.role, id, mid);
    return { ok: true };
  }

  @Delete(":id/messages/:mid/pin")
  async unpin(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
  ) {
    await this.channels.unpinMessage(session.teamId, session.role, id, mid);
    return { ok: true };
  }

  @Post(":id/messages/:mid/reactions")
  async react(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("mid") mid: string,
    @Body(zBody(ToggleReactionSchema)) body: ToggleReactionInput,
  ) {
    const out = await this.channels.toggleReaction(session.teamId, session.userId, id, mid, body);
    return { ok: true, ...out };
  }
}
