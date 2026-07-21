import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { RateLimit } from "../common/rate-limit.interceptor";
import { ConversationsService } from "./conversations.service";

/**
 * SSR data-loader companion for the inbox workspace cache.
 *
 *   GET /api/inbox/conversation/:id
 *     → ConversationWithRefs (same shape as the RSC page hydrates from)
 *
 * Hit on cache miss when the agent clicks a chat they haven't loaded in
 * this session. The response folds straight into the in-memory Map so the
 * thread renders without a route navigation.
 *
 * Lives in its own controller (separate path from /api/conversations/*)
 * because the URL surface is owned by the inbox page contract; pulling
 * data through `ConversationsService` keeps the read logic in one place.
 */
@Controller("api/inbox/conversation")
@UseGuards(SessionGuard)
// Read-tier limit on its own bucket (see ConversationsController) — this is the
// cache-miss + reconnect full-refetch endpoint, hit on every chat-switch to an
// unloaded thread, so it must not share the 300/min mutation default.
@RateLimit({ perMinute: 1200 })
export class InboxConversationController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get(":id")
  async get(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    const page = await this.conversations.getInboxConversation(
      session.teamId,
      id,
      session,
    );
    if (!page) throw new NotFoundException({ error: "Not found" });
    return page;
  }
}
