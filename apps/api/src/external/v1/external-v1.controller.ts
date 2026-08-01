import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  } from "@nestjs/common";

import { acquisitionSources, contactAcquisition } from "@/lib/analytics/acquisition-sources";
import { campaignRollup, listCampaigns } from "@/lib/analytics/campaign-rollup";
import { getWorkspaceReport, ReportRangeError } from "@/lib/analytics/reports";
import {
  getTeamAgentDetail,
  getTeamLiveSnapshot,
  getTeamReport,
} from "@/lib/analytics/team-report";
import { getWabaAnalytics } from "@/lib/analytics/waba-analytics";
import {
  AcquisitionQuerySchema,
  type AcquisitionQuery,
  ReportOverviewQuerySchema,
  type ReportOverviewQuery,
  WabaAnalyticsQuerySchema,
  type WabaAnalyticsQueryInput,
} from "@/reports/reports.schemas";


import { ApiKeyGuard } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { hasScope } from "@ccp/shared/api-keys/scopes";
import { RateLimit } from "../../common/rate-limit.interceptor";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { setContactBlocked } from "@/lib/messaging/block-contact";
import { mapBlockContactError } from "../../common/block-contact-http";
import { markContactSpam } from "@/lib/messaging/block-contact";
import {
  replyToCommentPublicly,
  ReplyToCommentError,
} from "@/lib/messaging/reply-to-comment";
import {
  SendMessengerTemplateSchema,
  type SendMessengerTemplateInput,
} from "@/messages/messages.schemas";

import { parseChainDepth } from "@/lib/workflows/events";
import { guardChainDepth, idemKey, idemKeyRequired } from "./v1-request-guards";
import { ExternalV1Service } from "./external-v1.service";
import { getMessagingHealthSummary } from "@/lib/providers/meta-health";
import {
  getInsightsStatus,
  readTemplateAnalytics,
  templateAnalyticsAccountContext,
} from "@/lib/analytics/template-analytics";
import { getBroadcastTimeseries } from "@/lib/broadcast-timeseries";
import {
  ExternalTemplateAnalyticsQuerySchema,
  ExternalTemplateListQuerySchema,
  type ExternalTemplateAnalyticsQueryInput,
  type ExternalTemplateListQueryInput,
  } from "./external-v1.schemas";
import {
  ExternalAssignSchema,
  ExternalBulkTagSchema,
  ExternalContactAddTagsSchema,
  ExternalContactAssignSchema,
  ExternalContactRemoveTagsSchema,
  ExternalContactStageSchema,
  ExternalContactStatusSchema,
  ExternalCreateContactFieldSchema,
  ExternalCreateContactSchema,
  ExternalCreateTagSchema,
  ExternalCallButtonSchema,
  ExternalListCallsQuerySchema,
  ExternalNoteSchema,
  ExternalSendInteractiveSchema,
  ReplyToCommentSchema,
  ExternalSendMessageSchema,
  ExternalSetAiSchema,
  ExternalStartImportSchema,
  ExternalStatusSchema,
  ExternalTopLevelSendMessageSchema,
  ExternalUpdateContactSchema,
  ExternalUpdateTagSchema,
  ExternalUpsertContactSchema,
  ListContactsQuerySchema,
  ListBroadcastRecipientsQuerySchema,
  ListBroadcastsQuerySchema,
  ListMessagesQuerySchema,
  type ExternalAssignInput,
  type ExternalBulkTagInput,
  type ExternalContactAddTagsInput,
  type ExternalContactAssignInput,
  type ExternalContactRemoveTagsInput,
  type ExternalContactStageInput,
  type ExternalContactStatusInput,
  type ExternalCreateContactFieldInput,
  type ExternalCreateContactInput,
  type ExternalCreateTagInput,
  type ExternalCallButtonInput,
  type ExternalListCallsQueryInput,
  type ExternalNoteInput,
  type ExternalSendInteractiveInput,
  type ReplyToCommentInput,
  type ExternalSendMessageInput,
  type ExternalSetAiInput,
  type ExternalStartImportInput,
  type ExternalStatusInput,
  type ExternalTopLevelSendMessageInput,
  type ExternalUpdateTagInput,
  type ExternalUpsertContactInput,
  type ListContactsQueryInput,
  type ListBroadcastRecipientsQueryInput,
  type ListBroadcastsQueryInput,
  type ListMessagesQueryInput,
} from "./external-v1.schemas";
// Availability/work-hours payloads are validated by the SAME schemas the
// internal routes use — a second copy here would be the drift the parity rule
// exists to prevent.
import {
  SetUserAvailabilitySchema,
  SetUserWorkHoursSchema,
  type SetUserAvailabilityInput,
  type SetUserWorkHoursInput,
} from "@/users/users.schemas";

/**
 * External /v1 API for n8n / Zapier / customer integrations.
 *
 * Contacts:
 *   GET    /v1/contacts                       — list/find (phone= for exact, search= for fuzzy)
 *   POST   /v1/contacts                       — create
 *   POST   /v1/contacts/upsert                — find-or-create by phone
 *   GET    /v1/contacts/:id                   — fetch one
 *   PATCH  /v1/contacts/:id                   — partial update (incl. stageId, customFields, …)
 *   POST   /v1/contacts/:id/stage             — set lifecycle stage (fires lifecycle workflow + stage pill + webhook)
 *   DELETE /v1/contacts/:id                   — soft delete (removes from directory; conversation history preserved)
 *   GET    /v1/contacts/:id/channels          — list channels (siloed-per-channel → one row)
 *   GET    /v1/contacts/:id/acquisition       — the ad / post / link that first brought them in
 *   POST   /v1/contacts/:id/block             — block at the provider (WhatsApp Block Users API)
 *   POST   /v1/contacts/:id/unblock           — lift the provider block
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
 *   GET    /v1/stages                         — list (assign one via POST /v1/contacts/:id/stage)
 *   GET    /v1/channels                       — list (single Meta row for now)
 *
 * Users:
 *   GET    /v1/users                          — list team members (incl. availability + schedule)
 *   GET    /v1/users/:idOrEmail               — find one
 *   PATCH  /v1/users/:id/availability         — set status, or {followSchedule:true}
 *   PUT    /v1/users/:id/work-hours           — inherit | custom | off
 *
 * Conversations / messages / notes (subset shipped earlier):
 *   GET    /v1/conversations
 *   GET    /v1/conversations/:id
 *   POST   /v1/conversations/:id/assign
 *   POST   /v1/conversations/:id/status
 *   GET    /v1/conversations/:id/messages
 *   POST   /v1/conversations/:id/messages
 *   POST   /v1/conversations/:id/interactive  — buttons / list / phone-email consent chips
 *   POST   /v1/conversations/:id/notes
 *   DELETE /v1/conversations/:id/notes/:noteId — remove a note (fires note.deleted)
 *   GET    /v1/messages/:id                   — find a single message
 *
 * Bearer auth via WorkspaceApiKey; ApiKeyGuard validates and exposes ApiKeyContext
 * with workspaceId + apiKeyId. All writes publish the SAME domain events the
 * internal routes do — downstream subscribers can't tell which entry point
 * fired.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
// Default per-key ceiling for the whole external surface. ApiKeyGuard's
// own bucket at 60/min/key is the upstream brake; this decorator-driven
// guard adds a second axis (per-route-class) so a bulk path can tighten
// further with its own @RateLimit. Set to 600/min as a generous ceiling
// for read-heavy traffic — mutation routes override to 60/min below.
@RateLimit({ perMinute: 600 })
export class ExternalV1Controller {
  constructor(
    private readonly api: ExternalV1Service,
  ) {}

  // ---- Contacts: list + find -----------------------------------------

  @Get("contacts")
  @RequireScope("read:contacts")
  async listContacts(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListContactsQuerySchema)) query: ListContactsQueryInput,
  ) {
    return this.api.listContacts(auth.workspaceId, query);
  }

  @Get("contacts/:id")
  @RequireScope("read:contacts")
  async getContact(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const contact = await this.api.getContact(auth.workspaceId, id);
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
  // Bulk paths accept up to 500 contact ids and fan out per-contact event
  // chains (workflow + audit + outbound webhooks). 20/min/key bounds the
  // worst case to ~10k contact-events/min from one partner. Idempotency-Key
  // also collapses retries within the key TTL — a partner retrying after a
  // 5xx replays the fingerprint-matched response with zero side effects.
  // X-CCP-Depth is the cross-system loop guard: a partner whose own webhook
  // receiver bounces back here gets 429'd at depth 8 instead of looping.
  @RateLimit({ perMinute: 20 })
  async bulkAddTags(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalBulkTagSchema)) body: ExternalBulkTagInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    return this.api.bulkContactTags(
      auth.workspaceId,
      auth.apiKeyId,
      "tag-add",
      body,
      idemKey(idempotencyKey),
      parseChainDepth(xCcpDepth),
    );
  }

  @Post("contacts/tags/remove")
  @RequireScope("write:contacts")
  @RateLimit({ perMinute: 20 })
  async bulkRemoveTags(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalBulkTagSchema)) body: ExternalBulkTagInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    return this.api.bulkContactTags(
      auth.workspaceId,
      auth.apiKeyId,
      "tag-remove",
      body,
      idemKey(idempotencyKey),
      parseChainDepth(xCcpDepth),
    );
  }

  // ---- Contacts: bulk import / export ---------------------------------
  //
  // Declared before the dynamic `:id` routes for the same longest-prefix
  // reason as the bulk tag paths above.
  //
  // Full parity with the in-app UI is a locked rule (CLAUDE.md §12): every
  // capability the UI has, the API has. These are the same jobs the contacts
  // page queues, backed by the same runners.

  /**
   * Queue an import from a file already staged via `POST
   * /v1/contacts/import/upload`. `Idempotency-Key` is REQUIRED: an import
   * creates and mutates contacts in bulk, so a retried request that queued a
   * second job would double-apply a 100k-row file.
   */
  @Post("contacts/import")
  @RequireScope("write:contacts")
  @RateLimit({ perMinute: 5 })
  async startContactImport(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalStartImportSchema)) body: ExternalStartImportInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    // REQUIRED, not optional: this route's own docblock, the service comment
    // and both doc surfaces all said so while the code accepted a missing
    // header. A gateway timeout + client retry then queued a SECOND job over
    // the same staged file — `assertNoRunningJob` only blocks a CONCURRENT
    // second job, not a retry issued after the first finished, so in
    // create_and_update mode every row re-applied and (with fireAutomations)
    // every per-row workflow and outbound webhook fired twice.
    return this.api.startContactImport(
      auth.workspaceId,
      auth.apiKeyId,
      body,
      idemKeyRequired(idempotencyKey),
    );
  }

  @Post("contacts")
  @RequireScope("write:contacts")
  async createContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalCreateContactSchema)) body: ExternalCreateContactInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const contact = await this.api.createContact(auth.workspaceId, auth.apiKeyId, body);
    return { contact };
  }

  @Post("contacts/upsert")
  @RequireScope("write:contacts")
  async upsertContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalUpsertContactSchema)) body: ExternalUpsertContactInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.api.upsertContact(
      auth.workspaceId,
      auth.apiKeyId,
      body,
      idemKey(idempotencyKey),
      hasScope(auth.scopes, "read:contacts"),
    );
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
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    if (rawBody && Object.prototype.hasOwnProperty.call(rawBody, "phoneNumber")) {
      throw new BadRequestException({
        error: "phone_immutable",
        detail:
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
      auth.workspaceId,
      auth.apiKeyId,
      id,
      parsed.data,
      idemKey(idempotencyKey),
      hasScope(auth.scopes, "read:contacts"),
    );
    return { contact };
  }

  @Delete("contacts/:id")
  @RequireScope("delete:contacts")
  async deleteContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.api.deleteContact(auth.workspaceId, auth.apiKeyId, id);
    return { ok: true };
  }

  /**
   * Block / unblock this contact at the provider (WhatsApp Block Users API) —
   * `/v1` mirror of the internal inbox action. The provider is called first
   * and `blockedAt` only flips on success. Typed 400s surface Meta's
   * constraints: `reengagement_required` (no inbound in the last 24h),
   * `blocklist_full` (64,000-entry cap), `blocking_not_supported` (non-
   * WhatsApp channel). Rate-limited like other per-contact writes.
   */
  @Post("contacts/:id/block")
  @RequireScope("write:contacts")
  @HttpCode(200)
  @RateLimit({ perMinute: 20 })
  async blockContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.setContactBlockedV1(auth, id, true);
  }

  @Post("contacts/:id/unblock")
  @RequireScope("write:contacts")
  @HttpCode(200)
  @RateLimit({ perMinute: 20 })
  async unblockContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.setContactBlockedV1(auth, id, false);
  }

  /**
   * Reply PUBLICLY to a comment that reached the inbox — a sub-thread comment
   * everyone reading the post sees. The complement to replying in the thread,
   * which sends Instagram's one-per-comment PRIVATE reply instead.
   */
  @Post("messages/:id/comment-reply")
  @RequireScope("write:messages")
  @HttpCode(200)
  async replyToCommentV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ReplyToCommentSchema)) body: ReplyToCommentInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    try {
      const res = await replyToCommentPublicly({
        workspaceId: auth.workspaceId,
        messageId: id,
        body: body.body,
        userId: null,
        apiKeyId: auth.apiKeyId,
      });
      return { ok: true, comment_id: res.commentId };
    } catch (err) {
      if (err instanceof ReplyToCommentError) {
        throw new HttpException(
          { error: err.code, ...(err.detail ? { detail: err.detail } : {}) },
          err.code === "message_not_found" ? 404 : 422,
        );
      }
      throw err;
    }
  }

  /**
   * File the contact's conversation as SPAM at the provider, without blocking
   * them. Instagram only today (`move_to_spam`).
   */
  @Post("contacts/:id/spam")
  @RequireScope("write:contacts")
  @HttpCode(200)
  @RateLimit({ perMinute: 20 })
  async markContactSpamV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    try {
      await markContactSpam({
        workspaceId: auth.workspaceId,
        contactId: id,
        userId: null,
        apiKeyId: auth.apiKeyId,
      });
      return { ok: true };
    } catch (err) {
      throw mapBlockContactError(err);
    }
  }

  private async setContactBlockedV1(auth: ApiKeyContext, id: string, blocked: boolean) {
    try {
      const contact = await setContactBlocked({
        workspaceId: auth.workspaceId,
        contactId: id,
        blocked,
        userId: null,
        apiKeyId: auth.apiKeyId,
      });
      return { contact };
    } catch (err) {
      throw mapBlockContactError(err);
    }
  }

  // ---- Contacts: per-row channels + tag ops --------------------------

  @Get("contacts/:id/channels")
  @RequireScope("read:contacts")
  async getContactChannels(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.api.getContactChannels(auth.workspaceId, id);
  }

  /**
   * WHERE THIS CUSTOMER CAME FROM — their earliest attributed inbound, so an
   * external system can join a contact to the ad that won them without walking
   * the whole message history looking for a `referral` block.
   *
   * `{ acquisition: null }` for an organic contact — never a 404, which would
   * make "arrived directly" indistinguishable from "no such contact".
   */
  @Get("contacts/:id/acquisition")
  @RequireScope("read:contacts")
  async getContactAcquisition(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return { acquisition: await contactAcquisition(auth.workspaceId, id) };
  }

  @Post("contacts/:id/tags")
  @RequireScope("write:contacts")
  async addContactTags(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalContactAddTagsSchema)) body: ExternalContactAddTagsInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const contact = await this.api.addContactTags(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKey(idempotencyKey),
      hasScope(auth.scopes, "read:contacts"),
    );
    return { contact };
  }

  @Delete("contacts/:id/tags/:tagId")
  @RequireScope("write:contacts")
  async removeContactTag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Param("tagId") tagId: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const contact = await this.api.removeContactTag(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      tagId,
      idemKey(idempotencyKey),
      hasScope(auth.scopes, "read:contacts"),
    );
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
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const contact = await this.api.removeContactTags(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body.tagIds,
      body.silent === true,
      idemKey(idempotencyKey),
      hasScope(auth.scopes, "read:contacts"),
    );
    return { contact };
  }

  // ---- Contact fields catalog ---------------------------------------

  @Get("contact-fields")
  @RequireScope("read:catalog")
  async listContactFields(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listContactFields(auth.workspaceId);
  }

  @Get("contact-fields/:idOrKey")
  @RequireScope("read:catalog")
  async findContactField(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("idOrKey") idOrKey: string,
  ) {
    const field = await this.api.findContactField(auth.workspaceId, idOrKey);
    return { field };
  }

  @Post("contact-fields")
  @RequireScope("write:catalog")
  async createContactField(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalCreateContactFieldSchema)) body: ExternalCreateContactFieldInput,
  ) {
    const field = await this.api.createContactField(auth.workspaceId, body);
    return { field };
  }

  // ---- Tags catalog -------------------------------------------------

  @Get("tags")
  @RequireScope("read:catalog")
  async listTags(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listTags(auth.workspaceId);
  }

  @Post("tags")
  @RequireScope("write:catalog")
  async createTag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalCreateTagSchema)) body: ExternalCreateTagInput,
  ) {
    const tag = await this.api.createTag(auth.workspaceId, body);
    return { tag };
  }

  @Patch("tags/:id")
  @RequireScope("write:catalog")
  async updateTag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalUpdateTagSchema)) body: ExternalUpdateTagInput,
  ) {
    const tag = await this.api.updateTag(auth.workspaceId, id, body);
    return { tag };
  }

  @Delete("tags/:id")
  @RequireScope("write:catalog")
  async deleteTag(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    await this.api.deleteTag(auth.workspaceId, id);
    return { ok: true };
  }

  // ---- Stages (read-only) -------------------------------------------

  @Get("stages")
  @RequireScope("read:catalog")
  async listStages(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listStages(auth.workspaceId);
  }

  // ---- Channels (synthetic single-row) ------------------------------

  @Get("channels")
  @RequireScope("read:catalog")
  async listChannels(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listChannels(auth.workspaceId);
  }

  // ---- Users --------------------------------------------------------

  @Get("users")
  @RequireScope("read:catalog")
  async listUsers(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listUsers(auth.workspaceId);
  }

  /**
   * Set a teammate's availability, or hand them back to their working hours
   * with `{ "followSchedule": true }`. Parity with the in-app admin control —
   * same service, same rules, same realtime frame to every open client.
   *
   * No Idempotency-Key requirement: this is a last-write-wins state set with no
   * billing side effect, so a retried call converges rather than duplicating.
   */
  @Patch("users/:id/availability")
  @RequireScope("admin:settings")
  async setUserAvailability(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(SetUserAvailabilitySchema)) body: SetUserAvailabilityInput,
  ) {
    return this.api.setUserAvailability(auth.workspaceId, id, body);
  }

  /** Set a teammate's working-hours mode/schedule (inherit | custom | off). */
  @Put("users/:id/work-hours")
  @RequireScope("admin:settings")
  async setUserWorkHours(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(SetUserWorkHoursSchema)) body: SetUserWorkHoursInput,
  ) {
    return this.api.setUserWorkHours(auth.workspaceId, id, body);
  }

  @Get("users/:idOrEmail")
  @RequireScope("read:catalog")
  async findUser(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("idOrEmail") idOrEmail: string,
  ) {
    return this.api.findUser(auth.workspaceId, idOrEmail);
  }

  // ---- Assignment routing -------------------------------------------
  //
  // Full parity with Settings → Assignment (CLAUDE.md §12): every routing
  // capability the UI has, the API has. Read is `read:catalog` (routing config
  // is org catalog data, same tier as tags/fields); writes are `write:catalog`.
  // Delegates to the SAME AssignmentService the internal controller uses, so
  // validation, the version CAS and cache invalidation can't drift.

  /**
   * The policy catalog — `[{ id, name, isDefault, strategy }]`.
   *
   * Both doc surfaces tell partners to resolve a ticket's `assignedTeamId`
   * through this route, but it only ever existed as a session endpoint, so a
   * partner got a 404 and had no documented way to discover valid team ids for
   * `PATCH /v1/tickets/:id`. Same query the in-app catalog controller runs.
   */
  @Get("assignment-policies")
  @RequireScope("read:catalog")
  async listAssignmentPolicies(@CurrentApiKey() auth: ApiKeyContext) {
    return this.api.listAssignmentPolicies(auth.workspaceId);
  }

  @Post("conversations/:id/messenger-template")
  @RequireScope("write:messages")
  @RateLimit({ perMinute: 60 })
  async sendMessengerTemplateV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(SendMessengerTemplateSchema)) body: SendMessengerTemplateInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    // A billed send is exactly the hop a cross-system loop is made of
    // (our outbound webhook → partner → /v1 send → message.sent → webhook…),
    // so it guards depth like the text and template sends do.
    guardChainDepth(xCcpDepth);
    // A send is non-idempotent and bills the business, so `/v1` sends REQUIRE the
    // header (CLAUDE.md §8) — the same gate every other /v1 send applies.
    const out = await this.api.sendMessengerTemplate(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKeyRequired(idempotencyKey),
    );
    return { ok: true, message_id: out.messageId };
  }

  @Get("broadcasts")
  @RequireScope("read:broadcasts")
  async listBroadcasts(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListBroadcastsQuerySchema)) query: ListBroadcastsQueryInput,
  ) {
    return this.api.listBroadcasts(auth.workspaceId, query);
  }

  @Get("broadcasts/:id")
  @RequireScope("read:broadcasts")
  async getBroadcast(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const broadcast = await this.api.getBroadcast(auth.workspaceId, id);
    return { broadcast };
  }

  /** Delivery funnel, rates, failure buckets, cost and diagnostics. */
  @Get("broadcasts/:id/report")
  @RequireScope("read:broadcasts")
  async getBroadcastReport(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const report = await this.api.getBroadcastReport(auth.workspaceId, id);
    return { report };
  }

  /**
   * Recipient-level results. `updatedSince` enables incremental sync — delivery
   * and read receipts keep arriving for hours, so without it a client would
   * have to re-pull every recipient on each poll.
   */
  @Get("broadcasts/:id/recipients")
  @RequireScope("read:broadcasts")
  async listBroadcastRecipients(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Query(zQuery(ListBroadcastRecipientsQuerySchema)) query: ListBroadcastRecipientsQueryInput,
  ) {
    // Same `read:contacts` PII gate every conversation/message read applies.
    // Without it a key scoped for campaign BI alone could page every campaign's
    // recipients and walk out with the whole contact book's phone numbers —
    // exactly the side door `redactExternalContactPii` exists to close.
    return this.api.listBroadcastRecipients(
      auth.workspaceId,
      id,
      query,
      hasScope(auth.scopes, "read:contacts"),
    );
  }

  @Get("conversations/:id")
  @RequireScope("read:conversations")
  async getConversation(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.api.getConversation(
      auth.workspaceId,
      id,
      hasScope(auth.scopes, "read:contacts"),
    );
  }

  @Post("conversations/:id/assign")
  @RequireScope("write:conversations")
  async assign(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalAssignSchema)) body: ExternalAssignInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.api.assign(auth.workspaceId, auth.apiKeyId, id, body, idemKey(idempotencyKey));
    return { ok: true, conversationId: id };
  }

  @Post("conversations/:id/status")
  @RequireScope("write:conversations")
  async setStatus(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalStatusSchema)) body: ExternalStatusInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.api.setStatus(auth.workspaceId, auth.apiKeyId, id, body, idemKey(idempotencyKey));
    return { ok: true, conversationId: id };
  }

  // AI Autopilot toggle — the AI escalation branch calls this with
  // { aiEnabled: false } to hand a conversation to a human (and optionally
  // { aiEnabled: true } to hand it back). `silent: true` skips the webhook echo.
  @Post("conversations/:id/ai")
  @RequireScope("write:conversations")
  async setAi(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalSetAiSchema)) body: ExternalSetAiInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.api.setAiEnabled(auth.workspaceId, auth.apiKeyId, id, body, idemKey(idempotencyKey));
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
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.api.assignByContact(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKey(idempotencyKey),
    );
  }

  @Post("contacts/:id/status")
  @RequireScope("write:conversations")
  async setStatusByContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalContactStatusSchema)) body: ExternalContactStatusInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.api.setStatusByContact(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKey(idempotencyKey),
    );
  }

  /**
   * Move a contact to a lifecycle stage — the discoverable sibling of the
   * assign/status shortcuts. Delegates to the contact-update path, so it
   * validates the stage (404 if unknown) and fires `contact.lifecycle_changed`
   * (workflow trigger + stage pill + outbound webhook) exactly like the UI's
   * stage picker / PATCH /contacts/:id with `{ stageId }`.
   */
  @Post("contacts/:id/stage")
  @RequireScope("write:contacts")
  async setStageByContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalContactStageSchema)) body: ExternalContactStageInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const contact = await this.api.updateContact(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      { stageId: body.stageId },
      idemKey(idempotencyKey),
      hasScope(auth.scopes, "read:contacts"),
    );
    return { contact };
  }

  // ---- Messages -----------------------------------------------------

  /**
   * Top-level send. Mirrors respond.io's "Send Message" node which accepts
   * either a contact id or a phone — saves the customer from a
   * contact-lookup → conversation-lookup → send chain.
   *
   * Accepts the same `Idempotency-Key` header as the conversation-scoped
   * send. Template sends work; only URL media is unwired (the schema accepts
   * it, but the service returns 400 until it's wired).
   */
  @Post("messages")
  @RequireScope("write:messages")
  @RateLimit({ perMinute: 60 })
  async sendTopLevelMessage(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalTopLevelSendMessageSchema)) body: ExternalTopLevelSendMessageInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    // Cross-system loop guard FIRST — before idempotency/body checks. A
    // partner looping our outbound webhook back into /v1 may not send an
    // Idempotency-Key; if we evaluated `idemKeyRequired` first we'd 400 on the
    // missing key and never cap the chain. The contact-mutation routes already
    // guard depth first; the send routes must too.
    guardChainDepth(xCcpDepth);
    return this.api.sendTopLevelMessage(
      auth.workspaceId,
      auth.apiKeyId,
      body,
      idemKeyRequired(idempotencyKey),
      parseChainDepth(xCcpDepth),
    );
  }

  @Get("messages/:id")
  @RequireScope("read:messages")
  async findMessage(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.api.findMessage(
      auth.workspaceId,
      id,
      hasScope(auth.scopes, "read:contacts"),
    );
  }

  @Get("conversations/:id/messages")
  @RequireScope("read:messages")
  async listMessages(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Query(zQuery(ListMessagesQuerySchema)) query: ListMessagesQueryInput,
  ) {
    return this.api.listMessages(
      auth.workspaceId,
      id,
      query,
      hasScope(auth.scopes, "read:contacts"),
    );
  }

  @Post("conversations/:id/messages")
  @RequireScope("write:messages")
  @RateLimit({ perMinute: 60 })
  async sendMessage(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalSendMessageSchema)) body: ExternalSendMessageInput,
    // Standard Stripe-style idempotency header. When present, the same
    // value within 24h returns the same response without re-sending to
    // WhatsApp — the partner's retry-after-5xx flow becomes safe.
    @Headers("idempotency-key") idempotencyKey?: string,
    // Cross-system loop guard. The /v1 endpoints accept the same X-CCP-Depth
    // header the incoming_webhook trigger uses (audit 2026-05-29): a partner
    // that calls /v1/send on every outbound webhook we deliver must forward
    // the header so we can cap the chain at MAX_CHAIN_DEPTH. Bare requests
    // from a partner that never receives our webhooks parse as depth=0.
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    // Loop guard before idempotency/body checks — see sendTopLevelMessage.
    guardChainDepth(xCcpDepth);
    const out = await this.api.sendMessage(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKeyRequired(idempotencyKey),
      parseChainDepth(xCcpDepth),
      // Reopen a closed thread after the send lands — UI↔/v1 parity (§12): the
      // inbox reply reopens, and so does the top-level POST /v1/messages route.
      // Without it a conversation-scoped reply to a closed thread stayed closed
      // and never surfaced under the open/pending inbox filters.
      true,
    );
    // No-interrupt skip (onlyIfAiEnabled + a human took over): 200 with a
    // skipped marker and no message, so the n8n flow treats it as a clean
    // no-op instead of a retryable error.
    if ("skipped" in out && out.skipped) {
      return { ok: true, skipped: out.skipped, message: null };
    }
    return { ok: true, message: out.message };
  }

  /**
   * Interactive send — buttons / list options, plus Meta's one-tap "share your
   * phone / email" consent chips. The external twin of the composer's
   * `POST /api/messages/interactive`; §12 locks `/v1` to UI parity.
   *
   * Parity gap (tracked, documented as a roadmap exception in both
   * the in-app /docs/api page and the /docs/api page alongside the URL-media
   * note): the composer send types shipped 2026-07-13 — location, contact-card,
   * reaction (+dismiss), and forward — plus direct media upload have no `/v1`
   * twin yet. They're not silently missing: the doc surfaces list them as
   * not-yet-in-/v1 so the parity contract stays honest until they're wired.
   *
   * Social channels only for `contactShare` (capability `contactShareChips`) —
   * WhatsApp already knows the phone and has no such chip, so it 422s with
   * `contact_share_not_supported` rather than silently dropping the chips.
   */
  @Post("conversations/:id/interactive")
  @RequireScope("write:messages")
  @RateLimit({ perMinute: 60 })
  async sendInteractive(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalSendInteractiveSchema)) body: ExternalSendInteractiveInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    // Loop guard before idempotency/body checks — see sendTopLevelMessage.
    guardChainDepth(xCcpDepth);
    return this.api.sendInteractive(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKeyRequired(idempotencyKey),
    );
  }

  // ---- Notes --------------------------------------------------------

  @Post("conversations/:id/notes")
  @RequireScope("write:notes")
  async createNote(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalNoteSchema)) body: ExternalNoteInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    const out = await this.api.createNote(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKey(idempotencyKey),
      parseChainDepth(xCcpDepth),
    );
    return { ok: true, note: out.note };
  }

  @Delete("conversations/:id/notes/:noteId")
  @RequireScope("write:notes")
  async deleteNote(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Param("noteId") noteId: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.api.deleteNote(auth.workspaceId, id, noteId);
  }
  // ---- Message flags ------------------------------------------------
  //
  // Per-message triage markers ("Complaint", "Refund request") with an
  // open/resolved lifecycle. Full parity with the in-app inbox surface — the
  // same domain functions run behind both, with an apiKey actor here.
  //
  // Typical integration shape: subscribe to the `message.flag_changed`
  // outbound webhook to learn the moment something is flagged, then use these
  // endpoints to read the backlog and mark items handled from your own system.

  @Get("whatsapp/health")
  @RequireScope("read:catalog")
  async whatsappHealth(
    @CurrentApiKey() auth: ApiKeyContext,
    // `?accountId=` scopes the figures to ONE number (quality/tier are
    // per-number; the 24h budget is portfolio-shared) — parity with the UI's
    // per-account health panels and the composer's per-account gate.
    @Query("accountId") accountId?: string,
  ) {
    return getMessagingHealthSummary(auth.workspaceId, accountId || null);
  }

  /**
   * The template catalog. Read-only — creating a template is a Meta review
   * submission, not a CRUD write. `id` here is what the send and analytics
   * routes take.
   */
  @Get("templates")
  @RequireScope("read:catalog")
  async listTemplates(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ExternalTemplateListQuerySchema))
    query: ExternalTemplateListQueryInput,
  ) {
    return this.api.listTemplates(auth.workspaceId, query);
  }

  @Get("templates/:id/analytics")
  @RequireScope("read:broadcasts")
  async templateAnalytics(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Query(zQuery(ExternalTemplateAnalyticsQuerySchema))
    query: ExternalTemplateAnalyticsQueryInput,
  ) {
    const template = await this.api.getTemplateExternalId(auth.workspaceId, id);
    if (!template) throw new NotFoundException({ error: "template_not_found" });
    const end = query.end ? new Date(query.end) : new Date();
    const start = query.start
      ? new Date(query.start)
      : new Date(end.getTime() - 30 * 86_400_000);
    const result = await readTemplateAnalytics(
      auth.workspaceId,
      template.externalId,
      start,
      end,
    );
    // Parity with the in-app drawer: an integration reading zeros needs the
    // same two reasons a human does — Meta backfills nothing before the
    // enablement date, and serves EU/Japan accounts nothing at all. Without
    // them a partner's dashboard can only report the zero as a measurement.
    return {
      ...result,
      ...(await templateAnalyticsAccountContext(auth.workspaceId, template.wabaAccountId)),
    };
  }

  /** `?accountId=` reads ONE number's WABA; omitted reads the default number's. */
  @Get("whatsapp/insights/status")
  @RequireScope("read:catalog")
  async insightsStatus(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return getInsightsStatus(auth.workspaceId, accountId || null);
  }

  @Get("broadcasts/:id/timeseries")
  @RequireScope("read:broadcasts")
  async broadcastTimeseries(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    const series = await getBroadcastTimeseries(auth.workspaceId, id);
    if (!series) throw new NotFoundException({ error: "broadcast_not_found" });
    return series;
  }

  /**
   * Workspace performance report — same aggregates and SAME response shape as
   * the internal /api/reports/overview (WorkspaceReport in @ccp/shared/dtos).
   * One source of truth on purpose: a separate v1 mapper is how the calls
   * artifact fields silently went missing from this API (2026-07-28).
   */
  @Get("reports/overview")
  @RequireScope("read:reports")
  async reportOverview(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ReportOverviewQuerySchema)) query: ReportOverviewQuery,
  ) {
    try {
      return await getWorkspaceReport(auth.workspaceId, {
        from: new Date(query.from),
        to: new Date(query.to),
        tz: query.tz,
        // Shares the internal schema, so account scoping is parity by
        // construction rather than a second implementation to keep in sync.
        accountId: query.accountId,
      });
    } catch (err) {
      if (err instanceof ReportRangeError) {
        throw new BadRequestException({ error: "invalid_range", detail: err.message });
      }
      throw err;
    }
  }

  /**
   * Team performance report — same aggregates and SAME response shape as the
   * internal /api/reports/team (TeamReport in @ccp/shared/dtos). One source of
   * truth on purpose, like reports/overview above.
   */
  @Get("reports/team")
  @RequireScope("read:reports")
  async reportTeam(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ReportOverviewQuerySchema)) query: ReportOverviewQuery,
  ) {
    try {
      return await getTeamReport(auth.workspaceId, {
        from: new Date(query.from),
        to: new Date(query.to),
        tz: query.tz,
        accountId: query.accountId,
      });
    } catch (err) {
      if (err instanceof ReportRangeError) {
        throw new BadRequestException({ error: "invalid_range", detail: err.message });
      }
      throw err;
    }
  }

  /**
   * One agent's drill-down row + their own daily series — parity with the
   * internal /api/reports/team/agents/:userId (TeamReportAgentDetail).
   */
  @Get("reports/team/agents/:userId")
  @RequireScope("read:reports")
  async reportTeamAgent(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("userId") userId: string,
    @Query(zQuery(ReportOverviewQuerySchema)) query: ReportOverviewQuery,
  ) {
    if (!userId || userId.length > 64) {
      throw new BadRequestException({ error: "invalid_user_id" });
    }
    try {
      const detail = await getTeamAgentDetail(auth.workspaceId, userId, {
        from: new Date(query.from),
        to: new Date(query.to),
        tz: query.tz,
        accountId: query.accountId,
      });
      if (!detail) throw new NotFoundException({ error: "agent_not_found" });
      return detail;
    } catch (err) {
      if (err instanceof ReportRangeError) {
        throw new BadRequestException({ error: "invalid_range", detail: err.message });
      }
      throw err;
    }
  }

  /**
   * Point-in-time team activity snapshot (open assigned chats + active calls
   * per agent) — parity with the internal /api/reports/team/live
   * (TeamLiveSnapshot).
   */
  @Get("reports/team/live")
  @RequireScope("read:reports")
  async reportTeamLive(@CurrentApiKey() auth: ApiKeyContext) {
    return getTeamLiveSnapshot(auth.workspaceId);
  }

  /**
   * Meta's OWN account-level analytics — spend, delivered volume, volume-tier
   * standing, conversations and call cost, per WhatsApp Business Account.
   *
   * Same domain function and same response shape as the internal
   * `/api/reports/whatsapp-analytics`. A different SOURCE from
   * `reports/overview`: that one is computed from our message rows (what we
   * sent), this one is Meta's billing side (what it delivered and charged).
   * Never sum them — and never sum `conversations` with `pricing` volume either,
   * they are conversations vs delivered messages.
   */
  @Get("reports/whatsapp-analytics")
  @RequireScope("read:reports")
  async whatsappAnalytics(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(WabaAnalyticsQuerySchema)) query: WabaAnalyticsQueryInput,
  ) {
    return getWabaAnalytics(auth.workspaceId, {
      from: new Date(query.from),
      to: new Date(query.to),
      granularity: query.granularity,
      wabaAccountId: query.wabaAccountId,
    });
  }

  /**
   * WHERE CUSTOMERS CAME FROM — acquisition sources, aggregated by distinct
   * CONTACT keyed on their first attributed inbound (Meta only sends `referral`
   * on the message that starts a conversation).
   *
   * `organic` is reported SEPARATELY rather than as a row: it is the absence of
   * a source, and folding it in would let it sort above every real campaign.
   */
  @Get("reports/acquisition")
  @RequireScope("read:reports")
  async reportAcquisition(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(AcquisitionQuerySchema)) query: AcquisitionQuery,
  ) {
    return acquisitionSources(auth.workspaceId, {
      ...(query.from ? { since: new Date(query.from) } : {}),
      ...(query.to ? { until: new Date(query.to) } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
    });
  }

  /** Every campaign name in the workspace — the index behind the rollup below. */
  @Get("reports/campaigns")
  @RequireScope("read:reports")
  async reportCampaigns(@CurrentApiKey() auth: ApiKeyContext) {
    return { campaigns: await listCampaigns(auth.workspaceId) };
  }

  /**
   * CAMPAIGN ROLLUP — several broadcasts read as one set of numbers, with the
   * per-send, per-account, per-failure, per-cost and per-source cuts.
   *
   * Same domain function and same shape as the internal route. Summed from
   * recipient rows, never by averaging per-broadcast rates.
   */
  @Get("reports/campaigns/:name")
  @RequireScope("read:reports")
  async reportCampaign(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("name") name: string,
  ) {
    const rollup = await campaignRollup(auth.workspaceId, name);
    if (!rollup) throw new NotFoundException({ error: "campaign_not_found" });
    return rollup;
  }

  @Get("calls")
  @RequireScope("read:calls")
  async listCalls(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ExternalListCallsQuerySchema)) query: ExternalListCallsQueryInput,
  ) {
    return this.api.listCalls(auth.workspaceId, query);
  }

  /**
   * The customer's CURRENT calling permission, read live from the provider —
   * including whether we may call them right now and when any quota resets.
   * This is the same read the inbox pre-flight uses, so an integration can
   * decide "is it worth queueing a call task?" without guessing.
   */
  @Get("conversations/:id/call-permission")
  @RequireScope("read:calls")
  async getCallPermission(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.api.getCallPermission(auth.workspaceId, id);
  }

  /**
   * Ask the customer for permission to call them. Sends a real (billable)
   * message, so it takes an Idempotency-Key like every other send.
   */
  @Post("conversations/:id/call-permission")
  @RequireScope("write:calls")
  async requestCallPermission(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    // Billable message ⇒ same chain-depth ceiling as every other /v1 send.
    guardChainDepth(xCcpDepth);
    return this.api.requestCallPermission(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      idemKeyRequired(idempotencyKey),
    );
  }

  /**
   * Send a call button — a tappable CTA that starts a WhatsApp call TO the
   * business. The inverse of a permission request: it needs no permission at
   * all, and a customer who taps it grants us callback permission as a side
   * effect.
   */
  @Post("conversations/:id/call-button")
  @RequireScope("write:calls")
  async sendCallButton(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalCallButtonSchema)) body: ExternalCallButtonInput,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.api.sendCallButton(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKeyRequired(idempotencyKey),
    );
  }

  // ===========================================================================
  // ===========================================================================
}

