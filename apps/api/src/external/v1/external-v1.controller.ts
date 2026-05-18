import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { ExternalV1Service } from "./external-v1.service";
import {
  ExternalAssignSchema,
  ExternalBulkTagSchema,
  ExternalContactAddTagsSchema,
  ExternalContactAssignSchema,
  ExternalContactRemoveTagsSchema,
  ExternalContactStatusSchema,
  ExternalCreateContactFieldSchema,
  ExternalCreateContactSchema,
  ExternalCreateTagSchema,
  ExternalNoteSchema,
  ExternalSendMessageSchema,
  ExternalStatusSchema,
  ExternalTopLevelSendMessageSchema,
  ExternalUpdateContactSchema,
  ExternalUpdateTagSchema,
  ExternalUpsertContactSchema,
  ListContactsQuerySchema,
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  type ExternalAssignInput,
  type ExternalBulkTagInput,
  type ExternalContactAddTagsInput,
  type ExternalContactAssignInput,
  type ExternalContactRemoveTagsInput,
  type ExternalContactStatusInput,
  type ExternalCreateContactFieldInput,
  type ExternalCreateContactInput,
  type ExternalCreateTagInput,
  type ExternalNoteInput,
  type ExternalSendMessageInput,
  type ExternalStatusInput,
  type ExternalTopLevelSendMessageInput,
  type ExternalUpdateTagInput,
  type ExternalUpsertContactInput,
  type ListContactsQueryInput,
  type ListConversationsQueryInput,
  type ListMessagesQueryInput,
} from "./external-v1.schemas";

/**
 * External /v1 API for n8n / Zapier / customer integrations.
 *
 * Contacts:
 *   GET    /v1/contacts                       — list/find (phone= for exact, search= for fuzzy)
 *   POST   /v1/contacts                       — create
 *   POST   /v1/contacts/upsert                — find-or-create by phone
 *   GET    /v1/contacts/:id                   — fetch one
 *   PATCH  /v1/contacts/:id                   — partial update
 *   DELETE /v1/contacts/:id                   — hard delete
 *   GET    /v1/contacts/:id/channels          — list channels (siloed-per-channel → one row)
 *   POST   /v1/contacts/:id/tags              — add tag(s) to one contact
 *   DELETE /v1/contacts/:id/tags/:tagId       — remove a tag from one contact
 *   POST   /v1/contacts/tags/add              — bulk add tag(s) across many contacts
 *   POST   /v1/contacts/tags/remove           — bulk remove tag(s) across many contacts
 *
 * Catalogs (tags / fields / stages / channels):
 *   GET    /v1/contact-fields                 — list custom field definitions
 *   GET    /v1/contact-fields/:idOrKey        — find one by id or key
 *   POST   /v1/contact-fields                 — create
 *   GET    /v1/tags                           — list
 *   POST   /v1/tags                           — create
 *   PATCH  /v1/tags/:id                       — update
 *   DELETE /v1/tags/:id                       — delete
 *   GET    /v1/stages                         — list
 *   GET    /v1/channels                       — list (single Meta row for now)
 *
 * Users (read-only):
 *   GET    /v1/users                          — list team members
 *   GET    /v1/users/:idOrEmail               — find one
 *
 * Conversations / messages / notes (subset shipped earlier):
 *   GET    /v1/conversations
 *   GET    /v1/conversations/:id
 *   POST   /v1/conversations/:id/assign
 *   POST   /v1/conversations/:id/status
 *   GET    /v1/conversations/:id/messages
 *   POST   /v1/conversations/:id/messages
 *   POST   /v1/conversations/:id/notes
 *   GET    /v1/messages/:id                   — find a single message
 *
 * Bearer auth via TeamApiKey; ApiKeyGuard validates and exposes ApiKeyContext
 * with teamId + apiKeyId. All writes publish the SAME domain events the
 * internal routes do — downstream subscribers can't tell which entry point
 * fired.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class ExternalV1Controller {
  constructor(private readonly api: ExternalV1Service) {}

  // ---- Contacts: list + find -----------------------------------------

  @Get("contacts")
  @RequireScope("read:contacts")
  async listContacts(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListContactsQuerySchema)) query: ListContactsQueryInput,
  ) {
    return this.api.listContacts(auth.teamId, query);
  }

  @Get("contacts/:id")
  @RequireScope("read:contacts")
  async getContact(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const contact = await this.api.getContact(auth.teamId, id);
    return { contact };
  }

  // ---- Contacts: bulk tag operations (path comes BEFORE /:id/...) ----
  //
  // These two MUST be declared before the dynamic `:id/tags*` routes —
  // NestJS does longest-prefix matching, but the literal "tags" segment
  // would otherwise be interpreted as a contact id. Keeping them up here
  // also matches the file's read order: bulk ops live near the list endpoints.

  @Post("contacts/tags/add")
  @RequireScope("write:contacts")
  async bulkAddTags(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalBulkTagSchema)) body: ExternalBulkTagInput,
  ) {
    return this.api.bulkContactTags(auth.teamId, auth.apiKeyId, "tag-add", body);
  }

  @Post("contacts/tags/remove")
  @RequireScope("write:contacts")
  async bulkRemoveTags(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalBulkTagSchema)) body: ExternalBulkTagInput,
  ) {
    return this.api.bulkContactTags(auth.teamId, auth.apiKeyId, "tag-remove", body);
  }

  // ---- Contacts: create / upsert / update / delete ------------------

  @Post("contacts")
  @RequireScope("write:contacts")
  async createContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalCreateContactSchema)) body: ExternalCreateContactInput,
  ) {
    const contact = await this.api.createContact(auth.teamId, auth.apiKeyId, body);
    return { contact };
  }

  @Post("contacts/upsert")
  @RequireScope("write:contacts")
  async upsertContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalUpsertContactSchema)) body: ExternalUpsertContactInput,
  ) {
    return this.api.upsertContact(auth.teamId, auth.apiKeyId, body);
  }

  /**
   * Partial update. Phone-number rejection happens HERE (not in the schema)
   * so the error message can be specific — see CLAUDE.md memory
   * "Contact phone immutable". Mirrors the internal PATCH /api/contacts/:id
   * pattern.
   */
  @Patch("contacts/:id")
  @RequireScope("write:contacts")
  async updateContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body() rawBody: Record<string, unknown>,
  ) {
    if (rawBody && Object.prototype.hasOwnProperty.call(rawBody, "phoneNumber")) {
      throw new BadRequestException({
        error:
          "phoneNumber is not editable — it's the WhatsApp identity for this contact",
      });
    }
    const parsed = ExternalUpdateContactSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        error: "invalid_body",
        issues: parsed.error.issues,
      });
    }
    const contact = await this.api.updateContact(
      auth.teamId,
      auth.apiKeyId,
      id,
      parsed.data,
    );
    return { contact };
  }

  @Delete("contacts/:id")
  @RequireScope("delete:contacts")
  async deleteContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    await this.api.deleteContact(auth.teamId, auth.apiKeyId, id);
    return { ok: true };
  }

  // ---- Contacts: per-row channels + tag ops --------------------------

  @Get("contacts/:id/channels")
  @RequireScope("read:contacts")
  async getContactChannels(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.api.getContactChannels(auth.teamId, id);
  }

  @Post("contacts/:id/tags")
  @RequireScope("write:contacts")
  async addContactTags(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalContactAddTagsSchema)) body: ExternalContactAddTagsInput,
  ) {
    const contact = await this.api.addContactTags(auth.teamId, auth.apiKeyId, id, body);
    return { contact };
  }

  @Delete("contacts/:id/tags/:tagId")
  @RequireScope("write:contacts")
  async removeContactTag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Param("tagId") tagId: string,
  ) {
    const contact = await this.api.removeContactTag(auth.teamId, auth.apiKeyId, id, tagId);
    return { contact };
  }

  /**
   * Bulk-remove tags from one contact. Mirror of `POST /contacts/:id/tags`
   * (which already accepts an array on add) so an n8n flow that removes N
   * tags in one step doesn't have to loop. Fires ONE `contact.tag_changed`
   * with all removed ids.
   */
  @Post("contacts/:id/tags/remove")
  @RequireScope("write:contacts")
  async removeContactTags(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalContactRemoveTagsSchema)) body: ExternalContactRemoveTagsInput,
  ) {
    const contact = await this.api.removeContactTags(
      auth.teamId,
      auth.apiKeyId,
      id,
      body.tagIds,
    );
    return { contact };
  }

  // ---- Contact fields catalog ---------------------------------------

  @Get("contact-fields")
  @RequireScope("read:catalog")
  async listContactFields(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listContactFields(auth.teamId);
  }

  @Get("contact-fields/:idOrKey")
  @RequireScope("read:catalog")
  async findContactField(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("idOrKey") idOrKey: string,
  ) {
    const field = await this.api.findContactField(auth.teamId, idOrKey);
    return { field };
  }

  @Post("contact-fields")
  @RequireScope("write:catalog")
  async createContactField(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalCreateContactFieldSchema)) body: ExternalCreateContactFieldInput,
  ) {
    const field = await this.api.createContactField(auth.teamId, body);
    return { field };
  }

  // ---- Tags catalog -------------------------------------------------

  @Get("tags")
  @RequireScope("read:catalog")
  async listTags(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listTags(auth.teamId);
  }

  @Post("tags")
  @RequireScope("write:catalog")
  async createTag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalCreateTagSchema)) body: ExternalCreateTagInput,
  ) {
    const tag = await this.api.createTag(auth.teamId, body);
    return { tag };
  }

  @Patch("tags/:id")
  @RequireScope("write:catalog")
  async updateTag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalUpdateTagSchema)) body: ExternalUpdateTagInput,
  ) {
    const tag = await this.api.updateTag(auth.teamId, id, body);
    return { tag };
  }

  @Delete("tags/:id")
  @RequireScope("write:catalog")
  async deleteTag(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    await this.api.deleteTag(auth.teamId, id);
    return { ok: true };
  }

  // ---- Stages (read-only) -------------------------------------------

  @Get("stages")
  @RequireScope("read:catalog")
  async listStages(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listStages(auth.teamId);
  }

  // ---- Channels (synthetic single-row) ------------------------------

  @Get("channels")
  @RequireScope("read:catalog")
  async listChannels(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listChannels(auth.teamId);
  }

  // ---- Users (read-only) --------------------------------------------

  @Get("users")
  @RequireScope("read:catalog")
  async listUsers(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listUsers(auth.teamId);
  }

  @Get("users/:idOrEmail")
  @RequireScope("read:catalog")
  async findUser(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("idOrEmail") idOrEmail: string,
  ) {
    return this.api.findUser(auth.teamId, idOrEmail);
  }

  // ---- Conversations ------------------------------------------------

  @Get("conversations")
  @RequireScope("read:conversations")
  async listConversations(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListConversationsQuerySchema)) query: ListConversationsQueryInput,
  ) {
    return this.api.listConversations(auth.teamId, query);
  }

  @Get("conversations/:id")
  @RequireScope("read:conversations")
  async getConversation(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.api.getConversation(auth.teamId, id);
  }

  @Post("conversations/:id/assign")
  @RequireScope("write:conversations")
  async assign(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalAssignSchema)) body: ExternalAssignInput,
  ) {
    await this.api.assign(auth.teamId, auth.apiKeyId, id, body);
    return { ok: true };
  }

  @Post("conversations/:id/status")
  @RequireScope("write:conversations")
  async setStatus(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalStatusSchema)) body: ExternalStatusInput,
  ) {
    await this.api.setStatus(auth.teamId, auth.apiKeyId, id, body);
    return { ok: true };
  }

  // ---- Contact-keyed conversation actions ---------------------------
  //
  // Mirror respond.io's contact-keyed "Assign/Unassign" + "Open/Close" n8n
  // nodes. Each resolves the contact's most-recent conversation server-side
  // and delegates to the existing conversation-keyed methods.

  @Post("contacts/:id/assign")
  @RequireScope("write:conversations")
  async assignByContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalContactAssignSchema)) body: ExternalContactAssignInput,
  ) {
    return this.api.assignByContact(auth.teamId, auth.apiKeyId, id, body);
  }

  @Post("contacts/:id/status")
  @RequireScope("write:conversations")
  async setStatusByContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalContactStatusSchema)) body: ExternalContactStatusInput,
  ) {
    return this.api.setStatusByContact(auth.teamId, auth.apiKeyId, id, body);
  }

  // ---- Messages -----------------------------------------------------

  /**
   * Top-level send. Mirrors respond.io's "Send Message" node which accepts
   * either a contact id or a phone — saves the customer from a
   * contact-lookup → conversation-lookup → send chain.
   *
   * Accepts the same `Idempotency-Key` header as the conversation-scoped
   * send. Media + template sends are stubbed for now (schema accepts them,
   * service returns 400 until they're wired).
   */
  @Post("messages")
  @RequireScope("write:messages")
  async sendTopLevelMessage(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalTopLevelSendMessageSchema)) body: ExternalTopLevelSendMessageInput,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const trimmed = idempotencyKey?.trim();
    return this.api.sendTopLevelMessage(
      auth.teamId,
      auth.apiKeyId,
      body,
      trimmed && trimmed.length > 0 && trimmed.length <= 255 ? trimmed : undefined,
    );
  }

  @Get("messages/:id")
  @RequireScope("read:messages")
  async findMessage(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.api.findMessage(auth.teamId, id);
  }

  @Get("conversations/:id/messages")
  @RequireScope("read:messages")
  async listMessages(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Query(zQuery(ListMessagesQuerySchema)) query: ListMessagesQueryInput,
  ) {
    return this.api.listMessages(auth.teamId, id, query);
  }

  @Post("conversations/:id/messages")
  @RequireScope("write:messages")
  async sendMessage(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalSendMessageSchema)) body: ExternalSendMessageInput,
    // Standard Stripe-style idempotency header. When present, the same
    // value within 24h returns the same response without re-sending to
    // WhatsApp — the partner's retry-after-5xx flow becomes safe.
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const trimmed = idempotencyKey?.trim();
    const out = await this.api.sendMessage(
      auth.teamId,
      auth.apiKeyId,
      id,
      body,
      trimmed && trimmed.length > 0 && trimmed.length <= 255 ? trimmed : undefined,
    );
    return { ok: true, message: out.message };
  }

  // ---- Notes --------------------------------------------------------

  @Post("conversations/:id/notes")
  @RequireScope("write:notes")
  async createNote(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalNoteSchema)) body: ExternalNoteInput,
  ) {
    const out = await this.api.createNote(auth.teamId, id, body);
    return { ok: true, note: out.note };
  }
}
