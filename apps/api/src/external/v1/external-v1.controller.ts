import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  Param,
  Patch,
  Post,
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

import { TRANSFER_MAX_UPLOAD_BYTES } from "@ccp/shared/contacts/transfer-columns";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { hasScope } from "@ccp/shared/api-keys/scopes";
import { RateLimit } from "../../common/rate-limit.interceptor";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { MAX_CHAIN_DEPTH, parseChainDepth } from "@/lib/workflows/events";
import { ContactTransferService } from "@/contacts/transfer.service";
import {
  CreateExportSchema,
  ListTransfersQuerySchema,
  type CreateExportInput,
  type ListTransfersQueryInput,
} from "@/contacts/transfer.schemas";
import { ExternalV1Service } from "./external-v1.service";
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
 *   POST   /v1/conversations/:id/interactive  — buttons / list / phone-email consent chips
 *   POST   /v1/conversations/:id/notes
 *   DELETE /v1/conversations/:id/notes/:noteId — remove a note (fires note.deleted)
 *   GET    /v1/messages/:id                   — find a single message
 *
 * Bearer auth via TeamApiKey; ApiKeyGuard validates and exposes ApiKeyContext
 * with teamId + apiKeyId. All writes publish the SAME domain events the
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
  ) {}

  /**
   * Cross-system loop guard for EVERY mutating /v1 route that publishes a
   * domain event (which can fan an outbound webhook back to the partner, who
   * may POST back here). The outbound-webhook deliverer stamps an incrementing
   * `X-CCP-Depth` on each delivery; if a request arrives already at/over the
   * cap, refuse it with 429 to break the loop. The send + bulk-tag routes
   * already do this via their service methods; this centralizes the SAME check
   * for the contact + conversation mutation routes that previously omitted it
   * (createContact, upsert, update, delete, tag add/remove, assign, setStatus,
   * and the contact-keyed assign/status aliases). HTTP-boundary concern, so it
   * lives in the controller — the service signatures stay untouched.
   */
  private guardChainDepth(xCcpDepth: string | undefined): void {
    const depth = parseChainDepth(xCcpDepth);
    if (depth >= MAX_CHAIN_DEPTH) {
      throw new HttpException(
        {
          error: "chain_depth_exceeded",
          detail:
            `inbound X-CCP-Depth ${depth} >= ${MAX_CHAIN_DEPTH} — request dropped ` +
            "to break a likely cross-system loop.",
        },
        429,
      );
    }
  }

  /**
   * Normalize the inbound `Idempotency-Key` header for EVERY /v1 mutation:
   *   - trim; empty/absent → `undefined` (no idempotency, as before)
   *   - > 255 chars → 400 `idempotency_key_too_long` (Stripe convention: an
   *     invalid key errors, it does NOT silently degrade — the two send routes
   *     used to drop an over-long key, leaving the highest-risk operation with
   *     ZERO duplicate-send protection on a partner's retry-after-timeout flow).
   * 255 is the same ceiling the send routes already enforced; applying it
   * uniformly keeps the surface internally consistent (other routes had NO cap).
   */
  private idemKey(raw: string | undefined): string | undefined {
    const trimmed = raw?.trim();
    if (!trimmed) return undefined;
    if (trimmed.length > 255) {
      throw new HttpException(
        {
          error: "idempotency_key_too_long",
          detail: "Idempotency-Key must be at most 255 characters.",
        },
        400,
      );
    }
    return trimmed;
  }

  // Same as idemKey() but MANDATORY — for routes that send to Meta. A WhatsApp
  // send is non-idempotent (Meta assigns the wamid; we can't dedupe before the
  // call returns), bills the team, and counts against their quality rating. The
  // only thing that makes a partner's retry-after-5xx safe is a stable client
  // key, so we refuse the send without one rather than risk double-texting the
  // customer. Use a unique value per logical send (e.g. the inbound message id).
  private idemKeyRequired(raw: string | undefined): string {
    const key = this.idemKey(raw);
    if (!key) {
      throw new HttpException(
        {
          error: "idempotency_key_required",
          detail:
            "Send an Idempotency-Key header (unique per logical send, e.g. the inbound message id) so a retry can't double-send to WhatsApp.",
        },
        400,
      );
    }
    return key;
  }

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
      auth.teamId,
      auth.apiKeyId,
      "tag-add",
      body,
      this.idemKey(idempotencyKey),
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
      auth.teamId,
      auth.apiKeyId,
      "tag-remove",
      body,
      this.idemKey(idempotencyKey),
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
    return this.transfers.startExport({ teamId: auth.teamId, userId: null, input: body });
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
    this.guardChainDepth(xCcpDepth);
    return this.api.startContactImport(
      auth.teamId,
      auth.apiKeyId,
      body,
      this.idemKey(idempotencyKey),
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
    return this.transfers.preview(auth.teamId, file);
  }

  @Get("contacts/transfers")
  @RequireScope("read:contacts")
  async listContactTransfers(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListTransfersQuerySchema)) query: ListTransfersQueryInput,
  ) {
    return this.transfers.list(auth.teamId, query);
  }

  @Get("contacts/transfers/:id")
  @RequireScope("read:contacts")
  async getContactTransfer(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    return { job: await this.transfers.get(auth.teamId, id) };
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
    res.redirect(302, await this.transfers.downloadUrl(auth.teamId, id, "result"));
  }

  @Get("contacts/transfers/:id/errors")
  @RequireScope("read:contacts")
  async errorsContactTransfer(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(302, await this.transfers.downloadUrl(auth.teamId, id, "errors"));
  }

  @Post("contacts/transfers/:id/cancel")
  @RequireScope("write:contacts")
  async cancelContactTransfer(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    return this.transfers.cancel(auth.teamId, id);
  }

  // ---- Contacts: create / upsert / update / delete ------------------

  @Post("contacts")
  @RequireScope("write:contacts")
  async createContact(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalCreateContactSchema)) body: ExternalCreateContactInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    this.guardChainDepth(xCcpDepth);
    const contact = await this.api.createContact(auth.teamId, auth.apiKeyId, body);
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
    this.guardChainDepth(xCcpDepth);
    return this.api.upsertContact(
      auth.teamId,
      auth.apiKeyId,
      body,
      this.idemKey(idempotencyKey),
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
    this.guardChainDepth(xCcpDepth);
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
      auth.teamId,
      auth.apiKeyId,
      id,
      parsed.data,
      this.idemKey(idempotencyKey),
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
    this.guardChainDepth(xCcpDepth);
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
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    this.guardChainDepth(xCcpDepth);
    const contact = await this.api.addContactTags(
      auth.teamId,
      auth.apiKeyId,
      id,
      body,
      this.idemKey(idempotencyKey),
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
    this.guardChainDepth(xCcpDepth);
    const contact = await this.api.removeContactTag(
      auth.teamId,
      auth.apiKeyId,
      id,
      tagId,
      this.idemKey(idempotencyKey),
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
    this.guardChainDepth(xCcpDepth);
    const contact = await this.api.removeContactTags(
      auth.teamId,
      auth.apiKeyId,
      id,
      body.tagIds,
      body.silent === true,
      this.idemKey(idempotencyKey),
      hasScope(auth.scopes, "read:contacts"),
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

  // ── Broadcasts (read-only) ────────────────────────────────────────────────
  // Clients pull campaign results into their own BI. Same DTO the in-app report
  // renders, so the API and the UI can never disagree about a number.

  @Get("broadcasts")
  @RequireScope("read:broadcasts")
  async listBroadcasts(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListBroadcastsQuerySchema)) query: ListBroadcastsQueryInput,
  ) {
    return this.api.listBroadcasts(auth.teamId, query);
  }

  @Get("broadcasts/:id")
  @RequireScope("read:broadcasts")
  async getBroadcast(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const broadcast = await this.api.getBroadcast(auth.teamId, id);
    return { broadcast };
  }

  /** Delivery funnel, rates, failure buckets, cost and diagnostics. */
  @Get("broadcasts/:id/report")
  @RequireScope("read:broadcasts")
  async getBroadcastReport(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const report = await this.api.getBroadcastReport(auth.teamId, id);
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
    return this.api.listBroadcastRecipients(auth.teamId, id, query);
  }

  @Get("conversations")
  @RequireScope("read:conversations")
  async listConversations(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListConversationsQuerySchema)) query: ListConversationsQueryInput,
  ) {
    return this.api.listConversations(
      auth.teamId,
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
      auth.teamId,
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
    this.guardChainDepth(xCcpDepth);
    await this.api.assign(auth.teamId, auth.apiKeyId, id, body, this.idemKey(idempotencyKey));
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
    this.guardChainDepth(xCcpDepth);
    await this.api.setStatus(auth.teamId, auth.apiKeyId, id, body, this.idemKey(idempotencyKey));
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
    this.guardChainDepth(xCcpDepth);
    await this.api.setAiEnabled(auth.teamId, auth.apiKeyId, id, body, this.idemKey(idempotencyKey));
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
    this.guardChainDepth(xCcpDepth);
    return this.api.assignByContact(
      auth.teamId,
      auth.apiKeyId,
      id,
      body,
      this.idemKey(idempotencyKey),
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
    this.guardChainDepth(xCcpDepth);
    return this.api.setStatusByContact(
      auth.teamId,
      auth.apiKeyId,
      id,
      body,
      this.idemKey(idempotencyKey),
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
    this.guardChainDepth(xCcpDepth);
    const contact = await this.api.updateContact(
      auth.teamId,
      auth.apiKeyId,
      id,
      { stageId: body.stageId },
      this.idemKey(idempotencyKey),
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
    this.guardChainDepth(xCcpDepth);
    return this.api.sendTopLevelMessage(
      auth.teamId,
      auth.apiKeyId,
      body,
      this.idemKeyRequired(idempotencyKey),
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
      auth.teamId,
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
      auth.teamId,
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
    this.guardChainDepth(xCcpDepth);
    const out = await this.api.sendMessage(
      auth.teamId,
      auth.apiKeyId,
      id,
      body,
      this.idemKeyRequired(idempotencyKey),
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
   * docs/organization-api.md and the /docs/api page alongside the URL-media
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
    this.guardChainDepth(xCcpDepth);
    return this.api.sendInteractive(
      auth.teamId,
      auth.apiKeyId,
      id,
      body,
      this.idemKeyRequired(idempotencyKey),
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
      auth.teamId,
      auth.apiKeyId,
      id,
      body,
      this.idemKey(idempotencyKey),
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
  ) {
    return this.api.deleteNote(auth.teamId, id, noteId);
  }
  // ---- Calls --------------------------------------------------------
  //
  // Read history and permission state, ask a customer for calling permission,
  // and send them a call button. There is deliberately no "place a call": a
  // call needs an SDP offer from a live WebRTC peer and a browser to carry the
  // audio, so an API client has nothing to place one with. What's here is the
  // part an integration can genuinely drive.

  @Get("calls")
  @RequireScope("read:calls")
  async listCalls(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ExternalListCallsQuerySchema)) query: ExternalListCallsQueryInput,
  ) {
    return this.api.listCalls(auth.teamId, query);
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
    return this.api.getCallPermission(auth.teamId, id);
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
      auth.teamId,
      auth.apiKeyId,
      id,
      this.idemKeyRequired(idempotencyKey),
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
      auth.teamId,
      auth.apiKeyId,
      id,
      body,
      this.idemKeyRequired(idempotencyKey),
    );
  }
}
