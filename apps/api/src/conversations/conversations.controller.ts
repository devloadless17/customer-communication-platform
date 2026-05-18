import {
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
import { zBody, zQuery } from "../common/zod-validation.pipe";
import { ConversationsService } from "./conversations.service";
import {
  AssignConversationSchema,
  BulkDeleteConversationsSchema,
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  MessageContextQuerySchema,
  SearchMessagesQuerySchema,
  SetConversationStatusSchema,
  type AssignConversationInput,
  type BulkDeleteConversationsInput,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type MessageContextQuery,
  type SearchMessagesQuery,
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
    @Query(zQuery(ListConversationsQuerySchema)) query: ListConversationsQuery,
  ) {
    return this.conversations.list(session.teamId, session.userId, {
      take: query.take,
      cursor: query.cursor ?? null,
      search: query.search,
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
    @Query(zQuery(ListMessagesQuerySchema)) query: ListMessagesQuery,
  ) {
    return this.conversations.listMessages(session.teamId, id, {
      before: query.before ?? null,
      after: query.after ?? null,
      take: query.take,
    });
  }

  @Get(":id/messages/search")
  async searchMessages(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query(zQuery(SearchMessagesQuerySchema)) query: SearchMessagesQuery,
  ) {
    const q = (query.q ?? "").trim();
    if (q.length === 0) {
      return { items: [], nextCursor: null, totalMatched: 0 };
    }
    return this.conversations.searchMessages(session.teamId, id, {
      query: q,
      take: query.take,
      cursor: query.cursor,
    });
  }

  @Get(":id/messages/context")
  async messageContext(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query(zQuery(MessageContextQuerySchema)) query: MessageContextQuery,
  ) {
    return this.conversations.messageContext(session.teamId, id, {
      messageId: query.messageId,
      before: query.before,
      after: query.after,
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

  @Post(":id/unread")
  @HttpCode(200)
  async markUnread(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.conversations.markUnread(session.teamId, id);
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
