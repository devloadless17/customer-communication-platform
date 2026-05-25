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

import { RequireCapability } from "../auth/capability.guard";
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
  StartConversationSchema,
  type AssignConversationInput,
  type BulkDeleteConversationsInput,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type MessageContextQuery,
  type SearchMessagesQuery,
  type SetConversationStatusInput,
  type StartConversationInput,
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
      filter: query.filter,
      stageId: query.stageId,
    });
  }

  /**
   * Sub-sidebar preset + per-stage counts. Computed server-side over the
   * full team so the badges don't lie when the agent has more matching
   * conversations than the inbox list currently has paged in. Refreshed
   * on socket events that can change counts (assigned / status / deleted /
   * new conversation / contact stage edit).
   *
   * Declared BEFORE every `:id` route on this controller so a future `:id`
   * GET wouldn't accidentally match `/counts` as an id.
   */
  @Get("counts")
  async counts(@CurrentSession() session: ApiSession) {
    return this.conversations.counts(session.teamId, session.userId);
  }

  /**
   * Get-or-create the conversation for a contact and return its id so the
   * client can open it in the inbox. The "re-chat after delete" entry point —
   * a hard-deleted thread strands the Contact otherwise. Declared before the
   * `:id` routes so `/start` isn't swallowed as an id. No capability gate:
   * sending a message has none either, and this is the precursor to a send.
   */
  @Post("start")
  @HttpCode(200)
  async start(
    @CurrentSession() session: ApiSession,
    @Body(zBody(StartConversationSchema)) body: StartConversationInput,
  ) {
    return this.conversations.startConversation(session.teamId, session.userId, body);
  }

  @Post("bulk")
  @RequireCapability("conversations:delete")
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

  @Get(":id/events")
  async events(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    const events = await this.conversations.listEvents(session.teamId, id);
    return { events };
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
  @RequireCapability("conversations:delete")
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
