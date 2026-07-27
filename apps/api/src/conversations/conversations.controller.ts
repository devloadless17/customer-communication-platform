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
import { resolvePermissions } from "@ccp/shared/auth/permissions";

import { ScopedByConversation } from "../auth/conversation-visibility.guard";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import { RateLimit } from "../common/rate-limit.interceptor";
import { actorFromSession, InboxViewsService } from "../inbox-views/inbox-views.service";
import { ConversationsService } from "./conversations.service";
import {
  AssignConversationSchema,
  BulkDeleteConversationsSchema,
  ListAttachmentsQuerySchema,
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  MessageContextQuerySchema,
  SearchMessagesQuerySchema,
  SetConversationAiEnabledSchema,
  SetConversationStatusSchema,
  StartConversationSchema,
  TypingSchema,
  type AssignConversationInput,
  type BulkDeleteConversationsInput,
  type ListAttachmentsQuery,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type MessageContextQuery,
  type SearchMessagesQuery,
  type SetConversationAiEnabledInput,
  type SetConversationStatusInput,
  type StartConversationInput,
  type TypingInput,
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
// Agent conversation-visibility boundary. Class-level so EVERY `:id` route
// here is covered — including ones added later. Collection routes (list,
// counts) have no `:id` and scope inside their own query instead.
@ScopedByConversation("id")
// Read-tier rate limit (1200/min ≈ 20/s) on its OWN token bucket — the bucket
// key includes perMinute, so this never shares budget with the 300/min default
// or the 60/min `messages.send`. A cold inbox open fires ~10-15 parallel reads
// and `markRead` fires on EVERY visible thread mount, so a power-navigating
// agent must not drain a shared default and 429 their own reads / starve their
// assign-status-note budget. Every route here is cheap, team-scoped, and
// (deletes) capability-gated, so the generous ceiling carries no abuse vector.
@RateLimit({ perMinute: 1200 })
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly views: InboxViewsService,
  ) {}

  @Get()
  async list(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(ListConversationsQuerySchema)) query: ListConversationsQuery,
  ) {
    // A saved view is resolved HERE, not in the service: the lookup is
    // membership-scoped (`shared OR mine`), so an id belonging to another
    // workspace — or to a teammate's personal view — 404s before it can ever
    // become a WHERE clause. `resolveFilters` then drops references to tags /
    // stages / teammates that have since been deleted, so a view widens
    // visibly instead of silently emptying.
    const viewFilters = query.viewId
      ? await this.views.resolveFilters(
          session.workspaceId,
          (await this.views.get(actorFromSession(session), query.viewId)).filters,
        )
      : undefined;

    return this.conversations.list(session.workspaceId, session.userId, {
      viewer: session,
      take: query.take,
      cursor: query.cursor ?? null,
      search: query.search,
      filter: query.filter,
      stageId: query.stageId,
      viewFilters,
      accountId: query.accountId,
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
  async counts(
    @CurrentSession() session: ApiSession,
    // `?accountId=` narrows every bucket to one channel account — the inbox
    // sidebar's account filter. Without it the preset badges kept counting the
    // whole workspace while the list showed one number's threads.
    @Query("accountId") accountId?: string,
  ) {
    return this.conversations.counts(
      session.workspaceId,
      session.userId,
      session,
      accountId || null,
    );
  }

  /**
   * Team-wide unread-message total for the AppRail Inbox badge. Declared
   * BEFORE the `:id` routes (same reason as `/counts`) so a bare GET can't
   * swallow `unread-count` as an id. Cheap single aggregate; the rail polls it
   * once on mount then debounce-refetches on count-changing socket events.
   */
  @Get("unread-count")
  async unreadCount(@CurrentSession() session: ApiSession) {
    return this.conversations.unreadTotal(session.workspaceId, session);
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
    return this.conversations.startConversation(session.workspaceId, session.userId, body);
  }

  @Post("bulk")
  @RequireCapability("conversations:delete")
  async bulkDelete(
    @CurrentSession() session: ApiSession,
    @Body(zBody(BulkDeleteConversationsSchema)) body: BulkDeleteConversationsInput,
  ) {
    // Pass the session as the viewer so the agent-visibility boundary applies
    // to bulk-delete too — the class-level guard can't see this route's
    // array-shaped body, so the scoping has to happen in the service.
    const out = await this.conversations.bulkDelete(
      session.workspaceId,
      session.userId,
      body,
      session,
    );
    return { ok: true, count: out.count };
  }

  @Get(":id/messages")
  async listMessages(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query(zQuery(ListMessagesQuerySchema)) query: ListMessagesQuery,
    // Read raw (not via ListMessagesQuerySchema — that schema lives in a
    // sibling file). Optional tail-row id paired with `?after=` to enable the
    // strict-tuple delta (excludes the boundary rows the client already holds,
    // so `hasMore` is an honest truncation flag). Absent → server falls back to
    // the legacy `gte` delta, so old clients keep working mid-deploy.
    @Query("afterId") afterId?: string,
  ) {
    return this.conversations.listMessages(session.workspaceId, id, {
      before: query.before ?? null,
      after: query.after ?? null,
      afterId: afterId ?? null,
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
    return this.conversations.searchMessages(session.workspaceId, id, {
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
    const events = await this.conversations.listEvents(session.workspaceId, id);
    return { events };
  }

  @Get(":id/messages/context")
  async messageContext(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query(zQuery(MessageContextQuerySchema)) query: MessageContextQuery,
  ) {
    return this.conversations.messageContext(session.workspaceId, id, {
      messageId: query.messageId,
      before: query.before,
      after: query.after,
    });
  }

  /**
   * Media gallery for the contact panel's "Files" tab. Keyset-paginated;
   * the optional `kind` chip narrows to a category. Items share the same
   * `Message` shape returned by `:id/messages`, so the lightbox + jump-to-
   * message machinery downstream takes them without remapping.
   */
  @Get(":id/attachments")
  async attachments(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query(zQuery(ListAttachmentsQuerySchema)) query: ListAttachmentsQuery,
  ) {
    return this.conversations.listAttachments(session.workspaceId, id, {
      cursor: query.cursor,
      take: query.take,
      kind: query.kind,
    });
  }

  @Delete(":id")
  @RequireCapability("conversations:delete")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.conversations.remove(session.workspaceId, session.userId, id);
    return { ok: true };
  }

  @Post(":id/assign")
  @HttpCode(200)
  async assign(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(AssignConversationSchema)) body: AssignConversationInput,
  ) {
    // Claiming a conversation is always allowed; handing one to a TEAMMATE is
    // gated by `conversations:assignOthers` (admin/manager by default). The
    // capability is resolved from the session — no extra DB read — and the
    // body-dependent decision is made in the service.
    const canAssignOthers = resolvePermissions(session.role, session.rolePermissions)[
      "conversations:assignOthers"
    ];
    await this.conversations.assign(session.workspaceId, session.userId, id, body, {
      canAssignOthers,
    });
    return { ok: true };
  }

  @Post(":id/status")
  @HttpCode(200)
  async setStatus(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(SetConversationStatusSchema)) body: SetConversationStatusInput,
  ) {
    await this.conversations.setStatus(session.workspaceId, session.userId, id, body);
    return { ok: true };
  }

  @Post(":id/ai")
  @HttpCode(200)
  async setAiEnabled(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(SetConversationAiEnabledSchema)) body: SetConversationAiEnabledInput,
  ) {
    await this.conversations.setAiEnabled(session.workspaceId, session.userId, id, body);
    return { ok: true };
  }

  @Post(":id/read")
  @HttpCode(200)
  async markRead(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.conversations.markRead(session.workspaceId, session.userId, id);
    return { ok: true };
  }

  @Post(":id/typing")
  @HttpCode(200)
  async typing(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(TypingSchema)) body: TypingInput,
  ) {
    return this.conversations.sendTyping(session.workspaceId, id, body.active ?? true);
  }
}
