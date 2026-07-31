import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { guardChainDepth } from "./v1-request-guards";
import {
  ListAttachmentsQuerySchema,
  StartConversationSchema,
  type ListAttachmentsQuery,
  type StartConversationInput,
} from "@/conversations/conversations.schemas";
import { ConversationsService } from "@/conversations/conversations.service";

/**
 * /v1 CONVERSATION OPERATIONS — peeled from the ExternalV1Controller (2026-07-31 split).
 * Same base path + guard stack; check:v1-docs discovers every
 * *.controller.ts here, so a peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1ConversationOpsController {
  constructor(
    private readonly conversations: ConversationsService,
  ) {}

  // CONVERSATION OPERATIONS
  // ===========================================================================
  //
  // Parity build, phase 3. Reads and status/assign writes already existed;
  // these are the operations an integration needs to actually drive a thread.

  /**
   * Open (or reopen) a thread with a contact, by id or by phone number — the
   * precursor to a send. Idempotent by nature: an existing OPEN thread comes
   * back as-is, a CLOSED one is reopened through the audited status path, and
   * a phone with no contact yet find-or-creates one.
   */
  @Post("conversations")
  @RequireScope("write:conversations")
  async startConversationV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(StartConversationSchema)) body: StartConversationInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.conversations.startConversation(auth.workspaceId, null, body);
  }

  /**
   * Mark a thread read. Unread is TEAM-WIDE in this product (not per-agent),
   * so this clears it for everyone — call it when your system, rather than a
   * human, has handled the thread.
   */
  @Post("conversations/:id/read")
  @RequireScope("write:conversations")
  async markConversationReadV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    // The shared CAS publishes `conversation.read` only on a real 1→0
    // transition, so a repeated call is a genuine no-op, not an event storm.
    await this.conversations.markRead(auth.workspaceId, null, id);
    return { ok: true };
  }

  /** The audit timeline for a thread — every status change, assignment, tag
   *  and ticket transition, in order. */
  @Get("conversations/:id/events")
  @RequireScope("read:conversations")
  async listConversationEventsV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    const events = await this.conversations.listEvents(auth.workspaceId, id);
    return { events };
  }

  /** Every media attachment on a thread, newest first. */
  @Get("conversations/:id/attachments")
  @RequireScope("read:messages")
  async listConversationAttachmentsV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Query(zQuery(ListAttachmentsQuerySchema)) query: ListAttachmentsQuery,
  ) {
    return this.conversations.listAttachments(auth.workspaceId, id, {
      cursor: query.cursor,
      take: query.take,
      kind: query.kind,
    });
  }

  // ===========================================================================
}
