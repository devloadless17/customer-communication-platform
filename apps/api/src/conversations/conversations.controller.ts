import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { ConversationsService } from "./conversations.service";
import {
  AssignConversationSchema,
  BulkDeleteConversationsSchema,
  SetConversationStatusSchema,
  type AssignConversationInput,
  type BulkDeleteConversationsInput,
  type SetConversationStatusInput,
} from "./conversations.schemas";

/**
 * Single-conversation operations. List + bulk live in their own controllers.
 *
 *   DELETE /api/conversations/:id              — hard delete + cascade
 *   POST   /api/conversations/:id/assign       — assign / unassign
 *   POST   /api/conversations/:id/status       — open / pending / closed
 *   POST   /api/conversations/:id/read         — mark read + Meta blue ticks
 *   POST   /api/conversations/:id/typing       — forward typing indicator to Meta
 */
@Controller("api/conversations")
@UseGuards(SessionGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  async list(
    @CurrentSession() session: ApiSession,
    @Query("cursor") cursor?: string,
    @Query("take") takeRaw?: string,
    @Query("search") search?: string,
  ) {
    const take = takeRaw ? Number.parseInt(takeRaw, 10) : undefined;
    return this.conversations.list(session.teamId, session.userId, {
      take,
      cursor: cursor ?? null,
      search,
    });
  }

  @Post("bulk")
  async bulkDelete(
    @CurrentSession() session: ApiSession,
    @Body(zBody(BulkDeleteConversationsSchema)) body: BulkDeleteConversationsInput,
  ) {
    const out = await this.conversations.bulkDelete(session.teamId, session.userId, body);
    return { ok: true, count: out.count };
  }

  @Get(":id/messages")
  async listMessages(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query("before") before?: string,
    @Query("after") after?: string,
    @Query("take") takeRaw?: string,
  ) {
    const take = takeRaw ? Number.parseInt(takeRaw, 10) : undefined;
    return this.conversations.listMessages(session.teamId, id, {
      before: before ?? null,
      after: after ?? null,
      take,
    });
  }

  @Get(":id/messages/search")
  async searchMessages(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query("q") qRaw?: string,
    @Query("cursor") cursor?: string,
    @Query("take") takeRaw?: string,
  ) {
    const query = (qRaw ?? "").trim();
    if (query.length === 0) {
      return { items: [], nextCursor: null, totalMatched: 0 };
    }
    if (query.length > 200) {
      throw new BadRequestException({ error: "query too long" });
    }
    const take = takeRaw ? Number.parseInt(takeRaw, 10) : undefined;
    return this.conversations.searchMessages(session.teamId, id, {
      query,
      take,
      cursor,
    });
  }

  @Get(":id/messages/context")
  async messageContext(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query("messageId") messageId?: string,
    @Query("before") beforeRaw?: string,
    @Query("after") afterRaw?: string,
  ) {
    if (!messageId) throw new BadRequestException({ error: "messageId required" });
    // Cap window dimensions so a malformed client can't request a 20k-msg slice.
    const CONTEXT_WINDOW_MAX = 100;
    const parseClamped = (raw: string | undefined): number | undefined => {
      if (raw === undefined) return undefined;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) return undefined;
      return Math.min(parsed, CONTEXT_WINDOW_MAX);
    };
    return this.conversations.messageContext(session.teamId, id, {
      messageId,
      before: parseClamped(beforeRaw),
      after: parseClamped(afterRaw),
    });
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.conversations.remove(session.teamId, session.userId, id);
    return { ok: true };
  }

  @Post(":id/assign")
  @HttpCode(200)
  async assign(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(AssignConversationSchema)) body: AssignConversationInput,
  ) {
    await this.conversations.assign(session.teamId, session.userId, id, body);
    return { ok: true };
  }

  @Post(":id/status")
  @HttpCode(200)
  async setStatus(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(SetConversationStatusSchema)) body: SetConversationStatusInput,
  ) {
    await this.conversations.setStatus(session.teamId, session.userId, id, body);
    return { ok: true };
  }

  @Post(":id/read")
  @HttpCode(200)
  async markRead(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.conversations.markRead(session.teamId, session.userId, id);
    return { ok: true };
  }

  @Post(":id/typing")
  @HttpCode(200)
  async typing(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    return this.conversations.sendTyping(session.teamId, id);
  }
}
