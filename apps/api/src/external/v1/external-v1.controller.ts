import {
  BadRequestException,
  ConflictException,
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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { tmpdir } from "node:os";
import type { Response } from "express";

import { CallsService } from "@/calls/calls.service";
import { acquisitionSources, contactAcquisition } from "@/lib/analytics/acquisition-sources";
import { campaignRollup, listCampaigns } from "@/lib/analytics/campaign-rollup";
import { getWorkspaceReport, ReportRangeError } from "@/lib/analytics/reports";
import { getWabaAnalytics } from "@/lib/analytics/waba-analytics";
import { streamBlob } from "@/media/stream-blob";
import {
  AcquisitionQuerySchema,
  type AcquisitionQuery,
  ReportOverviewQuerySchema,
  type ReportOverviewQuery,
  WabaAnalyticsQuerySchema,
  type WabaAnalyticsQueryInput,
} from "@/reports/reports.schemas";

import { TRANSFER_MAX_UPLOAD_BYTES } from "@ccp/shared/contacts/transfer-columns";

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
import { ContactTransferService } from "@/contacts/transfer.service";
import {
  CreateExportSchema,
  ListTransfersQuerySchema,
  type CreateExportInput,
  type ListTransfersQueryInput,
} from "@/contacts/transfer.schemas";
import { AssignmentService } from "@/assignment/assignment.service";
import { ChannelAccountsService } from "@/workspace-settings/channel-accounts/channel-accounts.service";
import { InstagramService } from "@/workspace-settings/instagram/instagram.service";
import { MessengerService } from "@/workspace-settings/messenger/messenger.service";
import {
  SendMessengerTemplateSchema,
  type SendMessengerTemplateInput,
} from "@/messages/messages.schemas";
import {
  CreatePersonaSchema,
  StickerCatalogQuerySchema,
  ThreadControlSchema,
  UpdateMessengerEntryPointsSchema,
  UpdateMessengerWelcomeSchema,
  type CreatePersonaInput,
  type StickerCatalogQuery,
  type ThreadControlInput,
  type UpdateMessengerEntryPointsInput,
  type UpdateMessengerWelcomeInput,
} from "@/workspace-settings/messenger/messenger.schemas";
import {
  UpdateEntryPointsSchema,
  UpdateInboxSourcesSchema,
  type UpdateEntryPointsInput,
  type UpdateInboxSourcesInput,
} from "@/workspace-settings/instagram/instagram.schemas";
import { WhatsappService } from "@/workspace-settings/whatsapp/whatsapp.service";
import { BroadcastsService } from "@/broadcasts/broadcasts.service";
import {
  CreateBroadcastSchema,
  PreviewMissingFieldsSchema,
  RetryBroadcastSchema,
  type CreateBroadcastInput,
  type PreviewMissingFieldsInput,
  type RetryBroadcastInput,
} from "@/broadcasts/broadcasts.schemas";
import { OutboundWebhooksService } from "@/workspace-settings/outbound-webhooks/outbound-webhooks.service";
import {
  CreateOutboundWebhookSchema,
  ListDeliveriesQuerySchema,
  UpdateOutboundWebhookSchema,
  type CreateOutboundWebhookInput,
  type ListDeliveriesQueryInput,
  type UpdateOutboundWebhookInput,
} from "@/workspace-settings/outbound-webhooks/outbound-webhooks.schemas";
import { AudienceGroupsService } from "@/workspace-settings/audience-groups/audience-groups.service";
import {
  CreateAudienceGroupSchema,
  UpdateAudienceGroupSchema,
  type CreateAudienceGroupInput,
  type UpdateAudienceGroupInput,
} from "@/workspace-settings/audience-groups/audience-groups.schemas";
import { SnippetsService } from "@/workspace-settings/snippets/snippets.service";
import { ConversationsService } from "@/conversations/conversations.service";
import {
  ListAttachmentsQuerySchema,
  StartConversationSchema,
  type ListAttachmentsQuery,
  type StartConversationInput,
} from "@/conversations/conversations.schemas";
import { CustomersService } from "@/customers/customers.service";
import {
  LinkContactSchema,
  RenameCustomerSchema,
  UnlinkContactSchema,
  type LinkContactInput,
  type RenameCustomerInput,
  type UnlinkContactInput,
} from "@/customers/customers.schemas";
import {
  CreateSnippetSchema,
  UpdateSnippetSchema,
  type CreateSnippetInput,
  type UpdateSnippetInput,
} from "@/workspace-settings/snippets/snippets.schemas";
import {
  CreateQrCodeSchema,
  RegisterWhatsappNumberSchema,
  SetWhatsappUsernameSchema,
  UpdateBusinessProfileSchema,
  UpdateQrCodeSchema,
  type CreateQrCodeInput,
  type RegisterWhatsappNumberInput,
  type SetWhatsappUsernameInput,
  type UpdateBusinessProfileInput,
  type UpdateQrCodeInput,
} from "@/workspace-settings/whatsapp/whatsapp.schemas";
import { TicketsService } from "@/tickets/tickets.service";
import {
  PostThreadMessageSchema,
  CreateTicketViewSchema,
  UpdateTicketViewSchema,
  CreateTicketFieldSchema,
  AddTicketNoteSchema,
  CreateTicketSchema,
  EscalateTicketSchema,
  ListTicketsQuerySchema,
  TicketSettingsSchema,
  UpdateTicketFieldSchema,
  UpdateTicketSchema,
  UpsertSlaPolicySchema,
  type PostThreadMessageInput,
  type CreateTicketViewInput,
  type UpdateTicketViewInput,
  type CreateTicketFieldInput,
  type AddTicketNoteInput,
  type CreateTicketInput,
  type EscalateTicketInput,
  type ListTicketsQuery,
  type TicketSettingsInput,
  type UpdateTicketFieldInput,
  type UpdateTicketInput,
  type UpsertSlaPolicyInput,
} from "@/tickets/tickets.schemas";
import { parseAccountChannel } from "@/workspace-settings/channel-accounts/channel-accounts.schemas";
import {
  CreatePolicySchema,
  CreateRuleSchema,
  PreviewAssignmentSchema,
  ReorderRulesSchema,
  UpdateAssignmentSettingsSchema,
  UpdatePolicySchema,
  UpdateRuleSchema,
  type CreatePolicyInput,
  type CreateRuleInput,
  type PreviewAssignmentInput,
  type ReorderRulesInput,
  type UpdateAssignmentSettingsInput,
  type UpdatePolicyInput,
  type UpdateRuleInput,
} from "@/assignment/assignment.schemas";

import { parseChainDepth } from "@/lib/workflows/events";
import { guardChainDepth, idemKey, idemKeyRequired } from "./v1-request-guards";
import { ExternalV1Service } from "./external-v1.service";
import { ExternalV1FlagsService } from "./external-v1-flags.service";
import { InboxViewsService, type InboxViewActor } from "@/inbox-views/inbox-views.service";
import { inboxViewWhereClauses } from "@/lib/inbox-views/where";
import { getMessagingHealthSummary } from "@/lib/providers/meta-health";
import {
  getInsightsStatus,
  readTemplateAnalytics,
  templateAnalyticsAccountContext,
} from "@/lib/analytics/template-analytics";
import { getBroadcastTimeseries } from "@/lib/broadcast-timeseries";
import {
  ExternalSetLinkTrackingSchema,
  ExternalTemplateAnalyticsQuerySchema,
  type ExternalSetLinkTrackingInput,
  ExternalTemplateListQuerySchema,
  ExternalUpdateTemplateLabelsSchema,
  type ExternalTemplateAnalyticsQueryInput,
  type ExternalTemplateListQueryInput,
  type ExternalUpdateTemplateLabelsInput,
} from "./external-v1.schemas";
import {
  CreateInboxViewSchema,
  UpdateInboxViewSchema,
  type CreateInboxViewInput,
  type UpdateInboxViewInput,
} from "@/inbox-views/inbox-views.schemas";
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
  ExternalCreateFlagDefinitionSchema,
  ExternalUpdateFlagDefinitionSchema,
  type ExternalCreateFlagDefinitionInput,
  type ExternalUpdateFlagDefinitionInput,
  ExternalListCallsQuerySchema,
  ExternalListFlagsQuerySchema,
  ExternalRaiseFlagSchema,
  ExternalUpdateFlagSchema,
  type ExternalListFlagsQueryInput,
  type ExternalRaiseFlagInput,
  type ExternalUpdateFlagInput,
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
  ListConversationsQuerySchema,
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
  type ListConversationsQueryInput,
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
    private readonly transfers: ContactTransferService,
    private readonly assignment: AssignmentService,
    private readonly flags: ExternalV1FlagsService,
    private readonly inboxViews: InboxViewsService,
    private readonly channelAccounts: ChannelAccountsService,
    private readonly instagram: InstagramService,
    private readonly messenger: MessengerService,
    private readonly tickets: TicketsService,
    private readonly whatsapp: WhatsappService,
    private readonly broadcasts: BroadcastsService,
    private readonly outboundWebhooks: OutboundWebhooksService,
    private readonly audienceGroups: AudienceGroupsService,
    private readonly snippets: SnippetsService,
    private readonly customers: CustomersService,
    private readonly conversations: ConversationsService,
    private readonly calls: CallsService,
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
   * Queue an export. Returns a job id immediately; poll
   * `GET /v1/contacts/transfers/:id` and then fetch
   * `GET /v1/contacts/transfers/:id/download` once `status` is `completed`.
   *
   * Rate-limited hard: each call can produce a full dump of the contact book,
   * which is both expensive to generate and the single most sensitive payload
   * this API can emit.
   */
  @Post("contacts/export")
  @RequireScope("read:contacts")
  @RateLimit({ perMinute: 5 })
  async startContactExport(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateExportSchema)) body: CreateExportInput,
  ) {
    // No acting user on an API-key call; the job records the key's team and is
    // fetched back through the same team-scoped reads.
    return this.transfers.startExport({ workspaceId: auth.workspaceId, userId: null, input: body });
  }

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

  /** Upload a CSV/XLSX and get back the staged key + detected mapping. */
  @Post("contacts/import/upload")
  @RequireScope("write:contacts")
  @RateLimit({ perMinute: 10 })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: TRANSFER_MAX_UPLOAD_BYTES },
    }),
  )
  async uploadContactImport(
    @CurrentApiKey() auth: ApiKeyContext,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.transfers.preview(auth.workspaceId, file);
  }

  @Get("contacts/transfers")
  @RequireScope("read:contacts")
  async listContactTransfers(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListTransfersQuerySchema)) query: ListTransfersQueryInput,
  ) {
    return this.transfers.list(auth.workspaceId, query);
  }

  @Get("contacts/transfers/:id")
  @RequireScope("read:contacts")
  async getContactTransfer(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    return { job: await this.transfers.get(auth.workspaceId, id) };
  }

  /**
   * 302 to a short-lived presigned URL. Partners that can't follow redirects
   * can read the `Location` header directly.
   */
  @Get("contacts/transfers/:id/download")
  @RequireScope("read:contacts")
  async downloadContactTransfer(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.transfers.downloadUrl(auth.workspaceId, id, "result"));
  }

  @Get("contacts/transfers/:id/errors")
  @RequireScope("read:contacts")
  async errorsContactTransfer(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.transfers.downloadUrl(auth.workspaceId, id, "errors"));
  }

  @Post("contacts/transfers/:id/cancel")
  @RequireScope("write:contacts")
  async cancelContactTransfer(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    return this.transfers.cancel(auth.workspaceId, id);
  }

  // ---- Contacts: create / upsert / update / delete ------------------

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

  @Get("assignment")
  @RequireScope("read:catalog")
  async getAssignment(@CurrentApiKey() auth: ApiKeyContext) {
    return this.assignment.getOverview(auth.workspaceId);
  }

  @Post("assignment/policies")
  @RequireScope("admin:settings")
  async createAssignmentPolicy(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreatePolicySchema)) body: CreatePolicyInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.assignment.createPolicy(auth.workspaceId, body);
  }

  @Put("assignment/policies/:id")
  @RequireScope("admin:settings")
  async updateAssignmentPolicy(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdatePolicySchema)) body: UpdatePolicyInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.assignment.updatePolicy(auth.workspaceId, id, body);
  }

  @Post("assignment/policies/:id/default")
  @RequireScope("admin:settings")
  async setDefaultAssignmentPolicy(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.assignment.setDefaultPolicy(auth.workspaceId, id);
  }

  @Delete("assignment/policies/:id")
  @RequireScope("admin:settings")
  async archiveAssignmentPolicy(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.assignment.archivePolicy(auth.workspaceId, id);
  }

  @Post("assignment/rules")
  @RequireScope("admin:settings")
  async createAssignmentRule(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateRuleSchema)) body: CreateRuleInput,
  ) {
    return this.assignment.createRule(auth.workspaceId, body);
  }

  // Before `rules/:id` — Nest matches in declaration order.
  @Put("assignment/rules/order")
  @RequireScope("admin:settings")
  async reorderAssignmentRules(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ReorderRulesSchema)) body: ReorderRulesInput,
  ) {
    return this.assignment.reorderRules(auth.workspaceId, body.ruleIds);
  }

  @Patch("assignment/rules/:id")
  @RequireScope("admin:settings")
  async updateAssignmentRule(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateRuleSchema)) body: UpdateRuleInput,
  ) {
    return this.assignment.updateRule(auth.workspaceId, id, body);
  }

  @Delete("assignment/rules/:id")
  @RequireScope("admin:settings")
  async deleteAssignmentRule(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.assignment.deleteRule(auth.workspaceId, id);
  }

  @Patch("assignment/settings")
  @RequireScope("admin:settings")
  async updateAssignmentSettings(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateAssignmentSettingsSchema)) body: UpdateAssignmentSettingsInput,
  ) {
    return this.assignment.updateSettings(auth.workspaceId, body);
  }

  /** Dry run: "who would take a conversation like this?" Read-only — never
   *  advances rotation or weighted counters, so it's safe to poll. */
  @Post("assignment/preview")
  @RequireScope("read:catalog")
  async previewAssignment(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(PreviewAssignmentSchema)) body: PreviewAssignmentInput,
  ) {
    return this.assignment.preview(auth.workspaceId, body);
  }

  // ---- Conversations ------------------------------------------------

  // ── Broadcasts (read-only) ────────────────────────────────────────────────
  // Clients pull campaign results into their own BI. Same DTO the in-app report
  // renders, so the API and the UI can never disagree about a number.

  // ── Tickets ─────────────────────────────────────────────────────────────
  // Full parity with the in-app board: the same domain functions the UI calls,
  // with an API-key actor instead of a session. A partner helpdesk can read the
  // backlog, open work, reassign it and resolve it without polling messages.

  @Get("tickets")
  @RequireScope("read:tickets")
  async listTickets(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListTicketsQuerySchema)) query: ListTicketsQuery,
  ) {
    // No viewer → no conversation-visibility restriction. An API key is
    // workspace-scoped by construction and has no agent identity to narrow to
    // — which also means `assignee=me` is unanswerable: it used to resolve to
    // an empty viewer id and silently match nothing. Reject it instead.
    if (query.assignee === "me") {
      throw new BadRequestException({
        error: "assignee_me_requires_session",
        detail: "An API key has no agent identity — pass an explicit user id or 'none'.",
      });
    }
    return this.tickets.list(auth.workspaceId, "", query);
  }

  @Get("tickets/counts")
  @RequireScope("read:tickets")
  async ticketCounts(@CurrentApiKey() auth: ApiKeyContext) {
    // `mineActive` is meaningless for a key (no agent identity) and comes back
    // as 0 — documented, rather than silently omitted from the shape.
    const counts = await this.tickets.counts(auth.workspaceId, "");
    return { counts };
  }

  /** Saved ticket views. Static segment — before `tickets/:id`. */
  @Get("tickets/views")
  @RequireScope("read:tickets")
  async listTicketViewsV1(@CurrentApiKey() auth: ApiKeyContext) {
    // An API key has no agent identity, so it sees the SHARED views only (a
    // personal view belongs to one person, and "" matches nobody). Role
    // "admin": a scoped key is trusted like an integration, the same call the
    // delete route already makes.
    return this.tickets.listViews(auth.workspaceId, "", "admin");
  }

  @Post("tickets/views")
  @RequireScope("write:tickets")
  async createTicketViewV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateTicketViewSchema)) body: CreateTicketViewInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    // Forced SHARED: a key has no person to own a personal view, and one
    // created with a null author would be visible to nobody.
    return this.tickets.createView(auth.workspaceId, "", "admin", {
      ...body,
      visibility: "shared",
    });
  }

  @Patch("tickets/views/:viewId")
  @RequireScope("write:tickets")
  async updateTicketViewV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("viewId") viewId: string,
    @Body(zBody(UpdateTicketViewSchema)) body: UpdateTicketViewInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.updateView(auth.workspaceId, "", "admin", viewId, body);
  }

  @Delete("tickets/views/:viewId")
  @RequireScope("write:tickets")
  async deleteTicketViewV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("viewId") viewId: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.deleteView(auth.workspaceId, "", "admin", viewId);
  }

  /** Sibling workspaces a ticket can be escalated to (id + name only).
   *  Static segment — declared before `tickets/:id` so it isn't captured. */
  @Get("tickets/escalation-targets")
  @RequireScope("read:tickets")
  async ticketEscalationTargets(@CurrentApiKey() auth: ApiKeyContext) {
    return { workspaces: await this.tickets.listEscalationTargets(auth.workspaceId) };
  }

  @Get("tickets/:id")
  @RequireScope("read:tickets")
  async getTicket(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    return this.tickets.get(auth.workspaceId, id);
  }

  @Post("tickets")
  @RequireScope("write:tickets")
  async createTicketV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateTicketSchema)) body: CreateTicketInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.create(auth.workspaceId, { apiKeyId: auth.apiKeyId }, body);
  }

  @Patch("tickets/:id")
  @RequireScope("write:tickets")
  async updateTicketV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateTicketSchema)) body: UpdateTicketInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.update(auth.workspaceId, { apiKeyId: auth.apiKeyId }, id, body);
  }

  /**
   * Permanently delete a ticket. A scoped key is trusted like an integration,
   * so `write:tickets` authorizes it (no role gate — the in-app route reserves
   * this for admins/managers, but a key is not an agent). The customer's
   * messages survive; the work item and its timeline go.
   */
  @Delete("tickets/:id")
  @RequireScope("write:tickets")
  async deleteTicketV1(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.remove(auth.workspaceId, { apiKeyId: auth.apiKeyId }, id);
  }

  /**
   * Add an internal note to a ticket. Never reaches the customer.
   *
   * Parity with the in-app composer, which is a locked rule — and the one /v1
   * route a handoff integration genuinely needs: a partner system that receives
   * a `ticket.changed` webhook with `action: "team_changed"` answers by writing
   * a note back, not by messaging the customer.
   *
   * Its own route rather than a PATCH field for the same reason as internally:
   * a note changes nothing about the ticket, so it must not bump `version` (and
   * 409 a colleague's open editor) or move the SLA clock.
   */
  @Post("tickets/:id/notes")
  @RequireScope("write:tickets")
  async addTicketNoteV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(AddTicketNoteSchema)) body: AddTicketNoteInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.addNote(auth.workspaceId, { apiKeyId: auth.apiKeyId }, id, body.body);
  }

  // ── Cross-workspace escalation ──────────────────────────────────────────
  // Parity with the in-app escalation flow (locked rule). The API key is
  // scoped to the SOURCE workspace; the twin ticket is created in the sibling
  // workspace exactly as the UI would.

  /** Refer a ticket to a sibling workspace in the organization. */
  @Post("tickets/:id/escalate")
  @RequireScope("write:tickets")
  async escalateTicketV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(EscalateTicketSchema)) body: EscalateTicketInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.escalate(auth.workspaceId, { apiKeyId: auth.apiKeyId }, id, body);
  }

  /**
   * Post to a ticket's THREAD — the conversation every workspace with access to
   * the ticket sees (unlike /notes, which stays in one workspace).
   */
  @Post("tickets/:id/thread")
  @RequireScope("write:tickets")
  async postTicketThreadMessageV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(PostThreadMessageSchema)) body: PostThreadMessageInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    // JSON only: a partner posts text, and a multipart API surface nobody asked
    // for is scope we would have to keep working. The in-app composer covers
    // files. No read route either — read state is per-USER, and an API key has
    // no user to mark read for.
    return this.tickets.postThreadMessage(
      auth.workspaceId,
      { apiKeyId: auth.apiKeyId },
      id,
      body.body,
      [],
      body.clientTempId,
    );
  }

  /** Revoke a workspace's access to a shared ticket. */
  @Delete("tickets/:id/shares/:guestWorkspaceId")
  @RequireScope("write:tickets")
  async revokeTicketShareV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Param("guestWorkspaceId") guestWorkspaceId: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.revokeShare(
      auth.workspaceId,
      { apiKeyId: auth.apiKeyId },
      id,
      guestWorkspaceId,
    );
  }

  /** Remove one attachment from a ticket. (Uploads stay in-app — see the
   *  comment on the /v1 comment route.) */
  @Delete("tickets/:id/attachments/:attachmentId")
  @RequireScope("write:tickets")
  async removeTicketAttachmentV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Param("attachmentId") attachmentId: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.tickets.removeAttachment(
      auth.workspaceId,
      { apiKeyId: auth.apiKeyId },
      id,
      attachmentId,
    );
  }

  /**
   * Start this workspace's own chat with the escalated customer (from the
   * snapshot's phone) and bind the conversation to the ticket.
   */
  @Post("tickets/:id/escalation/message-customer")
  @RequireScope("write:tickets")
  async messageEscalatedCustomerV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body() body: { channelConnectionId?: unknown } | undefined,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const channelConnectionId =
      body && typeof body.channelConnectionId === "string" ? body.channelConnectionId : undefined;
    return this.tickets.messageEscalatedCustomer(
      auth.workspaceId,
      { apiKeyId: auth.apiKeyId },
      id,
      { ...(channelConnectionId ? { channelConnectionId } : {}) },
    );
  }

  // Ticketing configuration. Read is deliberately under `read:tickets` (a BI
  // system needs the SLA promise to report against it); every write changes
  // what FUTURE tickets promise, so it needs `write:tickets`.

  @Get("tickets-settings")
  @RequireScope("read:tickets")
  async ticketSettings(@CurrentApiKey() auth: ApiKeyContext) {
    return this.tickets.getSettings(auth.workspaceId);
  }

  @Patch("tickets-settings")
  @RequireScope("admin:settings")
  async updateTicketSettings(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(TicketSettingsSchema)) body: TicketSettingsInput,
  ) {
    return this.tickets.updateSettings(auth.workspaceId, body);
  }

  @Get("ticket-sla")
  @RequireScope("read:tickets")
  async listTicketSla(@CurrentApiKey() auth: ApiKeyContext) {
    const policies = await this.tickets.listSlaPolicies(auth.workspaceId);
    return { policies };
  }

  @Post("ticket-sla")
  @RequireScope("admin:settings")
  async upsertTicketSla(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpsertSlaPolicySchema)) body: UpsertSlaPolicyInput,
  ) {
    const policy = await this.tickets.upsertSlaPolicy(auth.workspaceId, body);
    return { policy };
  }

  @Get("ticket-fields")
  @RequireScope("read:tickets")
  async listTicketFields(@CurrentApiKey() auth: ApiKeyContext) {
    const fields = await this.tickets.listFields(auth.workspaceId);
    return { fields };
  }

  @Post("ticket-fields")
  @RequireScope("admin:settings")
  async createTicketField(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateTicketFieldSchema)) body: CreateTicketFieldInput,
  ) {
    const field = await this.tickets.createField(auth.workspaceId, body);
    return { field };
  }

  @Patch("ticket-fields/:id")
  @RequireScope("admin:settings")
  async updateTicketField(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateTicketFieldSchema)) body: UpdateTicketFieldInput,
  ) {
    const field = await this.tickets.updateField(auth.workspaceId, id, body);
    return { field };
  }

  @Delete("ticket-fields/:id")
  @RequireScope("admin:settings")
  async deleteTicketField(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    await this.tickets.deleteField(auth.workspaceId, id);
    return { ok: true };
  }

  // ── Channel accounts ────────────────────────────────────────────────────
  // Which accounts a workspace has connected per channel, and which one is the
  // send default. Read-only: connecting/disconnecting moves real credentials
  // and changes which number a customer hears from (see the scope comment).

  @Get("channels/:channel/accounts")
  @RequireScope("read:channels")
  async listChannelAccounts(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("channel") channel: string,
  ) {
    const ch = parseAccountChannel(channel);
    return { accounts: await this.channelAccounts.list(auth.workspaceId, ch) };
  }

  // The same accounts across EVERY channel, display fields only.
  //
  // Needed for parity with what the inbox now shows: a conversation carries
  // `channel_connection_id` (which number/Page/handle the thread is on, and
  // therefore which one a reply goes out from), and without this an integration
  // has an opaque id and no way to resolve it. Also the only way a partner can
  // tell which number a broadcast will use before submitting it.
  //
  // No tokens, no App secret, no WABA or portfolio id — so `read:catalog`,
  // matching `whatsapp/health`, rather than the credential-adjacent
  // `read:channels` the per-channel route above uses.
  @Get("channel-accounts")
  @RequireScope("read:catalog")
  async channelAccountDirectory(@CurrentApiKey() auth: ApiKeyContext) {
    return { accounts: await this.channelAccounts.directory(auth.workspaceId) };
  }

  // ── Instagram conversation entry points ─────────────────────────────────
  // The ice breakers + persistent menu a customer sees before typing. These live
  // on META, not in our database (they can also be edited in Business Suite), so
  // both routes read and write through the same service the settings panel uses.
  //
  // `admin:settings`, not `write:channels`: this is admin-grade workspace
  // CONFIGURATION whose internal twin is `@RequireRole("admin")`, and it changes
  // what every future customer is shown — the same reasoning as assignment rules
  // and SLA policies.

  @Get("channels/instagram/entry-points")
  @RequireScope("admin:settings")
  async getInstagramEntryPoints(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("account_id") accountId?: string,
  ) {
    // `null` = we could not read them. Callers must treat that as unknown, NOT
    // as empty: POSTing an empty set back would clear a live configuration.
    return {
      entry_points: await this.instagram.getEntryPoints(
        auth.workspaceId,
        accountId?.trim() || undefined,
      ),
    };
  }

  @Post("channels/instagram/entry-points")
  @RequireScope("admin:settings")
  async setInstagramEntryPoints(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateEntryPointsSchema)) body: UpdateEntryPointsInput,
  ) {
    return {
      ok: true,
      entry_points: await this.instagram.setEntryPoints(auth.workspaceId, body),
    };
  }

  // ── Messenger profile: entry points, welcome screen, stickers ───────────
  // Same reasoning and the same scope as the Instagram block above. Messenger
  // has one surface Instagram does not: the WELCOME SCREEN (Get Started button,
  // greeting, commands), which Instagram's profile node rejects outright — hence
  // separate routes rather than a `channel` parameter on one.
  //
  // The sticker catalog is `read:catalog`, not `admin:settings`: it is a public,
  // read-only list of Meta's own first-party stickers with no workspace data in
  // it at all, and an integration composing a reply needs it without holding an
  // admin-grade key.

  @Get("channels/messenger/entry-points")
  @RequireScope("admin:settings")
  async getMessengerEntryPoints(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("account_id") accountId?: string,
  ) {
    // `null` = could not read. Treat as unknown, NOT empty — see the Instagram twin.
    return {
      entry_points: await this.messenger.getEntryPoints(
        auth.workspaceId,
        accountId?.trim() || undefined,
      ),
    };
  }

  @Post("channels/messenger/entry-points")
  @RequireScope("admin:settings")
  async setMessengerEntryPoints(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateMessengerEntryPointsSchema)) body: UpdateMessengerEntryPointsInput,
  ) {
    return {
      ok: true,
      entry_points: await this.messenger.setEntryPoints(auth.workspaceId, body),
    };
  }

  @Get("channels/messenger/welcome")
  @RequireScope("admin:settings")
  async getMessengerWelcome(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("account_id") accountId?: string,
  ) {
    return {
      welcome: await this.messenger.getWelcome(
        auth.workspaceId,
        accountId?.trim() || undefined,
      ),
    };
  }

  @Post("channels/messenger/welcome")
  @RequireScope("admin:settings")
  async setMessengerWelcome(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateMessengerWelcomeSchema)) body: UpdateMessengerWelcomeInput,
  ) {
    return { ok: true, welcome: await this.messenger.setWelcome(auth.workspaceId, body) };
  }

  @Get("channels/messenger/stickers")
  @RequireScope("read:catalog")
  async messengerStickers(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(StickerCatalogQuerySchema)) query: StickerCatalogQuery,
  ) {
    return { catalog: await this.messenger.stickers(auth.workspaceId, query) };
  }

  /**
   * Which NON-DM sources reach the inbox for one Instagram account (default:
   * none — direct messages are the core and are never gated).
   *
   * `admin:settings` for the same reason as the entry points: it changes what
   * every agent in the workspace sees, and the Meta-side subscription for these
   * sources is app-wide, so this is the only per-workspace control over them.
   */
  @Post("channels/instagram/inbox-sources")
  @RequireScope("admin:settings")
  async setInstagramInboxSources(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateInboxSourcesSchema)) body: UpdateInboxSourcesInput,
  ) {
    return { ok: true, ...(await this.instagram.setInboxSources(auth.workspaceId, body)) };
  }

  // Handover Protocol. `write:conversations`, NOT `admin:settings`: unlike the
  // profile routes above this changes nothing about workspace configuration — it
  // acts on ONE conversation, and it is the programmatic equivalent of an agent
  // taking a thread over from a bot. Scoping it as an admin setting would force
  // an integration that only ever answers messages to hold an admin-grade key.
  @Post("channels/messenger/thread-control")
  @RequireScope("write:conversations")
  async messengerThreadControl(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ThreadControlSchema)) body: ThreadControlInput,
  ) {
    return { ok: true, ...(await this.messenger.threadControl(auth.workspaceId, body)) };
  }

  @Get("channels/messenger/thread-owner")
  @RequireScope("read:channels")
  async messengerThreadOwner(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("psid") psid: string,
    @Query("account_id") accountId?: string,
  ) {
    return {
      owner_app_id: await this.messenger.threadOwner(
        auth.workspaceId,
        psid,
        accountId?.trim() || undefined,
      ),
    };
  }

  // Personas + utility templates. Both read Meta live with no local mirror.
  //
  // `read:catalog` for the two READS: neither returns workspace data — a persona
  // is a display name and an avatar, a utility template is Meta-approved copy —
  // and the composer needs both without an admin-grade key. Creating or deleting
  // a persona changes what every future customer SEES, so those stay
  // `admin:settings`.
  @Get("channels/messenger/personas")
  @RequireScope("read:catalog")
  async messengerPersonas(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("account_id") accountId?: string,
  ) {
    return {
      personas: await this.messenger.personas(auth.workspaceId, accountId?.trim() || undefined),
    };
  }

  @Post("channels/messenger/personas")
  @RequireScope("admin:settings")
  async createMessengerPersona(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreatePersonaSchema)) body: CreatePersonaInput,
  ) {
    return { ok: true, persona: await this.messenger.createPersona(auth.workspaceId, body) };
  }

  @Delete("channels/messenger/personas/:personaId")
  @RequireScope("admin:settings")
  async deleteMessengerPersona(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("personaId") personaId: string,
    @Query("account_id") accountId?: string,
  ) {
    await this.messenger.deletePersona(
      auth.workspaceId,
      personaId,
      accountId?.trim() || undefined,
    );
    return { ok: true };
  }

  // Sending a Messenger template. `write:messages` — it IS a message send, not a
  // settings change, and an integration that posts order updates should not need
  // an admin-grade key. Rate-limited like the other sends.
  @Post("conversations/:id/messenger-template")
  @RequireScope("write:messages")
  @RateLimit({ perMinute: 60 })
  async sendMessengerTemplateV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(SendMessengerTemplateSchema)) body: SendMessengerTemplateInput,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    // A send is non-idempotent and bills the business, so `/v1` sends REQUIRE the
    // header (CLAUDE.md §8) — the same gate every other /v1 send applies.
    idemKeyRequired(idempotencyKey);
    const out = await this.api.sendMessengerTemplate(auth.workspaceId, auth.apiKeyId, id, body);
    return { ok: true, message_id: out.messageId };
  }

  @Get("channels/messenger/broadcast-reach")
  @RequireScope("read:catalog")
  async messengerBroadcastReach(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("template_name") templateName?: string,
  ) {
    return this.messenger.broadcastReach(auth.workspaceId, templateName?.trim() || undefined);
  }

  @Get("channels/messenger/utility-templates")
  @RequireScope("read:catalog")
  async messengerUtilityTemplates(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("account_id") accountId?: string,
  ) {
    return {
      templates: await this.messenger.utilityTemplates(
        auth.workspaceId,
        accountId?.trim() || undefined,
      ),
    };
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
   * Pull Meta's own template analytics for this campaign (currency cost +
   * unique link clicks — figures the per-recipient funnel cannot derive).
   *
   * Documented in both doc surfaces since the analytics work landed but never
   * implemented on /v1, so an API-only integration got a 404 and its
   * `report.metaAnalytics` block stayed permanently stale — the internal
   * dashboard was the only way to refresh it. `read:broadcasts` because it
   * fetches and caches a report figure; it changes no campaign state.
   */
  @Post("broadcasts/:id/analytics/refresh")
  @RequireScope("read:broadcasts")
  @RateLimit({ perMinute: 10 })
  async refreshBroadcastAnalytics(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.broadcasts.refreshAnalytics(auth.workspaceId, id);
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

  @Get("conversations")
  @RequireScope("read:conversations")
  async listConversations(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListConversationsQuerySchema)) query: ListConversationsQueryInput,
  ) {
    // Resolve the saved view HERE, where the membership check lives — a key
    // only sees shared views, and an id from another workspace 404s before it
    // can become a WHERE clause. `resolveFilters` then drops references to
    // tags / stages / teammates that have since been deleted.
    const viewClauses = query.viewId
      ? inboxViewWhereClauses(
          await this.inboxViews.resolveFilters(
            auth.workspaceId,
            (await this.inboxViews.get(apiKeyViewActor(auth), query.viewId)).filters,
          ),
          // No viewer: an API key is not a person, so a view whose assignee is
          // "me" matches nothing rather than everything.
          undefined,
        )
      : [];

    return this.api.listConversations(
      auth.workspaceId,
      query,
      hasScope(auth.scopes, "read:contacts"),
      viewClauses,
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

  @Get("message-flags")
  @RequireScope("read:flags")
  async listMessageFlags(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ExternalListFlagsQuerySchema)) query: ExternalListFlagsQueryInput,
  ) {
    return this.flags.list(auth.workspaceId, query);
  }

  /** Static segments before the `:flagId` routes below. */
  @Get("message-flags/counts")
  @RequireScope("read:flags")
  async messageFlagCounts(@CurrentApiKey() auth: ApiKeyContext) {
    return this.flags.counts(auth.workspaceId);
  }

  /** The flag CATALOG (which flags exist), archived included. Lives under
   *  `read:catalog` with every other catalog read. */
  @Get("message-flag-definitions")
  @RequireScope("read:catalog")
  async listMessageFlagDefinitions(@CurrentApiKey() auth: ApiKeyContext) {
    return this.flags.listDefinitions(auth.workspaceId);
  }

  @Post("message-flag-definitions")
  @RequireScope("write:catalog")
  async createMessageFlagDefinition(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalCreateFlagDefinitionSchema)) body: ExternalCreateFlagDefinitionInput,
  ) {
    return this.flags.createDefinition(auth.workspaceId, body);
  }

  @Patch("message-flag-definitions/:id")
  @RequireScope("write:catalog")
  async updateMessageFlagDefinition(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalUpdateFlagDefinitionSchema)) body: ExternalUpdateFlagDefinitionInput,
  ) {
    return this.flags.updateDefinition(auth.workspaceId, id, body);
  }

  /** Only permitted while the definition has never been raised — otherwise 409
   *  with `message_flag_definition_in_use`; archive it instead
   *  (`PATCH … { "archived": true }`) so the triage history stays readable. */
  @Delete("message-flag-definitions/:id")
  @RequireScope("write:catalog")
  async deleteMessageFlagDefinition(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.flags.deleteDefinition(auth.workspaceId, id);
  }

  // ---- Saved inbox views ---------------------------------------------
  //
  // A named, reusable filter over the conversation list ("Support ·
  // unassigned · WhatsApp"). Full parity with the inbox rail — the SAME
  // service backs both, so a view can never select different conversations
  // through the API than it shows in the product.
  //
  // API-KEY SPECIFICS, both consequences of a key not being a person:
  //   - only SHARED views are visible or creatable (a personal view needs an
  //     owner; creating one returns `inbox_view_requires_user`);
  //   - a view whose assignee is "me" matches NOTHING here, deliberately —
  //     silently widening it to everyone would be the dangerous direction.
  //
  // To LIST the conversations a view selects, pass its id to
  // `GET /v1/conversations?viewId=…`.

  @Get("inbox-views")
  @RequireScope("read:catalog")
  async listInboxViews(@CurrentApiKey() auth: ApiKeyContext) {
    const views = await this.inboxViews.list(apiKeyViewActor(auth));
    return { views };
  }

  @Get("inbox-views/:id")
  @RequireScope("read:catalog")
  async getInboxView(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const view = await this.inboxViews.get(apiKeyViewActor(auth), id);
    return { view };
  }

  @Post("inbox-views")
  @RequireScope("write:catalog")
  async createInboxView(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateInboxViewSchema)) body: CreateInboxViewInput,
  ) {
    const view = await this.inboxViews.create(apiKeyViewActor(auth), {
      ...body,
      // A key has no personal scope, so default to shared rather than letting
      // the service's personal default throw on every unqualified create.
      visibility: body.visibility ?? "shared",
    });
    return { view };
  }

  @Patch("inbox-views/:id")
  @RequireScope("write:catalog")
  async updateInboxView(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateInboxViewSchema)) body: UpdateInboxViewInput,
  ) {
    const view = await this.inboxViews.update(apiKeyViewActor(auth), id, body);
    return { view };
  }

  @Delete("inbox-views/:id")
  @RequireScope("write:catalog")
  async deleteInboxView(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    await this.inboxViews.remove(apiKeyViewActor(auth), id);
    return { ok: true };
  }

  // ---- WhatsApp messaging health --------------------------------------
  //
  // What Meta currently allows the workspace's WhatsApp number to send: the
  // messaging tier and its 24h unique-recipient cap, how much of that budget is
  // already spent, the quality rating, and the throughput ceiling.
  //
  // Worth exposing because it is the ONLY way an integration can size a
  // campaign before submitting it. Without it a partner discovers the cap by
  // having a 10k send refused — and the refusal is correct, so there is nothing
  // to retry. `remainingDailyBudget` is the number to plan against.
  //
  // Read-only, and secret-free (no tokens, no App secret), so it sits under
  // `read:catalog` rather than requiring a credential-bearing scope.

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
   * Re-poll Meta for a number's tier / quality / throughput now, rather than
   * waiting for the periodic sweep. Parity with the settings Refresh button.
   * `admin:settings` — it spends Graph reads on the workspace's behalf.
   */
  @Post("whatsapp/health/refresh")
  @HttpCode(200)
  @RequireScope("admin:settings")
  async whatsappHealthRefresh(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.refreshHealth(auth.workspaceId, accountId || null);
  }

  /**
   * Register a number for Cloud API use (two-step PIN, passed straight
   * through to Meta and never stored). Parity with the UI's guided register.
   */
  @Post("whatsapp/register")
  @HttpCode(200)
  @RequireScope("admin:settings")
  async whatsappRegister(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(RegisterWhatsappNumberSchema)) body: RegisterWhatsappNumberInput,
  ) {
    return this.whatsapp.registerNumber(auth.workspaceId, body);
  }

  // ---- Template analytics ----------------------------------------------
  //
  // Meta's own aggregate performance per template per day — the only source of
  // real currency COST and of unique URL-button clicks. Read from the stored
  // rollup; `POST /broadcasts/:id/analytics/refresh` is what pulls fresh data
  // from Meta (deliberately manual — see the note on that route).
  //
  // These sit BESIDE the per-recipient funnel in `/broadcasts/:id/report`,
  // never merged into it: the two measure different things and will not agree.

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

  /**
   * Replace a template's organizational LABELS — the one part of a template
   * this API may write. Labels are OURS ("promo", "ramadan-2026"): Meta has no
   * such concept, nothing goes over the Graph wire, and a catalog re-sync
   * leaves them untouched. Parity with the internal templates PATCH;
   * `write:catalog` because labels are catalog taxonomy, like tags.
   */
  @Patch("templates/:id")
  @RequireScope("write:catalog")
  async updateTemplateLabels(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalUpdateTemplateLabelsSchema))
    body: ExternalUpdateTemplateLabelsInput,
  ) {
    await this.whatsapp.updateTemplateBindings(auth.workspaceId, id, {
      labels: body.labels,
    });
    return { ok: true };
  }

  /**
   * Lift a quality pause. Meta lifts a quality pause itself (3h, then 6h, then
   * it DISABLES the template), so this is for one paused by Template Pacing,
   * which never unpauses on its own. Campaigns parked for the template resume.
   */
  /**
   * Lift a Template-Pacing pause. `admin:settings`, not `write:catalog`:
   * unpausing RESUMES every broadcast campaign parked on this template — i.e.
   * it restarts irreversible billed sends. `write:catalog` is advertised as
   * "create/edit tags + custom fields"; a key minted for that must not be able
   * to restart a 50k-recipient campaign. Matches the internal twin's
   * `templates:manage` capability gate.
   */
  @Post("templates/:id/unpause")
  @RequireScope("admin:settings")
  async unpauseTemplate(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    await this.whatsapp.unpauseTemplate(auth.workspaceId, id);
    return { ok: true };
  }

  /**
   * Toggle button-click tracking on one template (Meta's
   * `cta_url_link_tracking_opted_out`). `admin:settings` like the internal
   * twin's `templates:manage` gate — it changes what analytics Meta records
   * for every future send of the template, workspace-wide.
   */
  @Post("templates/:id/link-tracking")
  @RequireScope("admin:settings")
  async setTemplateLinkTracking(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalSetLinkTrackingSchema)) body: ExternalSetLinkTrackingInput,
  ) {
    return this.whatsapp.setTemplateLinkTracking(auth.workspaceId, id, body.enabled);
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

  /**
   * The business phone number's public profile — what a customer sees when they
   * tap the business name. `?accountId=` picks one of the workspace's numbers;
   * each has its own profile.
   */
  @Get("whatsapp/profile")
  @RequireScope("read:catalog")
  async businessProfile(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.getBusinessProfile(auth.workspaceId, accountId);
  }

  /** OBA standing + the owning WABA's record. Read-only. */
  @Get("whatsapp/account-status")
  @RequireScope("read:catalog")
  async accountStatus(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.getAccountStatus(auth.workspaceId, accountId);
  }

  @Post("whatsapp/profile")
  @RequireScope("admin:settings")
  async updateBusinessProfile(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateBusinessProfileSchema)) body: UpdateBusinessProfileInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.updateBusinessProfile(auth.workspaceId, body, accountId);
  }

  /**
   * QR codes & short links. Meta caps a number at 2,000 and publishes no scan
   * analytics, so this is pure CRUD — there is nothing to report on.
   */
  @Get("whatsapp/qr-codes")
  @RequireScope("read:catalog")
  async listQrCodes(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.listQrCodes(auth.workspaceId, accountId);
  }

  @Post("whatsapp/qr-codes")
  @RequireScope("admin:settings")
  async createQrCode(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateQrCodeSchema)) body: CreateQrCodeInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.createQrCode(auth.workspaceId, body, accountId);
  }

  @Post("whatsapp/qr-codes/:code")
  @RequireScope("admin:settings")
  async updateQrCode(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("code") code: string,
    @Body(zBody(UpdateQrCodeSchema)) body: UpdateQrCodeInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.updateQrCode(auth.workspaceId, code, body, accountId);
  }

  /** Deleting a code breaks any signage printed with it — Meta shows the
   *  customer "this QR code has expired". */
  @Delete("whatsapp/qr-codes/:code")
  @RequireScope("admin:settings")
  async deleteQrCode(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("code") code: string,
    @Query("accountId") accountId?: string,
  ) {
    await this.whatsapp.deleteQrCode(auth.workspaceId, code, accountId);
    return { ok: true };
  }

  /**
   * The number's @username (a chat-native handle, 1:1 with the phone number,
   * globally unique across WhatsApp) plus Meta's reserved suggestions.
   * `?accountId=` picks one of the workspace's numbers.
   */
  @Get("whatsapp/username")
  @RequireScope("read:catalog")
  async whatsappUsername(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.getUsernameState(auth.workspaceId, accountId);
  }

  /**
   * Adopt or change it. A 409 `username_transfer_required` means the name is
   * on another of the portfolio's numbers — re-send with
   * `transferAction: "force_transfer"` to move it here deliberately.
   */
  @Post("whatsapp/username")
  @RequireScope("admin:settings")
  async setWhatsappUsername(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(SetWhatsappUsernameSchema)) body: SetWhatsappUsernameInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.setUsername(auth.workspaceId, body, accountId);
  }

  /** Remove it. Customers who saved the @handle lose that route to the chat. */
  @Delete("whatsapp/username")
  @RequireScope("admin:settings")
  async deleteWhatsappUsername(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    await this.whatsapp.deleteUsername(auth.workspaceId, accountId);
    return { ok: true };
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

  @Post("messages/:messageId/flags")
  @RequireScope("write:flags")
  async raiseMessageFlag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("messageId") messageId: string,
    @Body(zBody(ExternalRaiseFlagSchema)) body: ExternalRaiseFlagInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    // No Idempotency-Key requirement here, unlike sends: raising a flag is
    // idempotent by construction (@@unique([messageId, definitionId]) + upsert)
    // and costs nothing, so demanding a key would be friction with no payoff.
    return this.flags.raise(auth.workspaceId, auth.apiKeyId, messageId, body);
  }

  @Patch("message-flags/:flagId")
  @RequireScope("write:flags")
  async updateMessageFlag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("flagId") flagId: string,
    @Body(zBody(ExternalUpdateFlagSchema)) body: ExternalUpdateFlagInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.flags.update(auth.workspaceId, auth.apiKeyId, flagId, body);
  }

  @Delete("message-flags/:flagId")
  @RequireScope("write:flags")
  async deleteMessageFlag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("flagId") flagId: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.flags.remove(auth.workspaceId, auth.apiKeyId, flagId);
  }

  // ---- Calls --------------------------------------------------------
  //
  // Read history and permission state, ask a customer for calling permission,
  // and send them a call button. There is deliberately no "place a call": a
  // call needs an SDP offer from a live WebRTC peer and a browser to carry the
  // audio, so an API client has nothing to place one with. What's here is the
  // part an integration can genuinely drive.

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
   * Stream a call's stored recording (audio/ogg). 404s until the recording
   * has been ingested (`hasRecording: true` on the call row) — recordings
   * land about a minute after the call ends.
   */
  @Get("calls/:callId/recording")
  @RequireScope("read:calls")
  async streamCallRecording(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("callId") callId: string,
    @Headers("range") range: string | undefined,
    @Res() res: Response,
  ) {
    const ref = await this.calls.getRecordingRefForTeam(auth.workspaceId, callId);
    await streamBlob(res, ref.key, range, { downloadFilename: ref.filename });
  }

  /**
   * The transcript JSON document (speaker-attributed segments with word
   * timings; `transcript.language` is the auto-detected spoken language).
   * 404s until `hasTranscript` is true on the call row.
   */
  @Get("calls/:callId/transcript")
  @RequireScope("read:calls")
  async streamCallTranscript(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("callId") callId: string,
    @Headers("range") range: string | undefined,
    @Res() res: Response,
  ) {
    const ref = await this.calls.getTranscriptRefForTeam(auth.workspaceId, callId);
    await streamBlob(res, ref.key, range);
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
  ) {
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
  // BROADCAST WRITES
  // ===========================================================================
  //
  // Parity build, phase 3. The read surface has existed for a while; the write
  // surface was UI-only.
  //
  // `write:broadcasts` is a NEW scope and the most dangerous one in the API: a
  // create sends billed template messages to an entire audience and there is
  // no unsend. `read:broadcasts` deliberately does not imply it, so a
  // reporting integration can never be one typo away from launching a
  // campaign. Create and retry both REQUIRE an `Idempotency-Key`.

  /**
   * Launch a campaign (or schedule one — pass `scheduledAt`).
   *
   * `Idempotency-Key` REQUIRED and claimed irreversibly: a retry after a
   * gateway timeout must never produce a second campaign to the same audience,
   * and an ambiguous crash must not auto-clear into a re-send.
   */
  @Post("broadcasts")
  @RequireScope("write:broadcasts")
  @RateLimit({ perMinute: 10 })
  async createBroadcastV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateBroadcastSchema)) body: CreateBroadcastInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.api.createBroadcast(
      auth.workspaceId,
      auth.apiKeyId,
      body,
      idemKeyRequired(idempotencyKey),
    );
  }

  /**
   * Pre-send preflight: how many recipients would resolve a template variable
   * to empty and be rejected by WhatsApp. Read-only — call it before create so
   * you find out now rather than from the failure report.
   */
  @Post("broadcasts/preview-missing")
  @RequireScope("read:broadcasts")
  @RateLimit({ perMinute: 20 })
  async previewBroadcastMissingV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(PreviewMissingFieldsSchema)) body: PreviewMissingFieldsInput,
  ) {
    return this.broadcasts.previewMissingFields(auth.workspaceId, body);
  }

  /** Stop a running or scheduled campaign. Recipients already accepted by Meta
   *  stay sent — a message cannot be unsent. */
  @Post("broadcasts/:id/cancel")
  @RequireScope("write:broadcasts")
  async cancelBroadcastV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.broadcasts.cancel(auth.workspaceId, id);
    return { ok: true };
  }

  /**
   * Explicitly resume a PAUSED campaign. The only path that may lift an
   * `abuse_warning` pause — automatic recovery deliberately excludes it, so a
   * human choosing to continue after seeing the pause reason is the review
   * Meta's warning asks for. 409 `broadcast_not_paused` otherwise.
   */
  @Post("broadcasts/:id/resume")
  @RequireScope("write:broadcasts")
  async resumeBroadcastV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const resumed = await this.broadcasts.resume(auth.workspaceId, id);
    if (!resumed) {
      throw new ConflictException({ error: "broadcast_not_paused" });
    }
    return { ok: true };
  }

  /**
   * Re-queue FAILED recipients. `errorCodes` narrows it to one failure bucket,
   * so you can retry the rate-limited without also re-sending to numbers that
   * are permanently invalid. `Idempotency-Key` REQUIRED — this bills again.
   */
  @Post("broadcasts/:id/retry")
  @RequireScope("write:broadcasts")
  @RateLimit({ perMinute: 10 })
  async retryBroadcastV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(RetryBroadcastSchema)) body: RetryBroadcastInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.api.retryBroadcast(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKeyRequired(idempotencyKey),
    );
  }

  /** Delete a campaign and its recipient rows. Terminal campaigns only — the
   *  service refuses one that is still running. */
  @Delete("broadcasts/:id")
  @RequireScope("write:broadcasts")
  async deleteBroadcastV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.broadcasts.remove(auth.workspaceId, id);
    return { ok: true };
  }

  /** Every recipient contact id for a campaign — for building a follow-up
   *  audience from who actually received it. */
  @Get("broadcasts/:id/recipient-ids")
  @RequireScope("read:broadcasts")
  async listBroadcastRecipientIdsV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.broadcasts.listRecipientContactIds(auth.workspaceId, id);
  }

  // ===========================================================================
  // CUSTOMERS (unified identity)
  // ===========================================================================
  //
  // Parity build, phase 2. The platform ships unified customer identity — many
  // channel-scoped Contacts roll up to one Customer (a person) — but an
  // API-only integration could not SEE that two contacts were the same human,
  // let alone merge or split them. That is the largest single gap in /v1.
  //
  // Threads stay per-contact/per-channel; a Customer is the profile-and-
  // switcher layer over them. Merges here are the MANUAL, reversible kind:
  // automatic merging happens only on deterministic strong keys at ingest and
  // is deliberately not exposed.

  /** The person behind a contact, with every channel identity they own. */
  @Get("contacts/:id/customer")
  @RequireScope("read:contacts")
  async getCustomerByContactV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    const customer = await this.customers.getProfileByContact(auth.workspaceId, id);
    return { customer };
  }

  /**
   * Possible same-person matches for a contact — the candidates an agent is
   * shown before confirming a merge. Suggestions ONLY; nothing is merged until
   * you call link. Never fuzzy-name matching.
   */
  @Get("contacts/:id/merge-suggestions")
  @RequireScope("read:contacts")
  async getMergeSuggestionsV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    const suggestions = await this.customers.suggestLinks(auth.workspaceId, id);
    return { suggestions };
  }

  @Get("customers/:id")
  @RequireScope("read:contacts")
  async getCustomerV1(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const customer = await this.customers.getProfile(auth.workspaceId, id);
    return { customer };
  }

  @Patch("customers/:id")
  @RequireScope("write:contacts")
  async renameCustomerV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(RenameCustomerSchema)) body: RenameCustomerInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const customer = await this.customers.rename(auth.workspaceId, id, body.name);
    return { ok: true, customer };
  }

  /**
   * MERGE: point a contact at this customer. Reversible — merging never
   * deletes a contact or its messages, it only re-points `Contact.customerId`,
   * so `unlink` puts it back on its own customer. `actorUserId` is null: an
   * integration is not a person.
   */
  @Post("customers/:id/link")
  @RequireScope("write:contacts")
  async linkCustomerContactV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(LinkContactSchema)) body: LinkContactInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const customer = await this.customers.linkContact(
      auth.workspaceId,
      id,
      body.contactId,
      null,
    );
    return { ok: true, customer };
  }

  /** SPLIT: take a contact back off this customer onto its own. */
  @Post("customers/:id/unlink")
  @RequireScope("write:contacts")
  async unlinkCustomerContactV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UnlinkContactSchema)) body: UnlinkContactInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const out = await this.customers.unlinkContact(
      auth.workspaceId,
      id,
      body.contactId,
      null,
    );
    return { ok: true, ...out };
  }

  // ===========================================================================
  // OUTBOUND WEBHOOKS (management)
  // ===========================================================================
  //
  // Parity build, phase 1. Registering a webhook was UI-only, so a partner
  // could not receive a single event until a human clicked through Settings —
  // the biggest self-serve onboarding blocker in the API.
  //
  // `admin:settings` on every route, including the reads: a webhook endpoint is
  // a standing DATA-EGRESS grant (every subscribed event body leaves the
  // system), and the secret it returns signs that traffic. The internal twin is
  // admin-only for the same reason.

  @Get("outbound-webhooks")
  @RequireScope("admin:settings")
  async listOutboundWebhooksV1(@CurrentApiKey() auth: ApiKeyContext) {
    const webhooks = await this.outboundWebhooks.list(auth.workspaceId);
    return { webhooks };
  }

  /** The signing secret is returned ONCE here and never again — same contract
   *  as an API key. Store it before you acknowledge the response. */
  @Post("outbound-webhooks")
  @RequireScope("admin:settings")
  @RateLimit({ perMinute: 10 })
  async createOutboundWebhookV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateOutboundWebhookSchema)) body: CreateOutboundWebhookInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    // `createdById: null` — an API key is not a person. The service already
    // treats a null creator as "created by an integration".
    return this.outboundWebhooks.create(auth.workspaceId, null, body);
  }

  @Patch("outbound-webhooks/:id")
  @RequireScope("admin:settings")
  async updateOutboundWebhookV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateOutboundWebhookSchema)) body: UpdateOutboundWebhookInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const webhook = await this.outboundWebhooks.update(auth.workspaceId, id, body);
    return { webhook };
  }

  /** Rotate the signing secret. Returns the new one ONCE; the old one stops
   *  validating immediately, so swap it on your side in the same deploy. */
  @Post("outbound-webhooks/:id/rotate-secret")
  @RequireScope("admin:settings")
  @RateLimit({ perMinute: 10 })
  async rotateOutboundWebhookSecretV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.outboundWebhooks.rotateSecret(auth.workspaceId, id);
  }

  @Delete("outbound-webhooks/:id")
  @RequireScope("admin:settings")
  async deleteOutboundWebhookV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.outboundWebhooks.remove(auth.workspaceId, id);
    return { ok: true };
  }

  /**
   * Delivery log for one webhook — what we sent, the response code, and the
   * retry state. `OutboundWebhookDelivery` carries no `workspaceId` of its own
   * (documented parent-scoped tenancy exception), so the service proves
   * ownership of the PARENT webhook before reading any delivery row.
   */
  @Get("outbound-webhooks/:id/deliveries")
  @RequireScope("admin:settings")
  async listOutboundWebhookDeliveriesV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Query(zQuery(ListDeliveriesQuerySchema)) query: ListDeliveriesQueryInput,
  ) {
    return this.outboundWebhooks.listDeliveries(auth.workspaceId, id, query);
  }

  /** Fire a signed sample delivery so an integration can verify its endpoint +
   *  signature check before real traffic depends on it. */
  @Post("outbound-webhooks/:id/test")
  @RequireScope("admin:settings")
  @RateLimit({ perMinute: 10 })
  async testOutboundWebhookV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.outboundWebhooks.test(auth.workspaceId, id);
  }

  // ===========================================================================
  // AUDIENCE GROUPS
  // ===========================================================================
  //
  // Parity build, phase 1. A saved audience is what a broadcast targets, so
  // without these a partner could read campaigns but never build the list one
  // sends to. `write:catalog` matches the internal capability
  // (`audienceGroups:manage`, an admin/manager-grade catalog write).

  @Get("audience-groups")
  @RequireScope("read:catalog")
  async listAudienceGroupsV1(@CurrentApiKey() auth: ApiKeyContext) {
    const groups = await this.audienceGroups.list(auth.workspaceId);
    return { groups };
  }

  @Get("audience-groups/:id")
  @RequireScope("read:catalog")
  async getAudienceGroupV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    const group = await this.audienceGroups.get(auth.workspaceId, id);
    return { group };
  }

  @Post("audience-groups")
  @RequireScope("write:catalog")
  async createAudienceGroupV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateAudienceGroupSchema)) body: CreateAudienceGroupInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const group = await this.audienceGroups.create(auth.workspaceId, null, body);
    return { group };
  }

  @Patch("audience-groups/:id")
  @RequireScope("write:catalog")
  async updateAudienceGroupV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateAudienceGroupSchema)) body: UpdateAudienceGroupInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const group = await this.audienceGroups.update(auth.workspaceId, id, body);
    return { group };
  }

  @Delete("audience-groups/:id")
  @RequireScope("write:catalog")
  async deleteAudienceGroupV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.audienceGroups.remove(auth.workspaceId, id);
    return { ok: true };
  }

  // ===========================================================================
  // SNIPPETS
  // ===========================================================================
  //
  // Parity build, phase 1. `read/write:catalog` already ADVERTISED snippets
  // (see the scope descriptions) while no route existed.

  @Get("snippets")
  @RequireScope("read:catalog")
  async listSnippetsV1(@CurrentApiKey() auth: ApiKeyContext) {
    const snippets = await this.snippets.list(auth.workspaceId);
    return { snippets };
  }

  @Post("snippets")
  @RequireScope("write:catalog")
  async createSnippetV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateSnippetSchema)) body: CreateSnippetInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const created = await this.snippets.create(auth.workspaceId, null, body);
    return { ok: true, id: created.id };
  }

  @Patch("snippets/:id")
  @RequireScope("write:catalog")
  async updateSnippetV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateSnippetSchema)) body: UpdateSnippetInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.snippets.update(auth.workspaceId, id, body);
    return { ok: true };
  }

  @Delete("snippets/:id")
  @RequireScope("write:catalog")
  async deleteSnippetV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.snippets.remove(auth.workspaceId, id);
    return { ok: true };
  }
}

/**
 * An API key as a saved-view actor.
 *
 * `userId: null` is the whole point — it makes the service treat this caller
 * as "not a person": shared views only, no personal ownership, and `me`
 * assignee filters resolve to nothing. `canManageShared: true` because a key
 * holding `write:catalog` is already trusted with workspace-wide
 * configuration; gating it further would only mean a partner can create tags
 * and stages but not the view that uses them.
 */
function apiKeyViewActor(auth: ApiKeyContext): InboxViewActor {
  return { workspaceId: auth.workspaceId, userId: null, canManageShared: true };
}
