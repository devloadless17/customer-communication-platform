import { getBroadcastReport, recipientOutcomeWhere } from "@/lib/broadcast-report";
import type {
  ExternalCallButtonInput,
  ExternalListCallsQueryInput,
  ExternalStartImportInput,
  ListBroadcastRecipientsQueryInput,
  ListBroadcastsQueryInput,
} from "./external-v1.schemas";
import { normalizeStringMap } from "@/lib/normalize-string-map";
import { Prisma } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { isReservedFieldKey } from "@ccp/shared/contacts/reserved-fields";
import { MAX_CHAIN_DEPTH } from "@/lib/workflows/events";
import { ContactTransferService } from "@/contacts/transfer.service";
import { toExternalAvatarUrl } from "@/lib/blob-storage";

import {
  contactRowToExternal,
  toExternalContact,
  redactExternalContactPii,
  EXTERNAL_CONTACT_INCLUDE,
  type ExternalContact,
  externalTemplate,
} from "@/lib/external-shapes";
import { directoryContactWhere, ensureDefaultStage, toContactWire } from "@/lib/queries";
import type {
  Contact as DomainContact,
  ContactStage,
  Tag,
  User,
} from "@ccp/shared/types";
import type { ContactFieldChange } from "@ccp/shared/events/types";
import { TAG_COLORS, type TagColor, type UserAvailabilityStatus } from "@ccp/shared/types";
import { getCountryFromPhone } from "@ccp/shared/utils";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import { runWithConcurrency } from "../../common/concurrency";
import { ApiIdempotencyService } from "./api-idempotency.service";
import { ExternalV1MessagingService } from "./external-v1-messaging.service";
import { getProviderBinding } from "@/lib/providers";
import { CallsService } from "@/calls/calls.service";
import { UsersService } from "@/users/users.service";
import {
  asWorkHours,
  type AvailabilitySource,
  type WorkHoursMode,
} from "@ccp/shared/work-hours";
import type {
  SetUserAvailabilityInput,
  SetUserWorkHoursInput,
} from "@/users/users.schemas";
import type {
  ExternalAssignInput,
  ExternalBulkTagInput,
  ExternalContactAddTagsInput,
  ExternalContactAssignInput,
  ExternalContactStatusInput,
  ExternalCreateContactFieldInput,
  ExternalCreateContactInput,
  ExternalCreateTagInput,
  ExternalNoteInput,
  ExternalSendInteractiveInput,
  ExternalSendMessageInput,
  ExternalSetAiInput,
  ExternalStatusInput,
  ExternalTopLevelSendMessageInput,
  ExternalUpdateContactInput,
  ExternalUpdateTagInput,
  ExternalUpsertContactInput,
  ListContactsQueryInput,
  ListConversationsQueryInput,
  ListMessagesQueryInput,
} from "./external-v1.schemas";

const MAX_TEXT = 500;

/**
 * External API service. Routes are parallel to the internal ones but
 * scoped by `workspaceId` from the API key, and `changedByUserId / senderUserId`
 * is always null (the API key is an org-level credential, not a person).
 *
 * Each operation publishes the SAME domain event the internal route does —
 * downstream subscribers (socket fanout, audit, analytics, workflow
 * dispatch, future outbound webhooks) can't tell which entry point fired.
 *
 * The conversation / message / note / send routes live on
 * `ExternalV1MessagingService`. This service injects that one and
 * delegates so the controller still sees a single facade (zero churn at
 * the controller layer) while each half stays at a tractable size.
 */
/**
 * Availability + schedule fields on the external User shape. Emitted only when
 * they carry information (same terse rule as the internal mapper) so a partner
 * polling the roster isn't handed four nulls per member.
 */
function availabilityFields(u: {
  availabilityStatus: string | null;
  availabilityMessage: string | null;
  availabilitySource: string | null;
  availabilityOverrideUntil: Date | null;
  workHoursMode: string;
  workHours: unknown;
}) {
  return {
    ...(u.availabilityStatus
      ? { availabilityStatus: u.availabilityStatus as UserAvailabilityStatus }
      : {}),
    ...(u.availabilityMessage ? { availabilityMessage: u.availabilityMessage } : {}),
    ...(u.availabilitySource && u.availabilitySource !== "manual"
      ? { availabilitySource: u.availabilitySource as AvailabilitySource }
      : {}),
    ...(u.availabilityOverrideUntil
      ? { availabilityUntil: u.availabilityOverrideUntil.toISOString() }
      : {}),
    workHoursMode: u.workHoursMode as WorkHoursMode,
    ...(u.workHours ? { workHours: asWorkHours(u.workHours) } : {}),
  };
}

@Injectable()
export class ExternalV1Service {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
    private readonly messaging: ExternalV1MessagingService,
    private readonly idem: ApiIdempotencyService,
    private readonly transfers: ContactTransferService,
    private readonly calls: CallsService,
    // Availability writes go through the SAME service the internal admin route
    // uses, so /v1 and the UI share one writer (and one set of rules).
    private readonly users: UsersService,
  ) {}

  /**
   * Wrap a mutation thunk in CLAIM-then-execute idempotency. No-op (just runs
   * `work`) when `idempotencyKey` is absent, so existing callers that don't pass
   * a key are unchanged. A replay short-circuits the thunk entirely — zero side
   * effects — and returns the prior response. Used by the contact tag mutations
   * (F2 in docs/audit-guide.md). The conversation mutations
   * inline the same pattern in ExternalV1MessagingService.
   */
  private async withIdempotency<T>(
    workspaceId: string,
    apiKeyId: string,
    idempotencyKey: string | undefined,
    route: string,
    fingerprintPayload: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!idempotencyKey) return work();
    const claim = await this.idem.claim<T>(
      workspaceId,
      apiKeyId,
      idempotencyKey,
      this.idem.fingerprint(route, fingerprintPayload),
    );
    if (claim.kind === "replay") return claim.result;
    try {
      const result = await work();
      await this.idem.complete(workspaceId, apiKeyId, idempotencyKey, result);
      return result;
    } catch (err) {
      await this.idem.release(workspaceId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  /**
   * Apply the same `read:contacts` PII gate the conversation/message reads use
   * (redactExternalContactPii) to a contact-mutation RESPONSE. A `write:contacts`
   * key can mutate a contact but must not receive its full directory row back —
   * otherwise tag-add / stage / update become a per-id contact-read side door.
   * The stored idempotency result stays UNredacted (we redact only the returned
   * value), so a later replay carrying `read:contacts` still surfaces full PII.
   */
  private applyContactPii(
    contact: ExternalContact,
    includeContactPii: boolean,
  ): ExternalContact {
    return includeContactPii ? contact : redactExternalContactPii(contact);
  }

  // ===========================================================================
  // Delegations to ExternalV1MessagingService — pass-through, no behavior here.
  // ===========================================================================

  /**
   * Resolve one of our template ids to Meta's, workspace-scoped.
   *
   * The analytics rollup is keyed on META's id, so a caller passing our row id
   * (which is what every other `/v1` template route takes) has to be translated
   * — otherwise the lookup silently returns an empty series that reads as "this
   * template has no data".
   */
  async getTemplateExternalId(
    workspaceId: string,
    templateId: string,
  ): Promise<string | null> {
    const row = await this.db.messageTemplate.findFirst({
      where: { id: templateId, workspaceId },
      select: { externalId: true },
    });
    return row?.externalId ?? null;
  }

  listConversations(
    workspaceId: string,
    q: ListConversationsQueryInput,
    includeContactPii = true,
    viewClauses: Prisma.ConversationWhereInput[] = [],
  ) {
    return this.messaging.listConversations(workspaceId, q, includeContactPii, viewClauses);
  }

  getConversation(workspaceId: string, id: string, includeContactPii = true) {
    return this.messaging.getConversation(workspaceId, id, includeContactPii);
  }

  assign(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalAssignInput,
    idempotencyKey?: string,
  ) {
    return this.messaging.assign(workspaceId, apiKeyId, conversationId, input, idempotencyKey);
  }

  setStatus(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalStatusInput,
    idempotencyKey?: string,
  ) {
    return this.messaging.setStatus(workspaceId, apiKeyId, conversationId, input, idempotencyKey);
  }

  setAiEnabled(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSetAiInput,
    idempotencyKey?: string,
  ) {
    return this.messaging.setAiEnabled(workspaceId, apiKeyId, conversationId, input, idempotencyKey);
  }

  listMessages(
    workspaceId: string,
    conversationId: string,
    q: ListMessagesQueryInput,
    includeContactPii = true,
  ) {
    return this.messaging.listMessages(workspaceId, conversationId, q, includeContactPii);
  }

  findMessage(workspaceId: string, id: string, includeContactPii = true) {
    return this.messaging.findMessage(workspaceId, id, includeContactPii);
  }

  sendMessage(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSendMessageInput,
    idempotencyKey?: string,
    chainDepth?: number,
    reopenIfClosed?: boolean,
  ) {
    return this.messaging.sendMessage(
      workspaceId,
      apiKeyId,
      conversationId,
      input,
      idempotencyKey,
      chainDepth,
      reopenIfClosed,
    );
  }

  sendInteractive(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSendInteractiveInput,
    idempotencyKey: string,
  ) {
    return this.messaging.sendInteractive(
      workspaceId,
      apiKeyId,
      conversationId,
      input,
      idempotencyKey,
    );
  }

  assignByContact(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAssignInput,
    idempotencyKey?: string,
  ) {
    return this.messaging.assignByContact(workspaceId, apiKeyId, contactId, input, idempotencyKey);
  }

  setStatusByContact(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactStatusInput,
    idempotencyKey?: string,
  ) {
    return this.messaging.setStatusByContact(workspaceId, apiKeyId, contactId, input, idempotencyKey);
  }

  sendTopLevelMessage(
    workspaceId: string,
    apiKeyId: string,
    input: ExternalTopLevelSendMessageInput,
    idempotencyKey?: string,
    chainDepth?: number,
  ) {
    return this.messaging.sendTopLevelMessage(workspaceId, apiKeyId, input, idempotencyKey, chainDepth);
  }

  createNote(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalNoteInput,
    idempotencyKey?: string,
    chainDepth?: number,
  ) {
    return this.messaging.createNote(
      workspaceId,
      apiKeyId,
      conversationId,
      input,
      idempotencyKey,
      chainDepth,
    );
  }

  deleteNote(workspaceId: string, conversationId: string, noteId: string) {
    return this.messaging.deleteNote(workspaceId, conversationId, noteId);
  }


  // ===========================================================================
  // CALLS
  // ===========================================================================

  /** Call history, newest first. Keyset cursor `<ringingAtMs>_<id>`. */
  async listCalls(workspaceId: string, query: ExternalListCallsQueryInput) {
    const parsed = ((): { ringingAt: Date; id: string } | null => {
      if (!query.cursor) return null;
      const i = query.cursor.indexOf("_");
      if (i <= 0) return null;
      const ms = Number(query.cursor.slice(0, i));
      const id = query.cursor.slice(i + 1);
      return Number.isFinite(ms) && id ? { ringingAt: new Date(ms), id } : null;
    })();

    const ringingAt: Prisma.DateTimeFilter = {};
    if (query.from) {
      const d = new Date(query.from);
      if (!Number.isNaN(d.getTime())) ringingAt.gte = d;
    }
    if (query.to) {
      const d = new Date(query.to);
      if (!Number.isNaN(d.getTime())) ringingAt.lte = d;
    }

    const where: Prisma.CallWhereInput = {
      workspaceId,
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(ringingAt.gte || ringingAt.lte ? { ringingAt } : {}),
      ...(parsed
        ? {
            OR: [
              { ringingAt: { lt: parsed.ringingAt } },
              { ringingAt: parsed.ringingAt, id: { lt: parsed.id } },
            ],
          }
        : {}),
    };

    const rows = await this.db.call.findMany({
      where,
      orderBy: [{ ringingAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select: {
        id: true,
        conversationId: true,
        channel: true,
        direction: true,
        status: true,
        ringingAt: true,
        answeredAt: true,
        endedAt: true,
        durationSeconds: true,
        conversation: { select: { contactId: true } },
      },
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map((c) => ({
        id: c.id,
        conversation_id: c.conversationId,
        contact_id: c.conversation.contactId,
        channel: c.channel,
        direction: c.direction,
        status: c.status,
        // A call that was picked up. Note this is NOT `status === "completed"`:
        // an agent can hang up a connected call, and a call can complete
        // without ever being answered.
        connected: c.answeredAt !== null,
        ringing_at: c.ringingAt.toISOString(),
        answered_at: c.answeredAt?.toISOString() ?? null,
        ended_at: c.endedAt?.toISOString() ?? null,
        duration_seconds: c.durationSeconds,
      })),
      next_cursor:
        hasMore && last ? `${last.ringingAt.getTime()}_${last.id}` : null,
    };
  }

  /**
   * The customer's live calling-permission state, straight from the provider.
   *
   * Deliberately not served from our own rows: permission can be granted in
   * ways that touch nothing on our side (the customer calling us, or granting
   * from their business profile), so a local answer would tell an integration
   * "no permission" for someone perfectly callable.
   */
  async getCallPermission(workspaceId: string, conversationId: string) {
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: {
        channel: true,
        contact: { select: { phoneNumber: true, bsuid: true } },
      },
    });
    if (!conv) throw new NotFoundException({ error: "conversation_not_found" });
    const binding = getProviderBinding(conv.channel);
    const read = binding.provider.getCallPermission;
    if (!read) {
      throw new BadRequestException({
        error: "calling_not_supported",
        detail: `Calling isn't available on ${conv.channel}.`,
      });
    }
    if (!conv.contact?.phoneNumber && !conv.contact?.bsuid) {
      throw new BadRequestException({ error: "contact_has_no_callable_identity" });
    }
    const config = await binding.getSendConfig(workspaceId);
    const permission = await read(
      {
        ...(conv.contact.phoneNumber ? { to: conv.contact.phoneNumber } : {}),
        ...(conv.contact.bsuid ? { recipient: conv.contact.bsuid } : {}),
      },
      config,
    );
    return {
      status: permission.status,
      has_permission: permission.hasPermission,
      can_start_call: permission.canStartCall,
      can_request_permission: permission.canRequestPermission,
      expires_at: permission.expiresAt?.toISOString() ?? null,
      // Present only when the per-customer call quota is spent.
      quota_resets_at: permission.startCallResetAt?.toISOString() ?? null,
    };
  }

  /** Ask the customer for permission to call them. Sends a billable message. */
  async requestCallPermission(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    idempotencyKey?: string,
  ) {
    return this.withIdempotency(
      workspaceId,
      apiKeyId,
      idempotencyKey,
      "POST /v1/conversations/:id/call-permission",
      { conversationId },
      async () => {
        const out = await this.calls.requestPermissionForTeam(
          workspaceId,
          conversationId,
        );
        return {
          ok: true as const,
          permission_request_id: out.permissionRequestId,
          expires_at: out.expiresAt,
        };
      },
    );
  }

  /** Send a call button inviting the customer to call us. */
  async sendCallButton(
    workspaceId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalCallButtonInput,
    idempotencyKey?: string,
  ) {
    return this.withIdempotency(
      workspaceId,
      apiKeyId,
      idempotencyKey,
      "POST /v1/conversations/:id/call-button",
      { conversationId, ...input },
      async () => {
        const out = await this.calls.sendCallButtonForTeam(
          workspaceId,
          conversationId,
          input,
        );
        return { ok: true as const, message_id: out.externalId };
      },
    );
  }

  // ===========================================================================
  // CONTACTS — read
  // ===========================================================================

  async getContact(workspaceId: string, id: string) {
    const row = await this.db.contact.findFirst({
      // deletedAt:null — a tombstoned contact is gone from the directory; the
      // list path + every mutation already filter it out, so a direct GET must
      // 404 too (a partner holding a cached id would otherwise see it as live
      // here but get a 404 on the next PATCH — an inconsistent surface).
      where: { id, workspaceId, deletedAt: null },
      include: EXTERNAL_CONTACT_INCLUDE,
    });
    if (!row) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });
    return contactRowToExternal(row);
  }

  /**
   * Find or list contacts. `phone` is the n8n "Find a Contact" path — exact
   * E.164 match, at most one row. Everything else is the paged list path.
   */
  async listContacts(workspaceId: string, q: ListContactsQueryInput) {
    // Natural-key short-circuits. Integrators usually know exactly one of
    // {phone, email, externalContactId} and want a single hydrated row back
    // without paging. Each branch returns at most one item and no cursor.
    //
    // Phone is normalized server-side so a mis-formatted "961 71 50…" still
    // resolves to the same E.164 row.
    // Directory-scoped, exactly like the internal list (§12 parity). An anonymous
    // website visitor is a chat session, not a directory row, so it must not answer
    // a partner's "who is +961…?" — doubly so because a widget phone/email is typed
    // into a public form and verifies nothing. A visitor who self-identified IS
    // promoted and does resolve. `getContact` by id stays unfiltered: unlike a
    // tombstone the thread is live, and a partner legitimately holds that id from a
    // `message.received` webhook.
    if (q.phone) {
      const normalized = normalizePhoneE164(q.phone) ?? q.phone;
      const rows = await this.db.contact.findMany({
        // Phone is the WhatsApp identity (the partial unique on
        // (workspaceId, phoneNumber) fires only for identityChannel='whatsapp'). The
        // same number can also sit on a social/widget contact via contact-share
        // or widget pre-chat; scope to whatsapp so a partner "who is +…?" lookup
        // is deterministic and returns the phone's canonical owner, not a row
        // that merely borrowed it. (Safe scalar AND — directoryContactWhere's OR
        // has no sibling OR here.)
        where: { workspaceId, deletedAt: null, ...directoryContactWhere, identityChannel: "whatsapp", phoneNumber: normalized },
        include: EXTERNAL_CONTACT_INCLUDE,
        take: 1,
      });
      const items = rows.map((r) => contactRowToExternal(r));
      return { items, nextCursor: null };
    }
    if (q.email) {
      const rows = await this.db.contact.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          ...directoryContactWhere,
          email: { equals: q.email.trim(), mode: "insensitive" },
        },
        include: EXTERNAL_CONTACT_INCLUDE,
        take: 1,
      });
      const items = rows.map((r) => contactRowToExternal(r));
      return { items, nextCursor: null };
    }
    if (q.externalContactId) {
      const rows = await this.db.contact.findMany({
        where: { workspaceId, deletedAt: null, externalContactId: q.externalContactId },
        include: EXTERNAL_CONTACT_INCLUDE,
        take: 1,
      });
      const items = rows.map((r) => contactRowToExternal(r));
      return { items, nextCursor: null };
    }

    const tagIds = q.tagIds
      ? q.tagIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : [];

    const rows = await this.db.contact.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(q.stageId ? { stageId: q.stageId } : {}),
        ...(tagIds.length > 0 ? { tags: { some: { id: { in: tagIds } } } } : {}),
        // Both the directory predicate and the search clause are OR nodes, so they
        // must be AND-composed — spreading both at this level would leave only the
        // last one and silently widen the result set.
        AND: [
          directoryContactWhere,
          ...(q.search
            ? [
                {
                  OR: [
                    { name: { contains: q.search, mode: "insensitive" as const } },
                    { phoneNumber: { contains: q.search, mode: "insensitive" as const } },
                    { email: { contains: q.search, mode: "insensitive" as const } },
                  ],
                },
              ]
            : []),
        ],
      },
      include: EXTERNAL_CONTACT_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map((r) => contactRowToExternal(r));
    const lastItem = items[items.length - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    return { items, nextCursor };
  }

  // ===========================================================================
  // CONTACTS — mutations
  // ===========================================================================

  /**
   * Inline create. Mirrors ContactsService.create (phone normalization,
   * default-stage assignment, dup-phone 409) but publishes `contact.created`
   * + `contact.updated { kind: "created", changedByApiKeyId }` directly so
   * audit attribution carries the API key, not a synthesized user.
   *
   * `contact.created` is the first-class event the outbound-webhooks
   * "On Contact created" trigger subscribes to. `contact.updated` is also
   * published for parity with the inbound path + existing internal
   * subscribers that haven't been migrated yet.
   */
  async createContact(
    workspaceId: string,
    apiKeyId: string,
    input: ExternalCreateContactInput,
  ): Promise<ExternalContact> {
    const phone = normalizePhoneE164(input.phoneNumber);
    if (!phone) {
      throw new BadRequestException({
        error: "invalid_phone",
        detail:
          "phoneNumber must be a valid international number (e.g. +1 555 555 0100)",
      });
    }

    // Name resolution: explicit `name` wins; else derive from first + last
    // (matches the migration's reverse-split rule + ingest.ts splitContactName);
    // else fall back to phone so the inbox always has a sortable label.
    const trimmedFirst = trimOrNull(input.firstName);
    const trimmedLast = trimOrNull(input.lastName);
    const name =
      input.name && input.name.trim().length > 0
        ? input.name.trim().slice(0, MAX_TEXT)
        : trimmedFirst || trimmedLast
        ? `${trimmedFirst ?? ""}${trimmedFirst && trimmedLast ? " " : ""}${trimmedLast ?? ""}`.trim().slice(0, MAX_TEXT)
        : phone;
    const email = trimOrNull(input.email);
    const location = trimOrNull(input.location);
    const language = trimOrNull(input.language);
    // Auto-derive country code when not explicitly supplied — same convergence
    // point as the inbound webhook path (lib/providers/ingest.ts).
    const countryCode = input.countryCode ?? getCountryFromPhone(phone);
    const customFields = normalizeCreateCustomFields(input.customFields ?? {});

    // Honor caller-supplied stage if valid + team-scoped; otherwise fall
    // back to the team's default stage (lazy-init for older teams).
    let stageId: string | null;
    if (input.stageId) {
      const stage = await this.db.contactStage.findFirst({
        where: { id: input.stageId, workspaceId },
        select: { id: true },
      });
      if (!stage) throw new BadRequestException({ error: "stage_not_found", detail: "stage not found" });
      stageId = stage.id;
    } else {
      stageId = await ensureDefaultStage(workspaceId);
    }

    // Tag validation: only keep tag ids that exist on this team — defense
    // against an integration sending stale / cross-team ids.
    let validTagIds: string[] = [];
    if (input.tagIds && input.tagIds.length > 0) {
      const tags = await this.db.tag.findMany({
        where: { workspaceId, id: { in: input.tagIds } },
        select: { id: true },
      });
      validTagIds = tags.map((t) => t.id);
    }

    let created;
    try {
      created = await this.db.contact.create({
        data: {
          workspaceId,
          // External /v1 contact create is WhatsApp-only (input requires
          // phone). Channel stamped explicitly — when a partner adds an IG
          // /v1 endpoint later, it'd stamp 'instagram' from its own path.
          identityChannel: "whatsapp",
          phoneNumber: phone,
          name,
          firstName: trimmedFirst,
          lastName: trimmedLast,
          language,
          countryCode,
          email: email ?? undefined,
          location: location ?? undefined,
          customFields,
          stageId,
          source: "manual",
          ...(validTagIds.length > 0
            ? { tags: { connect: validTagIds.map((id) => ({ id })) } }
            : {}),
        },
        include: EXTERNAL_CONTACT_INCLUDE,
      });
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        // A soft-deleted contact still holds this phone's unique slot. Revive
        // it (and its preserved conversation) instead of 409-ing on a row the
        // directory no longer shows — mirrors ContactsService.create.
        const revived = await this.reviveSoftDeletedByPhone(
          workspaceId,
          apiKeyId,
          phone,
          {
            name,
            firstName: trimmedFirst,
            lastName: trimmedLast,
            language,
            countryCode,
            email,
            location,
            customFields,
            stageId,
            tagIds: validTagIds,
          },
        );
        if (revived) return revived;
        throw new ConflictException({
          error: "duplicate_phone",
          detail: "a contact with this phone number already exists",
        });
      }
      throw err;
    }

    const tagIds = created.tags.map((t) => t.id);
    const contact: DomainContact = toContactWire(created, { tagIds });

    // Fire `contact.created` FIRST (audited as the first-class trigger for the
    // "On Contact created" outbound webhook), then `contact.updated` for any
    // subscribers that still listen to the legacy kind="created" discriminator.
    await this.bus.publish({
      type: "contact.created",
      workspaceId,
      contact,
      source: "api",
      createdByUserId: null,
      createdByApiKeyId: apiKeyId,
    });

    await this.bus.publish({
      type: "contact.updated",
      workspaceId,
      contact,
      previousStageId: null,
      fieldChanges: Object.entries(customFields).map(([key, next]) => ({
        key,
        previous: null,
        next,
      })),
      tagChanges: validTagIds.length > 0 ? { added: validTagIds, removed: [] } : undefined,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      kind: "created",
      workflowContact: workflowContactSnapshot(created),
      // contact.created above already fans out the `contact:updated` socket
      // frame; suppress the duplicate here so the client reducer runs once.
      // Workflow + audit + outbound-webhook subscribers don't read this flag,
      // so they still receive this event.
      suppressSocketFanout: true,
    });

    return toExternalContact(created, tagIds);
  }

  /**
   * Revive a soft-deleted contact occupying `phone`'s unique slot. Clears the
   * tombstone, overwrites directory fields + tag set with the re-add payload,
   * and republishes the same `contact.created` + `contact.updated` pair the
   * create path fires (a revived contact is a fresh directory appearance).
   * Returns `null` when there's no soft-deleted row, so the caller falls
   * through to a real 409 for a live duplicate. Conversation history is
   * preserved — mirror of ContactsService.reviveSoftDeletedByPhone.
   */
  private async reviveSoftDeletedByPhone(
    workspaceId: string,
    apiKeyId: string,
    phone: string,
    data: {
      name: string;
      firstName: string | null;
      lastName: string | null;
      language: string | null;
      countryCode: string | null;
      email: string | null;
      location: string | null;
      customFields: Record<string, string>;
      stageId: string | null;
      tagIds: string[];
    },
  ): Promise<ExternalContact | null> {
    const existing = await this.db.contact.findFirst({
      // whatsapp-scoped: the phone unique slot this revives is WhatsApp-only.
      where: { workspaceId, phoneNumber: phone, identityChannel: "whatsapp", deletedAt: { not: null } },
      select: { id: true },
    });
    if (!existing) return null;

    // CAS on deletedAt — byte-mirror of ContactsService.reviveSoftDeletedByPhone:
    // a concurrent revive (an inbound WhatsApp webhook on the same phone) may
    // have flipped this row live between the findFirst above and here. This
    // used to be a plain `update`, which CLOBBERED that winner's directory
    // fields + tag set with this API payload and published a second
    // created/updated pair for a contact the winner already announced.
    const revived = await this.db.contact.updateMany({
      where: { id: existing.id, deletedAt: { not: null } },
      data: {
        name: data.name,
        firstName: data.firstName,
        lastName: data.lastName,
        language: data.language,
        countryCode: data.countryCode,
        email: data.email ?? null,
        location: data.location ?? null,
        customFields: data.customFields,
        stageId: data.stageId,
        source: "manual",
        deletedAt: null,
        version: { increment: 1 },
      },
    });
    const won = revived.count > 0;
    if (won) {
      // Tag `set` is a relation write, so it can't ride the updateMany above;
      // applied only on a WON race for the same reason the scalars are CAS'd —
      // a lost race must not overwrite the winner's tag set.
      await this.db.contact.update({
        where: { id: existing.id },
        data: { tags: { set: data.tagIds.map((id) => ({ id })) } },
        select: { id: true },
      });
    }

    const updated = await this.db.contact.findFirst({
      where: { id: existing.id, workspaceId },
      include: EXTERNAL_CONTACT_INCLUDE,
    });
    if (!updated) return null;

    const tagIds = updated.tags.map((t) => t.id);
    const contact: DomainContact = toContactWire(updated, { tagIds });

    // Only announce the (re)creation when THIS call performed the revive — a
    // concurrent winner already published its own pair for the live row.
    if (won) {
      await this.bus.publish({
        type: "contact.created",
        workspaceId,
        contact,
        source: "api",
        createdByUserId: null,
        createdByApiKeyId: apiKeyId,
      });

      await this.bus.publish({
        type: "contact.updated",
        workspaceId,
        contact,
        previousStageId: null,
        fieldChanges: Object.entries(contact.customFields).map(([key, next]) => ({
          key,
          previous: null,
          next,
        })),
        tagChanges: tagIds.length > 0 ? { added: tagIds, removed: [] } : undefined,
        changedByUserId: null,
        changedByApiKeyId: apiKeyId,
        kind: "created",
        workflowContact: workflowContactSnapshot(updated),
        // contact.created above already fans out the `contact:updated` socket
        // frame; suppress the duplicate here (non-socket subscribers still fire).
        suppressSocketFanout: true,
      });
    }

    return toExternalContact(updated, tagIds);
  }

  /**
   * Update by id. Loads pre-image inside a transaction so the customFields
   * merge sees a consistent snapshot; publishes `contact.updated` with a
   * fieldChanges diff. Phone is immutable (controller rejects payloads
   * with `phoneNumber` ownProperty BEFORE this method is called).
   */
  async updateContact(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalUpdateContactInput,
    idempotencyKey?: string,
    includeContactPii = true,
  ): Promise<ExternalContact> {
    // Idempotency — a partner retry must not re-publish contact.updated /
    // lifecycle_changed and re-trigger workflows/webhooks. F2 in
    // docs/audit-guide.md.
    if (idempotencyKey) {
      const claim = await this.idem.claim<ExternalContact>(
        workspaceId,
        apiKeyId,
        idempotencyKey,
        this.idem.fingerprint("update_contact", { contactId, input }),
      );
      if (claim.kind === "replay") return this.applyContactPii(claim.result, includeContactPii);
    }
    try {
      const result = await this.updateContactInternal(workspaceId, apiKeyId, contactId, input);
      if (idempotencyKey) {
        await this.idem.complete(workspaceId, apiKeyId, idempotencyKey, result);
      }
      return this.applyContactPii(result, includeContactPii);
    } catch (err) {
      if (idempotencyKey) await this.idem.release(workspaceId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  private async updateContactInternal(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalUpdateContactInput,
  ): Promise<ExternalContact> {
    const {
      name,
      firstName,
      lastName,
      language,
      countryCode,
      email,
      location,
      customFields: customFieldsPatch,
      stageId,
    } = input;

    if (typeof stageId === "string") {
      const ok = await this.db.contactStage.findFirst({
        where: { id: stageId, workspaceId },
        select: { id: true },
      });
      if (!ok) throw new BadRequestException({ error: "stage_not_found", detail: "stage not found" });
    }

    let result;
    try {
      result = await this.db.$transaction(async (tx) => {
        const existing = await tx.contact.findFirst({
          // deletedAt:null — a partner holding a tombstoned id (cached / from a
          // prior export) must not be able to edit a soft-deleted contact via
          // /v1. Mirrors the contacts.service M5 mutation guards.
          where: { id: contactId, workspaceId, deletedAt: null },
          include: EXTERNAL_CONTACT_INCLUDE,
        });
        if (!existing) return null;

        const nextCustom = customFieldsPatch
          ? mergeCustomFields(
              (existing.customFields as Record<string, unknown> | null) ?? {},
              customFieldsPatch,
            )
          : undefined;

        // When firstName or lastName changes (and `name` wasn't explicitly set
        // in the same patch), recompute `name` so the canonical display stays
        // in lockstep. Editing only `name` directly does NOT auto-resplit
        // first/last — agents may have a manual override.
        let derivedName: string | undefined;
        if (name === undefined && (firstName !== undefined || lastName !== undefined)) {
          const nextFirst = firstName !== undefined ? firstName ?? "" : existing.firstName ?? "";
          const nextLast = lastName !== undefined ? lastName ?? "" : existing.lastName ?? "";
          const combined = `${nextFirst}${nextFirst && nextLast ? " " : ""}${nextLast}`.trim();
          if (combined.length > 0) derivedName = combined.slice(0, MAX_TEXT);
        }

        // CAS on `version` — concurrent /v1 + UI + workflow writes race
        // to bump, exactly one wins. The loser surfaces as 409 so the
        // partner integration can retry against the fresh server state.
        const updated = await tx.contact.update({
          where: { id: contactId, workspaceId, version: existing.version },
          data: {
            ...(name !== undefined ? { name } : derivedName !== undefined ? { name: derivedName } : {}),
            ...(firstName !== undefined ? { firstName } : {}),
            ...(lastName !== undefined ? { lastName } : {}),
            ...(language !== undefined ? { language } : {}),
            ...(countryCode !== undefined ? { countryCode } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(location !== undefined ? { location } : {}),
            ...(stageId !== undefined ? { stageId } : {}),
            ...(nextCustom !== undefined ? { customFields: nextCustom } : {}),
            version: { increment: 1 },
          },
          include: EXTERNAL_CONTACT_INCLUDE,
        });
        return { existing, updated };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new ConflictException({
          error: "write_conflict",
          detail: "contact was modified by another writer, retry",
        });
      }
      throw err;
    }

    if (!result) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });
    const { existing, updated } = result;

    const tagIds = updated.tags.map((t) => t.id);
    const oldCustom = normalizeStringMap(existing.customFields);
    const newCustom = normalizeStringMap(updated.customFields);
    const fieldChanges: ContactFieldChange[] = [];
    const allKeys = new Set([...Object.keys(oldCustom), ...Object.keys(newCustom)]);
    for (const key of allKeys) {
      const prev = oldCustom[key] ?? null;
      const next = newCustom[key] ?? null;
      if (prev !== next) fieldChanges.push({ key, previous: prev, next });
    }
    // Built-in column diffs too — the internal UI path includes these, so the
    // /v1 path must match or the same mutation emits a different event payload
    // by entry point. (The workflow-dispatch guard already excludes built-in
    // keys, so this adds payload fidelity without a workflow re-trigger risk.)
    for (const key of ["name", "firstName", "lastName", "email", "language", "countryCode", "location"] as const) {
      const prev = (existing[key] as string | null) ?? null;
      const next = (updated[key] as string | null) ?? null;
      if (prev !== next) fieldChanges.push({ key, previous: prev, next });
    }

    const contact: DomainContact = toContactWire(updated, { tagIds });

    // No-op guard: a CRM re-sync that PATCHes the same values it already holds
    // changed nothing (no field diffs, same stage). Publishing contact.updated
    // anyway fans a signed delivery to every outbound webhook per idle re-sync —
    // a storm with zero information. Skip the fanout entirely on a true no-op.
    // (The version was bumped by the CAS above; that's a cheap idempotent write,
    // and the realistic storm is the webhook fanout, which this suppresses.)
    if (fieldChanges.length === 0 && existing.stageId === updated.stageId) {
      return toExternalContact(updated, tagIds);
    }

    // `silent: true` → skip reactions on every event this update fans out, so
    // a partner that edits a contact via /v1 doesn't re-trigger a workflow
    // (contact_field_updated / lifecycle) or echo a webhook back to itself.
    const silent = input.silent === true;

    // Always publish `contact.updated` for the catch-all subscribers.
    await this.bus.publish({
      type: "contact.updated",
      workspaceId,
      contact,
      previousStageId: existing.stageId,
      fieldChanges,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      kind: "updated",
      workflowContact: workflowContactSnapshot(updated),
      silent,
    });

    // Narrow events for n8n triggers — only fire when the relevant field
    // actually changed, so a name edit doesn't trigger a stage-change webhook.
    if (existing.stageId !== updated.stageId) {
      await this.bus.publish({
        type: "contact.lifecycle_changed",
        workspaceId,
        contactId: updated.id,
        before: { stageId: existing.stageId },
        after: { stageId: updated.stageId },
        changedByUserId: null,
        changedByApiKeyId: apiKeyId,
        silent,
      });
    }

    return toExternalContact(updated, tagIds);
  }

  /**
   * Create-or-update by phone — atomic find-then-create-or-update. Returns
   * `created: true` for new rows, `created: false` for updates.
   *
   * Optionally idempotent: a retry with the same Idempotency-Key replays the
   * prior `{ contact, created }` without re-firing contact.created (the one
   * double-fire risk, on a soft-deleted-then-revived row). Completes the F2
   * coverage — every /v1 mutation now honors the header.
   */
  async upsertContact(
    workspaceId: string,
    apiKeyId: string,
    input: ExternalUpsertContactInput,
    idempotencyKey?: string,
    includeContactPii = true,
  ): Promise<{ contact: ExternalContact; created: boolean }> {
    const result = await this.withIdempotency(
      workspaceId,
      apiKeyId,
      idempotencyKey,
      "upsert_contact",
      { input },
      () => this.upsertContactInternal(workspaceId, apiKeyId, input),
    );
    return { contact: this.applyContactPii(result.contact, includeContactPii), created: result.created };
  }

  private async upsertContactInternal(
    workspaceId: string,
    apiKeyId: string,
    input: ExternalUpsertContactInput,
  ): Promise<{ contact: ExternalContact; created: boolean }> {
    const phone = normalizePhoneE164(input.phoneNumber);
    if (!phone) {
      throw new BadRequestException({
        error: "invalid_phone",
        detail:
          "phoneNumber must be a valid international number (e.g. +1 555 555 0100)",
      });
    }
    const existing = await this.db.contact.findFirst({
      // Scope to whatsapp — the create path below stamps identityChannel:
      // 'whatsapp', so the whole /v1 phone-keyed contact CRUD surface is
      // WhatsApp-semantic. Without this a re-sync could patch/revive a
      // social/widget contact that merely borrowed the phone.
      where: { workspaceId, phoneNumber: phone, identityChannel: "whatsapp" },
      select: { id: true, deletedAt: true },
    });
    // Not found OR soft-deleted → go through createContact. For a tombstoned
    // row create() hits P2002 and reviveSoftDeletedByPhone restores it (firing
    // contact.created), so re-upserting a removed contact behaves like a fresh
    // add rather than silently patching a hidden row.
    let targetId = existing && !existing.deletedAt ? existing.id : null;
    if (!targetId) {
      try {
        const contact = await this.createContact(workspaceId, apiKeyId, input);
        return { contact, created: true };
      } catch (err) {
        // API-6: two concurrent FIRST-time upserts of the same phone — the
        // loser's createContact P2002s, finds no soft-deleted row to revive,
        // and throws `duplicate_phone` (409). Upsert must be idempotent under
        // races: re-find the live winner and fall through to the update/merge
        // path instead of surfacing the 409 to the partner.
        if (err instanceof ConflictException) {
          const winner = await this.db.contact.findFirst({
            where: { workspaceId, phoneNumber: phone, identityChannel: "whatsapp", deletedAt: null },
            select: { id: true },
          });
          if (!winner) throw err;
          targetId = winner.id;
        } else {
          throw err;
        }
      }
    }
    // Call the internal (un-wrapped) update — upsert's own idempotency is the
    // caller's concern at the /v1/contacts/upsert route, not a nested claim.
    // Forward EVERY directory field the update path supports (firstName /
    // lastName / language / countryCode included — they were silently dropped
    // before, so a CRM re-sync never refreshed them after the first create).
    const contact = await this.updateContactInternal(workspaceId, apiKeyId, targetId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
    });
    // tagIds is create-only on the upsert path: on the update branch we apply
    // it additively (matching the single-contact "add tags" semantics) so a
    // re-sync that carries tags keeps assigning them instead of dropping them
    // silently. We do NOT remove tags the payload omits — upsert is a merge,
    // not a full replace; use DELETE /contacts/:id/tags/:tagId to unassign.
    if (input.tagIds && input.tagIds.length > 0) {
      return {
        contact: await this.addContactTagsInternal(workspaceId, apiKeyId, targetId, {
          tagIds: input.tagIds,
        }),
        created: false,
      };
    }
    return { contact, created: false };
  }

  /**
   * Soft-delete: tombstone the contact but PRESERVE its conversations,
   * messages, and media — removing a contact must NOT delete its chat. The
   * contact just leaves the directory; its thread stays in the inbox, and a
   * returning contact is revived (ingest upsert / create-by-phone). Mirrors
   * ContactsService.remove. A hard GDPR purge is a separate, explicit path.
   */
  async deleteContact(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
  ): Promise<void> {
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });

    await this.db.contact.update({
      where: { id: contactId },
      data: { deletedAt: new Date() },
    });

    await this.bus.publish({
      type: "contact.deleted",
      workspaceId,
      contactId,
      // Conversations are preserved on soft-delete — none to splice from lists.
      conversationIds: [],
      deletedByUserId: null,
      deletedByApiKeyId: apiKeyId,
    });
  }

  // ===========================================================================
  // CONTACTS — channels (synthetic for parity)
  // ===========================================================================

  /**
   * Surface a contact's channel list. We model one channel per Contact row
   * (siloed per channel by design) so this returns a single-element array.
   * Future multi-channel rollout extends the shape here, not at the call site.
   */
  async getContactChannels(workspaceId: string, contactId: string) {
    const c = await this.db.contact.findFirst({
      // deletedAt:null — consistent with getContact + every list/mutation path.
      where: { id: contactId, workspaceId, deletedAt: null },
      select: { id: true, phoneNumber: true, identityChannel: true, externalContactId: true },
    });
    if (!c) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });
    // A social/widget contact has no phoneNumber but IS on a channel — its
    // identityChannel + externalContactId prove it. Returning [] for every
    // Messenger/Instagram/webchatwidget contact wrongly reported them as having
    // no channel; only a row with NEITHER identity (which shouldn't exist) is [].
    if (!c.phoneNumber && !c.externalContactId) return { items: [] };
    return {
      items: [
        {
          // Read-only DESCRIPTION of this contact's own (siloed, immutable)
          // channel — NOT a send-routing decision. Send paths route by
          // `Conversation.channel`; never derive a channel from the contact.
          channel: c.identityChannel,
          phoneNumber: c.phoneNumber,
          externalContactId: c.externalContactId,
        },
      ],
    };
  }

  // ===========================================================================
  // CONTACTS — tag ops (single-contact + bulk)
  // ===========================================================================

  async addContactTags(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAddTagsInput,
    idempotencyKey?: string,
    includeContactPii = true,
  ): Promise<ExternalContact> {
    const contact = await this.withIdempotency(
      workspaceId,
      apiKeyId,
      idempotencyKey,
      "add_contact_tags",
      { contactId, tagIds: input.tagIds },
      () => this.addContactTagsInternal(workspaceId, apiKeyId, contactId, input),
    );
    return this.applyContactPii(contact, includeContactPii);
  }

  private async addContactTagsInternal(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAddTagsInput,
  ): Promise<ExternalContact> {
    const contact = await this.db.contact.findFirst({
      // deletedAt:null — don't tag a tombstoned contact (would write join rows +
      // fan out workflow/webhook events for a contact hidden everywhere else).
      where: { id: contactId, workspaceId, deletedAt: null },
      include: EXTERNAL_CONTACT_INCLUDE,
    });
    if (!contact) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });

    const tags = await this.db.tag.findMany({
      where: { workspaceId, id: { in: input.tagIds } },
      select: { id: true },
    });
    const validIds = tags.map((t) => t.id);
    const existingIds = new Set(contact.tags.map((t) => t.id));
    const newIds = validIds.filter((id) => !existingIds.has(id));

    if (newIds.length === 0) {
      return toExternalContact(contact, [...existingIds]);
    }

    let updated;
    try {
      updated = await this.db.contact.update({
        where: { id: contactId, workspaceId, version: contact.version },
        data: {
          tags: { connect: newIds.map((id) => ({ id })) },
          version: { increment: 1 },
        },
        include: EXTERNAL_CONTACT_INCLUDE,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new ConflictException({
          error: "write_conflict",
          detail: "contact was modified by another writer, retry",
        });
      }
      throw err;
    }

    const tagIds = updated.tags.map((t) => t.id);
    await this.publishContactTagChange(
      workspaceId,
      apiKeyId,
      updated,
      contact.stageId,
      contact.tags.map((t) => t.id),
      { added: newIds, removed: [] },
      input.silent === true,
    );
    return toExternalContact(updated, tagIds);
  }

  /**
   * Bulk-remove tags from a SINGLE contact in one call. Mirrors the
   * multi-add ergonomics on `POST /v1/contacts/:id/tags` so an n8n flow
   * removing N tags doesn't have to loop. Fires ONE `contact.tag_changed`
   * event carrying all `removed` ids.
   */
  async removeContactTags(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    tagIds: string[],
    silent = false,
    idempotencyKey?: string,
    includeContactPii = true,
  ): Promise<ExternalContact> {
    const contact = await this.withIdempotency(
      workspaceId,
      apiKeyId,
      idempotencyKey,
      "remove_contact_tags",
      { contactId, tagIds },
      () => this.removeContactTagsInternal(workspaceId, apiKeyId, contactId, tagIds, silent),
    );
    return this.applyContactPii(contact, includeContactPii);
  }

  private async removeContactTagsInternal(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    tagIds: string[],
    silent = false,
  ): Promise<ExternalContact> {
    const contact = await this.db.contact.findFirst({
      // deletedAt:null — consistent with the other /v1 contact mutators.
      where: { id: contactId, workspaceId, deletedAt: null },
      include: EXTERNAL_CONTACT_INCLUDE,
    });
    if (!contact) throw new NotFoundException({ error: "contact_not_found", detail: "contact not found" });

    const existingIds = new Set(contact.tags.map((t) => t.id));
    const toRemove = tagIds.filter((id) => existingIds.has(id));
    if (toRemove.length === 0) {
      return toExternalContact(contact, [...existingIds]);
    }

    let updated;
    try {
      updated = await this.db.contact.update({
        where: { id: contactId, workspaceId, version: contact.version },
        data: {
          tags: { disconnect: toRemove.map((id) => ({ id })) },
          version: { increment: 1 },
        },
        include: EXTERNAL_CONTACT_INCLUDE,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new ConflictException({
          error: "write_conflict",
          detail: "contact was modified by another writer, retry",
        });
      }
      throw err;
    }
    const newTagIds = updated.tags.map((t) => t.id);
    await this.publishContactTagChange(
      workspaceId,
      apiKeyId,
      updated,
      contact.stageId,
      contact.tags.map((t) => t.id),
      { added: [], removed: toRemove },
      silent,
    );
    return toExternalContact(updated, newTagIds);
  }

  async removeContactTag(
    workspaceId: string,
    apiKeyId: string,
    contactId: string,
    tagId: string,
    idempotencyKey?: string,
    includeContactPii = true,
  ): Promise<ExternalContact> {
    // Delegate to the plural-tag path with a one-element array. The two
    // earlier internals (singular + plural) were almost-identical copies
    // and had drifted (singular had no `silent` param, so the public
    // DELETE /v1/contacts/:id/tags/:tagId always fanouts while the bulk
    // DELETE could be silenced). Collapsing closes the asymmetry.
    const contact = await this.withIdempotency(
      workspaceId,
      apiKeyId,
      idempotencyKey,
      "remove_contact_tag",
      { contactId, tagId },
      () =>
        this.removeContactTagsInternal(workspaceId, apiKeyId, contactId, [tagId], false),
    );
    return this.applyContactPii(contact, includeContactPii);
  }

  /**
   * Bulk add or remove tags across many contacts. We loop tag-by-tag so the
   * per-contact event payloads stay coherent (one `tagChanges` per tag id),
   * and emit ONE coalesced `contact.bulk_updated` at the end so the socket
   * layer fans out a single frame regardless of how many contacts × tags.
   */
  async bulkContactTags(
    workspaceId: string,
    apiKeyId: string,
    action: "tag-add" | "tag-remove",
    input: ExternalBulkTagInput,
    idempotencyKey?: string,
    chainDepth?: number,
  ): Promise<{ count: number; tagIds: string[]; contactIds: string[] }> {
    // Loop guard: a partner whose own `contact.tag_changed` webhook
    // receiver POSTs back here would otherwise tag-thrash until /v1's
    // 20/min rate limit catches up. Cap at the same MAX_CHAIN_DEPTH the
    // send routes use.
    if (chainDepth !== undefined && chainDepth >= MAX_CHAIN_DEPTH) {
      throw new HttpException(
        {
          error: "chain_depth_exceeded",
          detail:
            `inbound X-CCP-Depth ${chainDepth} >= ${MAX_CHAIN_DEPTH} — request dropped to ` +
            "break a likely cross-system loop.",
        },
        429,
      );
    }
    return this.withIdempotency(
      workspaceId,
      apiKeyId,
      idempotencyKey,
      action === "tag-add" ? "bulk_contact_tags_add" : "bulk_contact_tags_remove",
      { action, contactIds: input.contactIds, tagIds: input.tagIds },
      () => this.bulkContactTagsInternal(workspaceId, apiKeyId, action, input),
    );
  }

  /**
   * Queue a contact import for an API-key caller.
   *
   * Idempotency is MANDATORY at the controller. An import is a bulk, billed-in-
   * effort, non-reversible mutation of the contact book: a partner retrying
   * after a 5xx must replay the SAME job id, not queue a second run over the
   * same 100k rows.
   *
   * `canManageTags: true` — an API key with `write:contacts` can already create
   * contacts and tag them through the existing endpoints, so gating tag
   * auto-creation here would only make imports behave differently from the rest
   * of the surface for no security gain (the UI gate exists because a human
   * agent's role may withhold `tags:manage`; a key has no role).
   */
  async startContactImport(
    workspaceId: string,
    apiKeyId: string,
    input: ExternalStartImportInput,
    idempotencyKey?: string,
  ): Promise<{ jobId: string }> {
    return this.withIdempotency(
      workspaceId,
      apiKeyId,
      idempotencyKey,
      "start_contact_import",
      { uploadKey: input.uploadKey, mode: input.mode },
      () =>
        this.transfers.startImport({
          workspaceId,
          userId: null,
          uploadKey: input.uploadKey,
          filename: input.filename,
          format: input.format,
          options: {
            mode: input.mode,
            tagMode: input.tagMode,
            fireAutomations: input.fireAutomations,
            mapping: input.mapping,
          },
          canManageTags: true,
        }),
    );
  }

  private async bulkContactTagsInternal(
    workspaceId: string,
    apiKeyId: string,
    action: "tag-add" | "tag-remove",
    input: ExternalBulkTagInput,
  ): Promise<{ count: number; tagIds: string[]; contactIds: string[] }> {
    const ownContacts = await this.db.contact.findMany({
      // deletedAt:null — this ownedIds set is the load-bearing pre-filter fed
      // into the tag-join raw SQL below, so filtering here keeps tombstoned
      // contacts out of the join + the per-contact fanout (the DELETE join keys
      // off _ContactToTag.A only and can't reference Contact.deletedAt, so this
      // pre-filter is the gate). Mirrors the contacts.service bulk M5 guard.
      where: { workspaceId, deletedAt: null, id: { in: input.contactIds } },
      select: { id: true },
    });
    const ownedIds = ownContacts.map((c) => c.id);
    if (ownedIds.length === 0) {
      throw new NotFoundException({ error: "no_matching_contacts", detail: "no matching contacts in this team" });
    }

    const validTags = await this.db.tag.findMany({
      where: { workspaceId, id: { in: input.tagIds } },
      select: { id: true },
    });
    const validTagIds = validTags.map((t) => t.id);
    if (validTagIds.length === 0) {
      throw new NotFoundException({ error: "no_matching_tags", detail: "no matching tags in this team" });
    }

    // Pre-read existing (contactId, tagId) membership for the affected pairs so
    // the per-contact fanout below publishes a tag-change ONLY for contacts
    // whose membership actually shifts — matching the single-contact path's
    // no-op short-circuit. Without this we recompute `added`/`removed` from the
    // POST-state, which falsely reports "added" for a contact that already had
    // the tag (tag-add) and "removed" for one that never had it (tag-remove),
    // firing spurious workflow + webhook triggers on idempotent re-runs.
    const priorPairs = await this.db.$queryRaw<{ A: string; B: string }[]>`
      SELECT "A", "B" FROM "_ContactToTag"
      WHERE "A" = ANY(${ownedIds}::text[]) AND "B" = ANY(${validTagIds}::text[])
    `;
    const priorByContact = new Map<string, Set<string>>();
    for (const { A, B } of priorPairs) {
      const set = priorByContact.get(A) ?? new Set<string>();
      set.add(B);
      priorByContact.set(A, set);
    }

    for (const tagId of validTagIds) {
      if (action === "tag-add") {
        await this.db.$executeRaw`
          INSERT INTO "_ContactToTag" ("A", "B")
          SELECT id, ${tagId} FROM "Contact"
          WHERE id = ANY(${ownedIds}::text[]) AND "workspaceId" = ${workspaceId}
          ON CONFLICT DO NOTHING
        `;
      } else {
        // SEC-4: in-SQL workspaceId backstop mirroring the tag-add path's
        // `Contact.workspaceId = ${workspaceId}` guard. `ownedIds`/`validTagIds` are
        // already team-pre-filtered, so this is defense-in-depth — but it means
        // the destructive DELETE can never touch a cross-team join row even if a
        // future caller forgets the pre-filter.
        await this.db.$executeRaw`
          DELETE FROM "_ContactToTag"
          WHERE "A" = ANY(${ownedIds}::text[]) AND "B" = ${tagId}
            AND "A" IN (SELECT id FROM "Contact" WHERE "workspaceId" = ${workspaceId})
            AND "B" IN (SELECT id FROM "Tag" WHERE "workspaceId" = ${workspaceId})
        `;
      }
    }
    // Bump version on every affected Contact so any in-flight per-contact
    // PATCH (especially setTags using `tags: { set: ... }`) CAS-fails
    // instead of silently overwriting the bulk's tag set. The join-table
    // writes above don't touch Contact.version on their own.
    await this.db.$executeRaw`
      UPDATE "Contact"
      SET version = version + 1
      WHERE id = ANY(${ownedIds}::text[]) AND "workspaceId" = ${workspaceId}
    `;

    // Per-contact `contact.updated` events for workflow + audit dispatch —
    // `suppressSocketFanout: true` so the coalesced frame below is the
    // only socket fanout the clients see. Additionally, a narrow
    // `contact.tag_changed` per contact (NOT suppressed at the socket layer,
    // but the outbound-webhooks subscriber doesn't read that flag) so the
    // n8n "On Contact Tag updated" trigger fires per affected contact.
    const updated = await this.db.contact.findMany({
      where: { workspaceId, id: { in: ownedIds } },
      include: EXTERNAL_CONTACT_INCLUDE,
    });
    // Bounded 16-lane fanout — see contacts.service.ts for rationale. An
    // unbounded Promise.all over 500 ids × 6 sequential subscribers pinned
    // the event loop for hundreds of ms on the single VPS.
    await runWithConcurrency(updated, 16, async (c) => {
      const tagIds = c.tags.map((t) => t.id);
      const payload: DomainContact = toContactWire(c, { tagIds });
      // Real delta vs. the PRE-state membership pre-read above: a tag is only
      // "added" if this contact didn't already have it, and only "removed" if
      // it actually did. Recomputing from the post-state (the prior bug) marked
      // every targeted tag as changed even for no-op contacts.
      const prior = priorByContact.get(c.id) ?? new Set<string>();
      const added =
        action === "tag-add" ? validTagIds.filter((t) => !prior.has(t)) : [];
      const removed =
        action === "tag-remove" ? validTagIds.filter((t) => prior.has(t)) : [];
      const changed = added.length > 0 || removed.length > 0;
      const tagChanges = changed ? { added, removed } : undefined;

      await this.bus.publish({
        type: "contact.updated",
        workspaceId,
        contact: payload,
        previousStageId: c.stageId,
        fieldChanges: [],
        tagChanges,
        changedByUserId: null,
        changedByApiKeyId: apiKeyId,
        workflowContact: workflowContactSnapshot(c),
        suppressSocketFanout: true,
        // Honor caller's `silent` for outbound-webhooks + workflow re-trigger,
        // while leaving suppressSocketFanout on (the coalesced bulk frame is
        // the only socket fanout clients see for this path).
        silent: input.silent === true,
      });

      if (changed) {
        await this.bus.publish({
          type: "contact.tag_changed",
          workspaceId,
          contactId: c.id,
          // `before` is reconstructed from the post-state ± this contact's real
          // delta: for the add path it's the current set minus what we added;
          // for remove it's the current set plus what we removed.
          before: {
            tagIds:
              action === "tag-add"
                ? tagIds.filter((id) => !added.includes(id))
                : [...tagIds, ...removed],
          },
          after: { tagIds },
          added,
          removed,
          changedByUserId: null,
          changedByApiKeyId: apiKeyId,
          silent: input.silent === true,
        });
      }
    });

    await this.bus.publish({
      type: "contact.bulk_updated",
      workspaceId,
      contactIds: ownedIds,
      changeKind: "tags",
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
    });

    return { count: ownedIds.length, tagIds: validTagIds, contactIds: ownedIds };
  }

  // ===========================================================================
  // CONTACT FIELDS catalog
  // ===========================================================================

  async listContactFields(workspaceId: string) {
    const rows = await this.db.contactFieldDefinition.findMany({
      where: { workspaceId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    return {
      items: rows.map((r) => ({ id: r.id, key: r.key, label: r.label, order: r.order })),
    };
  }

  /**
   * Find a custom field by id OR by key. respond.io's "Find a Custom Field"
   * node accepts either; we mirror that here.
   */
  async findContactField(workspaceId: string, idOrKey: string) {
    const row = await this.db.contactFieldDefinition.findFirst({
      where: { workspaceId, OR: [{ id: idOrKey }, { key: idOrKey }] },
    });
    if (!row) throw new NotFoundException({ error: "contact_field_not_found", detail: "contact field not found" });
    return { id: row.id, key: row.key, label: row.label, order: row.order };
  }

  async createContactField(workspaceId: string, input: ExternalCreateContactFieldInput) {
    const existing = await this.db.contactFieldDefinition.findMany({
      where: { workspaceId },
      select: { key: true, order: true },
      orderBy: { order: "desc" },
    });
    if (existing.length >= 50) {
      throw new BadRequestException({ error: "too_many_contact_fields", detail: "at most 50 contact fields per team" });
    }
    // Same guard the internal contact-fields route applies. Without it /v1 can
    // mint a field whose label shadows a built-in column ("Language", "City"),
    // which renders two fields with the same name in the contact panel writing
    // to different storage — and makes the field un-round-trippable through
    // import/export except via the `custom:<key>` header form.
    if (isReservedFieldKey(input.label)) {
      throw new BadRequestException({
        error: "reserved_field_label",
        detail: `"${input.label}" collides with a built-in contact field. Pick a different label.`,
      });
    }
    const baseKey = slugifyKey(input.label);
    if (!baseKey) {
      throw new BadRequestException({ error: "invalid_field_label", detail: "label must contain letters or digits" });
    }
    const usedKeys = new Set(existing.map((e) => e.key));
    let key = baseKey;
    let suffix = 2;
    while (usedKeys.has(key)) key = `${baseKey}_${suffix++}`;
    const nextOrder = (existing[0]?.order ?? -1) + 1;

    try {
      const created = await this.db.contactFieldDefinition.create({
        data: { workspaceId, key, label: input.label, order: nextOrder },
      });
      await this.bus.publish({
        type: "team.catalog_changed",
        workspaceId,
        scope: "contact-fields",
      });
      return { id: created.id, key: created.key, label: created.label, order: created.order };
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        throw new ConflictException({ error: "field_key_taken", detail: "field with that key already exists" });
      }
      throw err;
    }
  }

  // ===========================================================================
  // TAGS catalog
  // ===========================================================================

  async listTags(workspaceId: string): Promise<{ items: Tag[] }> {
    const rows = await this.db.tag.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        name: r.name,
        color: normalizeColor(r.color),
      })),
    };
  }

  async createTag(workspaceId: string, input: ExternalCreateTagInput): Promise<Tag> {
    const color = normalizeColor(input.color);
    try {
      const created = await this.db.tag.create({
        data: { workspaceId, name: input.name, color },
      });
      await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "tags" });
      return {
        id: created.id,
        workspaceId: created.workspaceId,
        name: created.name,
        color: normalizeColor(created.color),
      };
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        throw new ConflictException({
          error: "tag_name_taken",
          detail: `A tag named "${input.name}" already exists.`,
        });
      }
      throw err;
    }
  }

  async updateTag(workspaceId: string, id: string, input: ExternalUpdateTagInput): Promise<Tag> {
    const existing = await this.db.tag.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException({ error: "tag_not_found", detail: "tag not found" });
    try {
      const updated = await this.db.tag.update({ where: { id }, data: input });
      await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "tags" });
      return {
        id: updated.id,
        workspaceId: updated.workspaceId,
        name: updated.name,
        color: normalizeColor(updated.color),
      };
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        throw new ConflictException({ error: "tag_name_taken", detail: "a tag with that name already exists" });
      }
      throw err;
    }
  }

  async deleteTag(workspaceId: string, id: string): Promise<void> {
    const existing = await this.db.tag.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException({ error: "tag_not_found", detail: "tag not found" });
    await this.db.tag.delete({ where: { id } });
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "tags" });
  }

  // ===========================================================================
  // STAGES catalog (read-only via /v1)
  // ===========================================================================

  async listStages(workspaceId: string): Promise<{ items: ContactStage[] }> {
    const rows = await this.db.contactStage.findMany({
      where: { workspaceId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        name: r.name,
        color: r.color as TagColor,
        position: r.position,
        isDefault: r.isDefault,
      })),
    };
  }

  /**
   * The WhatsApp template catalog, for integrations that send templates or
   * watch template health.
   *
   * Read-only on purpose: creating a template is a Meta REVIEW submission with
   * a component grammar the composer's shared validator enforces, and an API
   * that accepted a half-valid one would just produce rejections nobody sees.
   * Everything needed to SEND is here — the id `/v1` sends and analyses by, the
   * parameter format, and the components.
   */
  async listTemplates(
    workspaceId: string,
    filters: { status?: string; category?: string } = {},
  ) {
    const rows = await this.db.messageTemplate.findMany({
      where: {
        workspaceId,
        // The Zod enums are exactly the Prisma enum members, so the cast is a
        // shape assertion, not a widening — an unknown value can't reach here.
        ...(filters.status
          ? { status: filters.status as Prisma.MessageTemplateWhereInput["status"] }
          : {}),
        ...(filters.category
          ? { category: filters.category as Prisma.MessageTemplateWhereInput["category"] }
          : {}),
      },
      orderBy: [{ name: "asc" }, { language: "asc" }],
      select: {
        id: true,
        externalId: true,
        wabaId: true,
        name: true,
        language: true,
        category: true,
        correctCategory: true,
        status: true,
        statusReason: true,
        parameterFormat: true,
        messageSendTtlSeconds: true,
        bodyText: true,
        components: true,
        qualityScore: true,
        qualityScoreAt: true,
        archivedAt: true,
        lastUsedAt: true,
        syncedAt: true,
      },
    });
    return { items: rows.map(externalTemplate) };
  }

  // ===========================================================================
  // USERS
  // ===========================================================================

  async listUsers(workspaceId: string): Promise<{ items: User[] }> {
    const rows = await this.db.user.findMany({
      where: { workspaceMemberships: { some: { workspaceId } } },
      orderBy: { name: "asc" },
      include: { workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 } },
    });
    return {
      items: await Promise.all(
        rows.map(async (u) => {
          // Presign the R2 avatar for external fetchers — `u.avatarUrl` is the
          // internal session-gated path, unusable by an API-key partner.
          const avatarUrl = await toExternalAvatarUrl(u.id, !!u.avatarUrl);
          return {
            id: u.id,
            workspaceId,
            role: u.workspaceMemberships[0]?.role ?? "agent",
            name: u.name,
            email: u.email,
            ...(avatarUrl ? { avatarUrl } : {}),
            isActive: u.deactivatedAt === null,
            ...availabilityFields(u),
          };
        }),
      ),
    };
  }

  async findUser(workspaceId: string, idOrEmail: string): Promise<{ user: User }> {
    const row = await this.db.user.findFirst({
      where: { workspaceMemberships: { some: { workspaceId } }, OR: [{ id: idOrEmail }, { email: idOrEmail }] },
      include: { workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 } },
    });
    if (!row) throw new NotFoundException({ error: "user_not_found", detail: "user not found" });
    const avatarUrl = await toExternalAvatarUrl(row.id, !!row.avatarUrl);
    return {
      user: {
        id: row.id,
        workspaceId,
        role: row.workspaceMemberships[0]?.role ?? "agent",
        name: row.name,
        email: row.email,
        ...(avatarUrl ? { avatarUrl } : {}),
        isActive: row.deactivatedAt === null,
        ...availabilityFields(row),
      },
    };
  }

  /**
   * Set a teammate's availability, or hand them back to their schedule
   * (`followSchedule: true`). Same service — and therefore the same single
   * writer, the same override expiry, and the same `user.availability_changed`
   * event — as the internal admin route, so a workforce-management integration
   * and the settings UI can never diverge.
   *
   * Acts with superAdmin authority (an API key isn't a member, so there's no
   * role hierarchy to compare against); `write:users` is the gate.
   */
  async setUserAvailability(
    workspaceId: string,
    userId: string,
    input: SetUserAvailabilityInput,
  ) {
    const user = await this.users.setUserAvailability(
      workspaceId,
      // No member identity behind an API key — null keeps the write attributed
      // as "admin" without falsely crediting it to the target themselves.
      null,
      { role: "admin", isSuperAdmin: true },
      userId,
      input,
    );
    return { user };
  }

  async setUserWorkHours(workspaceId: string, userId: string, input: SetUserWorkHoursInput) {
    const user = await this.users.setUserWorkHours(workspaceId, { role: "admin", isSuperAdmin: true }, userId, input);
    return { user };
  }

  // ===========================================================================
  // CHANNELS — synthetic single-row response for parity
  // ===========================================================================

  async listChannels(workspaceId: string) {
    // One active connection per provider today; lists all the team's channels.
    const conns = await this.db.channelConnection.findMany({
      where: { workspaceId, isActive: true },
      select: { channel: true, config: true },
    });
    const items = conns
      .map((c) => {
        const cfg = (c.config ?? {}) as {
          phoneNumberId?: string;
          displayPhoneNumber?: string;
          pageId?: string;
          pageName?: string;
          igUserId?: string;
          igUsername?: string;
          siteKey?: string;
          widgetName?: string;
        };
        // Every LIVE channel is a real connection the UI shows — not just
        // WhatsApp. Derive a stable per-channel id + display from whatever
        // identity that channel carries, instead of dropping every non-WA row
        // (which made teams on messenger/instagram/webchatwidget see an empty
        // or WhatsApp-only channel list through the API).
        const id =
          cfg.phoneNumberId ?? cfg.pageId ?? cfg.igUserId ?? cfg.siteKey ?? null;
        if (!id) return null;
        const display =
          cfg.displayPhoneNumber ??
          (cfg.igUsername ? `@${cfg.igUsername}` : undefined) ??
          cfg.pageName ??
          cfg.widgetName ??
          id;
        return { id, channel: c.channel, display };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { items };
  }

  // Conversation/message/note/send methods now live on
  // ExternalV1MessagingService — see the delegation block at the top of
  // the class. Method bodies removed during the split to keep this file
  // focused on contacts + catalog reads + shared helpers.


  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async publishContactTagChange(
    workspaceId: string,
    apiKeyId: string,
    updated: Prisma.ContactGetPayload<{ include: { tags: { select: { id: true } } } }>,
    previousStageId: string | null,
    previousTagIds: string[],
    tagChanges: { added: string[]; removed: string[] },
    /** `silent: true` on the request → skip workflow re-trigger + webhook echo. */
    silent = false,
  ) {
    const tagIds = updated.tags.map((t) => t.id);
    const payload: DomainContact = toContactWire(updated, { tagIds });
    // Existing catch-all for legacy subscribers.
    await this.bus.publish({
      type: "contact.updated",
      workspaceId,
      contact: payload,
      previousStageId,
      fieldChanges: [],
      tagChanges,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      workflowContact: workflowContactSnapshot(updated),
      silent,
    });
    // First-class event powering the "On Contact Tag updated" n8n trigger.
    // Only fire when tags actually changed — otherwise this gets emitted
    // for every contact.updated even when no tag membership shifted.
    if (tagChanges.added.length > 0 || tagChanges.removed.length > 0) {
      await this.bus.publish({
        type: "contact.tag_changed",
        workspaceId,
        contactId: updated.id,
        before: { tagIds: previousTagIds },
        after: { tagIds },
        added: tagChanges.added,
        removed: tagChanges.removed,
        changedByUserId: null,
        changedByApiKeyId: apiKeyId,
        silent,
      });
    }
  }

  // ── Broadcasts (read-only) ─────────────────────────────────────────────────

  /** Campaign list, newest first. `since` lets a client poll incrementally. */
  async listBroadcasts(workspaceId: string, q: ListBroadcastsQueryInput) {
    const rows = await this.db.broadcast.findMany({
      where: {
        workspaceId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.since ? { createdAt: { gte: new Date(q.since) } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    return {
      items: page.map(broadcastToExternal),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async getBroadcast(workspaceId: string, id: string) {
    const row = await this.db.broadcast.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException({ error: "broadcast_not_found" });
    return broadcastToExternal(row);
  }

  /** The SAME report object the in-app UI renders — one computation, three
   *  consumers, so the API and the dashboard can never disagree on a number. */
  async getBroadcastReport(workspaceId: string, id: string) {
    const report = await getBroadcastReport(workspaceId, id);
    if (!report) throw new NotFoundException({ error: "broadcast_not_found" });
    return report;
  }

  async listBroadcastRecipients(
    workspaceId: string,
    id: string,
    q: ListBroadcastRecipientsQueryInput,
  ) {
    // BroadcastRecipient carries no workspaceId of its own (it is scoped through the
    // parent), so ownership must be proven here before any recipient read.
    const owner = await this.db.broadcast.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!owner) throw new NotFoundException({ error: "broadcast_not_found" });

    const rows = await this.db.broadcastRecipient.findMany({
      where: {
        broadcastId: id,
        ...recipientOutcomeWhere(q),
        ...(q.updatedSince ? { updatedAt: { gte: new Date(q.updatedSince) } } : {}),
      },
      // Keyset on id: stable under concurrent delivery updates, which a
      // recency sort would not be during an incremental sync.
      orderBy: { id: "asc" },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { contact: { select: { name: true, phoneNumber: true } } },
    });
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    return {
      items: page.map(broadcastRecipientToExternal),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

}

// ---------------------------------------------------------------------------
// Shared helpers (duplicated from contacts.service.ts on purpose — same shapes
// but the external service intentionally doesn't depend on ContactsService so
// attribution + event payloads stay first-class /v1 concerns).
// ---------------------------------------------------------------------------

function trimOrNull(v: string | undefined): string | null {
  if (v === undefined) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Kept local (not imported from contacts) by the duplication contract above.
// Mirrors MAX_TOTAL_FIELDS in contacts.schemas.ts: bounds the accumulated
// customFields bag across many /v1 PATCHes so the JSONB can't grow unbounded.
const MAX_TOTAL_FIELDS = 100;

function assertCustomFieldsTotal(
  map: Record<string, string>,
  previousCount = 0,
): void {
  const count = Object.keys(map).length;
  // Reject only NET growth past the cap, so an already-over-cap bag stays
  // editable + shrinkable (see contacts.service.ts for the full rationale).
  if (count > MAX_TOTAL_FIELDS && count > previousCount) {
    throw new BadRequestException({
      error: "too_many_custom_fields",
      detail: `at most ${MAX_TOTAL_FIELDS} custom fields per contact`,
    });
  }

}

function normalizeCreateCustomFields(
  patch: Record<string, string | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  assertCustomFieldsTotal(out);
  return out;
}

function mergeCustomFields(
  current: Record<string, unknown>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const merged = normalizeStringMap(current);
  const previousCount = Object.keys(merged).length;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  // Cap NET growth only — removal/edit-only PATCHes never trip, even over cap.
  assertCustomFieldsTotal(merged, previousCount);
  return merged;
}


function normalizeColor(v: unknown): TagColor {
  if (typeof v !== "string") return "slate";
  return (TAG_COLORS as readonly string[]).includes(v) ? (v as TagColor) : "slate";
}

function slugifyKey(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/**
 * External wire shape for a campaign. Never a raw Prisma row: the DB model is
 * free to change, this contract is not. Dates are ISO strings.
 */
function broadcastToExternal(b: {
  id: string;
  status: string;
  name: string | null;
  kind: string;
  targetMode: string;
  templateName: string | null;
  templateLanguage: string | null;
  templateCategory: string | null;
  channel: string;
  audienceMode: string;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  suppressedCount: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  scheduledAt: Date | null;
}) {
  // `targetMode:"customer"` (People / best-channel) campaigns store an inert
  // channel:"whatsapp" — surfacing kind + targetMode lets a partner tell an
  // omnichannel campaign apart from a WhatsApp one (the API claims never to
  // disagree with the UI), and channel is null'd for customer mode so it can't
  // be mistaken for a real per-channel send.
  const isCustomerMode = b.targetMode === "customer";
  return {
    id: b.id,
    status: b.status,
    name: b.name,
    kind: b.kind,
    targetMode: b.targetMode,
    templateName: b.templateName,
    templateLanguage: b.templateLanguage,
    templateCategory: b.templateCategory,
    channel: isCustomerMode ? null : b.channel,
    audienceMode: b.audienceMode,
    totalCount: b.totalCount,
    sentCount: b.sentCount,
    failedCount: b.failedCount,
    suppressedCount: b.suppressedCount,
    createdAt: b.createdAt.toISOString(),
    scheduledAt: b.scheduledAt?.toISOString() ?? null,
    startedAt: b.startedAt?.toISOString() ?? null,
    completedAt: b.completedAt?.toISOString() ?? null,
  };
}

/**
 * External wire shape for one recipient's campaign outcome.
 *
 * `deliveryState` is the field to report on — `status` is the SEND-side outcome
 * (did we hand it to Meta) and deliberately does not change when a message is
 * later found undeliverable. Reporting on `status` is what produced the bug this
 * whole feature fixed.
 */
function broadcastRecipientToExternal(r: {
  id: string;
  contactId: string;
  status: string;
  deliveryState: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  repliedAt: Date | null;
  repliedAttribution: string | null;
  clickedAt: Date | null;
  clickedOptionId: string | null;
  optedOutAt: Date | null;
  errorCode: string | null;
  metaErrorCode: number | null;
  errorMessage: string | null;
  pricingCategory: string | null;
  pricingBillable: boolean | null;
  externalId: string | null;
  conversationId: string | null;
  updatedAt: Date;
  contact: { name: string; phoneNumber: string | null };
}) {
  return {
    id: r.id,
    contactId: r.contactId,
    contactName: r.contact.name,
    phone: r.contact.phoneNumber,
    deliveryState: r.deliveryState,
    sendStatus: r.status,
    sentAt: r.sentAt?.toISOString() ?? null,
    deliveredAt: r.deliveredAt?.toISOString() ?? null,
    readAt: r.readAt?.toISOString() ?? null,
    repliedAt: r.repliedAt?.toISOString() ?? null,
    replyAttribution: r.repliedAttribution,
    clickedAt: r.clickedAt?.toISOString() ?? null,
    clickedOptionId: r.clickedOptionId,
    optedOutAt: r.optedOutAt?.toISOString() ?? null,
    errorCode: r.errorCode,
    metaErrorCode: r.metaErrorCode,
    errorMessage: r.errorMessage,
    pricingCategory: r.pricingCategory,
    billable: r.pricingBillable,
    messageExternalId: r.externalId,
    conversationId: r.conversationId,
    updatedAt: r.updatedAt.toISOString(),
  };
}
