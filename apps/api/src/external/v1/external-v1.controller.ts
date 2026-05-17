import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { ExternalV1Service } from "./external-v1.service";
import {
  ExternalAssignSchema,
  ExternalNoteSchema,
  ExternalSendMessageSchema,
  ExternalStatusSchema,
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  type ExternalAssignInput,
  type ExternalNoteInput,
  type ExternalSendMessageInput,
  type ExternalStatusInput,
  type ListConversationsQueryInput,
  type ListMessagesQueryInput,
} from "./external-v1.schemas";

/**
 * External /v1 API for n8n / Zapier / customer integrations.
 *
 *   GET  /api/external/v1/contacts/:id
 *   GET  /api/external/v1/conversations
 *   GET  /api/external/v1/conversations/:id
 *   POST /api/external/v1/conversations/:id/assign
 *   POST /api/external/v1/conversations/:id/status
 *   POST /api/external/v1/conversations/:id/notes
 *   GET  /api/external/v1/conversations/:id/messages
 *   POST /api/external/v1/conversations/:id/messages
 *
 * Bearer auth via TeamApiKey; ApiKeyGuard validates and exposes ApiKeyContext
 * with teamId + apiKeyId. All writes publish the SAME domain events the
 * internal routes do — downstream subscribers can't tell which entry point
 * fired.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard)
export class ExternalV1Controller {
  constructor(private readonly api: ExternalV1Service) {}

  // ---- Contacts -------------------------------------------------------

  @Get("contacts/:id")
  async getContact(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const contact = await this.api.getContact(auth.teamId, id);
    return { contact };
  }

  // ---- Conversations --------------------------------------------------

  @Get("conversations")
  async listConversations(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListConversationsQuerySchema)) query: ListConversationsQueryInput,
  ) {
    return this.api.listConversations(auth.teamId, query);
  }

  @Get("conversations/:id")
  async getConversation(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.api.getConversation(auth.teamId, id);
  }

  @Post("conversations/:id/assign")
  async assign(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalAssignSchema)) body: ExternalAssignInput,
  ) {
    await this.api.assign(auth.teamId, id, body);
    return { ok: true };
  }

  @Post("conversations/:id/status")
  async setStatus(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalStatusSchema)) body: ExternalStatusInput,
  ) {
    await this.api.setStatus(auth.teamId, id, body);
    return { ok: true };
  }

  // ---- Messages -------------------------------------------------------

  @Get("conversations/:id/messages")
  async listMessages(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Query(zQuery(ListMessagesQuerySchema)) query: ListMessagesQueryInput,
  ) {
    return this.api.listMessages(auth.teamId, id, query);
  }

  @Post("conversations/:id/messages")
  async sendMessage(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalSendMessageSchema)) body: ExternalSendMessageInput,
  ) {
    const out = await this.api.sendMessage(auth.teamId, auth.apiKeyId, id, body);
    return { ok: true, message: out.message };
  }

  // ---- Notes ----------------------------------------------------------

  @Post("conversations/:id/notes")
  async createNote(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalNoteSchema)) body: ExternalNoteInput,
  ) {
    const out = await this.api.createNote(auth.teamId, id, body);
    return { ok: true, note: out.note };
  }
}
