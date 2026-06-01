import { normalizeStringMap } from "@/lib/normalize-string-map";
import { Prisma } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { MAX_CHAIN_DEPTH } from "@/lib/workflows/events";

import {
  contactRowToExternal,
  toExternalContact,
  EXTERNAL_CONTACT_INCLUDE,
  type ExternalContact,
} from "@/lib/external-shapes";
import { ensureDefaultStage } from "@/lib/queries";
import type {
  Contact as DomainContact,
  ContactStage,
  Tag,
  User,
} from "@ccp/shared/types";
import type { ContactFieldChange } from "@ccp/shared/events/types";
import { TAG_COLORS, type TagColor } from "@ccp/shared/types";
import { getCountryFromPhone } from "@ccp/shared/utils";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import { runWithConcurrency } from "../../common/concurrency";
import { ApiIdempotencyService } from "./api-idempotency.service";
import { ExternalV1MessagingService } from "./external-v1-messaging.service";
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
  ExternalSendMessageInput,
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
 * scoped by `teamId` from the API key, and `changedByUserId / senderUserId`
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
@Injectable()
export class ExternalV1Service {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
    private readonly messaging: ExternalV1MessagingService,
    private readonly idem: ApiIdempotencyService,
  ) {}

  /**
   * Wrap a mutation thunk in CLAIM-then-execute idempotency. No-op (just runs
   * `work`) when `idempotencyKey` is absent, so existing callers that don't pass
   * a key are unchanged. A replay short-circuits the thunk entirely — zero side
   * effects — and returns the prior response. Used by the contact tag mutations
   * (F2 in docs/architecture-review-2026-05-25.md). The conversation mutations
   * inline the same pattern in ExternalV1MessagingService.
   */
  private async withIdempotency<T>(
    teamId: string,
    apiKeyId: string,
    idempotencyKey: string | undefined,
    route: string,
    fingerprintPayload: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!idempotencyKey) return work();
    const claim = await this.idem.claim<T>(
      teamId,
      apiKeyId,
      idempotencyKey,
      this.idem.fingerprint(route, fingerprintPayload),
    );
    if (claim.kind === "replay") return claim.result;
    try {
      const result = await work();
      await this.idem.complete(teamId, apiKeyId, idempotencyKey, result);
      return result;
    } catch (err) {
      await this.idem.release(teamId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  // ===========================================================================
  // Delegations to ExternalV1MessagingService — pass-through, no behavior here.
  // ===========================================================================

  listConversations(teamId: string, q: ListConversationsQueryInput) {
    return this.messaging.listConversations(teamId, q);
  }

  getConversation(teamId: string, id: string) {
    return this.messaging.getConversation(teamId, id);
  }

  assign(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalAssignInput,
    idempotencyKey?: string,
  ) {
    return this.messaging.assign(teamId, apiKeyId, conversationId, input, idempotencyKey);
  }

  setStatus(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalStatusInput,
    idempotencyKey?: string,
  ) {
    return this.messaging.setStatus(teamId, apiKeyId, conversationId, input, idempotencyKey);
  }

  listMessages(
    teamId: string,
    conversationId: string,
    q: ListMessagesQueryInput,
  ) {
    return this.messaging.listMessages(teamId, conversationId, q);
  }

  findMessage(teamId: string, id: string) {
    return this.messaging.findMessage(teamId, id);
  }

  sendMessage(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSendMessageInput,
    idempotencyKey?: string,
    chainDepth?: number,
  ) {
    return this.messaging.sendMessage(
      teamId,
      apiKeyId,
      conversationId,
      input,
      idempotencyKey,
      chainDepth,
    );
  }

  assignByContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAssignInput,
    idempotencyKey?: string,
  ) {
    return this.messaging.assignByContact(teamId, apiKeyId, contactId, input, idempotencyKey);
  }

  setStatusByContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactStatusInput,
    idempotencyKey?: string,
  ) {
    return this.messaging.setStatusByContact(teamId, apiKeyId, contactId, input, idempotencyKey);
  }

  sendTopLevelMessage(
    teamId: string,
    apiKeyId: string,
    input: ExternalTopLevelSendMessageInput,
    idempotencyKey?: string,
    chainDepth?: number,
  ) {
    return this.messaging.sendTopLevelMessage(teamId, apiKeyId, input, idempotencyKey, chainDepth);
  }

  createNote(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalNoteInput,
    idempotencyKey?: string,
    chainDepth?: number,
  ) {
    return this.messaging.createNote(
      teamId,
      apiKeyId,
      conversationId,
      input,
      idempotencyKey,
      chainDepth,
    );
  }

  // ===========================================================================
  // CONTACTS — read
  // ===========================================================================

  async getContact(teamId: string, id: string) {
    const row = await this.db.contact.findFirst({
      where: { id, teamId },
      include: EXTERNAL_CONTACT_INCLUDE,
    });
    if (!row) throw new NotFoundException({ error: "contact not found" });
    return contactRowToExternal(row);
  }

  /**
   * Find or list contacts. `phone` is the n8n "Find a Contact" path — exact
   * E.164 match, at most one row. Everything else is the paged list path.
   */
  async listContacts(teamId: string, q: ListContactsQueryInput) {
    // Natural-key short-circuits. Integrators usually know exactly one of
    // {phone, email, externalContactId} and want a single hydrated row back
    // without paging. Each branch returns at most one item and no cursor.
    //
    // Phone is normalized server-side so a mis-formatted "961 71 50…" still
    // resolves to the same E.164 row.
    if (q.phone) {
      const normalized = normalizePhoneE164(q.phone) ?? q.phone;
      const rows = await this.db.contact.findMany({
        where: { teamId, deletedAt: null, phoneNumber: normalized },
        include: EXTERNAL_CONTACT_INCLUDE,
        take: 1,
      });
      const items = rows.map((r) => contactRowToExternal(r));
      return { items, nextCursor: null };
    }
    if (q.email) {
      const rows = await this.db.contact.findMany({
        where: { teamId, deletedAt: null, email: { equals: q.email.trim(), mode: "insensitive" } },
        include: EXTERNAL_CONTACT_INCLUDE,
        take: 1,
      });
      const items = rows.map((r) => contactRowToExternal(r));
      return { items, nextCursor: null };
    }
    if (q.externalContactId) {
      const rows = await this.db.contact.findMany({
        where: { teamId, deletedAt: null, externalContactId: q.externalContactId },
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
        teamId,
        deletedAt: null,
        ...(q.stageId ? { stageId: q.stageId } : {}),
        ...(tagIds.length > 0 ? { tags: { some: { id: { in: tagIds } } } } : {}),
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: "insensitive" as const } },
                { phoneNumber: { contains: q.search, mode: "insensitive" as const } },
                { email: { contains: q.search, mode: "insensitive" as const } },
              ],
            }
          : {}),
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
    teamId: string,
    apiKeyId: string,
    input: ExternalCreateContactInput,
  ): Promise<ExternalContact> {
    const phone = normalizePhoneE164(input.phoneNumber);
    if (!phone) {
      throw new BadRequestException({
        error:
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
        where: { id: input.stageId, teamId },
        select: { id: true },
      });
      if (!stage) throw new BadRequestException({ error: "stage not found" });
      stageId = stage.id;
    } else {
      stageId = await ensureDefaultStage(teamId);
    }

    // Tag validation: only keep tag ids that exist on this team — defense
    // against an integration sending stale / cross-team ids.
    let validTagIds: string[] = [];
    if (input.tagIds && input.tagIds.length > 0) {
      const tags = await this.db.tag.findMany({
        where: { teamId, id: { in: input.tagIds } },
        select: { id: true },
      });
      validTagIds = tags.map((t) => t.id);
    }

    let created;
    try {
      created = await this.db.contact.create({
        data: {
          teamId,
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
          teamId,
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
          error: "a contact with this phone number already exists",
        });
      }
      throw err;
    }

    const tagIds = created.tags.map((t) => t.id);
    const contact: DomainContact = {
      id: created.id,
      teamId: created.teamId,
      phoneNumber: created.phoneNumber,
      identityChannel: created.identityChannel,
      externalContactId: created.externalContactId,
      name: created.name,
      firstName: created.firstName,
      lastName: created.lastName,
      language: created.language,
      countryCode: created.countryCode,
      avatarUrl: created.avatarUrl ?? undefined,
      email: created.email ?? undefined,
      location: created.location ?? undefined,
      customFields,
      source: created.source,
      stageId: created.stageId,
      tagIds,
      createdAt: created.createdAt.toISOString(),
    };

    // Fire `contact.created` FIRST (audited as the first-class trigger for the
    // "On Contact created" outbound webhook), then `contact.updated` for any
    // subscribers that still listen to the legacy kind="created" discriminator.
    await this.bus.publish({
      type: "contact.created",
      teamId,
      contact,
      source: "api",
      createdByUserId: null,
      createdByApiKeyId: apiKeyId,
    });

    await this.bus.publish({
      type: "contact.updated",
      teamId,
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
    teamId: string,
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
      where: { teamId, phoneNumber: phone, deletedAt: { not: null } },
      select: { id: true },
    });
    if (!existing) return null;

    const updated = await this.db.contact.update({
      where: { id: existing.id },
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
        tags: { set: data.tagIds.map((id) => ({ id })) },
      },
      include: EXTERNAL_CONTACT_INCLUDE,
    });

    const tagIds = updated.tags.map((t) => t.id);
    const contact: DomainContact = {
      id: updated.id,
      teamId: updated.teamId,
      phoneNumber: updated.phoneNumber,
      identityChannel: updated.identityChannel,
      externalContactId: updated.externalContactId,
      name: updated.name,
      firstName: updated.firstName,
      lastName: updated.lastName,
      language: updated.language,
      countryCode: updated.countryCode,
      avatarUrl: updated.avatarUrl ?? undefined,
      email: updated.email ?? undefined,
      location: updated.location ?? undefined,
      customFields: normalizeStringMap(updated.customFields),
      source: updated.source,
      stageId: updated.stageId,
      tagIds,
      createdAt: updated.createdAt.toISOString(),
    };

    await this.bus.publish({
      type: "contact.created",
      teamId,
      contact,
      source: "api",
      createdByUserId: null,
      createdByApiKeyId: apiKeyId,
    });

    await this.bus.publish({
      type: "contact.updated",
      teamId,
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

    return toExternalContact(updated, tagIds);
  }

  /**
   * Update by id. Loads pre-image inside a transaction so the customFields
   * merge sees a consistent snapshot; publishes `contact.updated` with a
   * fieldChanges diff. Phone is immutable (controller rejects payloads
   * with `phoneNumber` ownProperty BEFORE this method is called).
   */
  async updateContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalUpdateContactInput,
    idempotencyKey?: string,
  ): Promise<ExternalContact> {
    // Idempotency — a partner retry must not re-publish contact.updated /
    // lifecycle_changed and re-trigger workflows/webhooks. F2 in
    // docs/architecture-review-2026-05-25.md.
    if (idempotencyKey) {
      const claim = await this.idem.claim<ExternalContact>(
        teamId,
        apiKeyId,
        idempotencyKey,
        this.idem.fingerprint("update_contact", { contactId, input }),
      );
      if (claim.kind === "replay") return claim.result;
    }
    try {
      const result = await this.updateContactInternal(teamId, apiKeyId, contactId, input);
      if (idempotencyKey) {
        await this.idem.complete(teamId, apiKeyId, idempotencyKey, result);
      }
      return result;
    } catch (err) {
      if (idempotencyKey) await this.idem.release(teamId, apiKeyId, idempotencyKey);
      throw err;
    }
  }

  private async updateContactInternal(
    teamId: string,
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
        where: { id: stageId, teamId },
        select: { id: true },
      });
      if (!ok) throw new BadRequestException({ error: "stage not found" });
    }

    let result;
    try {
      result = await this.db.$transaction(async (tx) => {
        const existing = await tx.contact.findFirst({
          // deletedAt:null — a partner holding a tombstoned id (cached / from a
          // prior export) must not be able to edit a soft-deleted contact via
          // /v1. Mirrors the contacts.service M5 mutation guards.
          where: { id: contactId, teamId, deletedAt: null },
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
          where: { id: contactId, teamId, version: existing.version },
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
          error: "contact was modified by another writer, retry",
        });
      }
      throw err;
    }

    if (!result) throw new NotFoundException({ error: "contact not found" });
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

    const contact: DomainContact = {
      id: updated.id,
      teamId: updated.teamId,
      phoneNumber: updated.phoneNumber,
      identityChannel: updated.identityChannel,
      externalContactId: updated.externalContactId,
      name: updated.name,
      firstName: updated.firstName,
      lastName: updated.lastName,
      language: updated.language,
      countryCode: updated.countryCode,
      avatarUrl: updated.avatarUrl ?? undefined,
      email: updated.email ?? undefined,
      location: updated.location ?? undefined,
      customFields: newCustom,
      source: updated.source,
      stageId: updated.stageId,
      tagIds,
      createdAt: updated.createdAt.toISOString(),
    };

    // `silent: true` → skip reactions on every event this update fans out, so
    // a partner that edits a contact via /v1 doesn't re-trigger a workflow
    // (contact_field_updated / lifecycle) or echo a webhook back to itself.
    const silent = input.silent === true;

    // Always publish `contact.updated` for the catch-all subscribers.
    await this.bus.publish({
      type: "contact.updated",
      teamId,
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
        teamId,
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
  upsertContact(
    teamId: string,
    apiKeyId: string,
    input: ExternalUpsertContactInput,
    idempotencyKey?: string,
  ): Promise<{ contact: ExternalContact; created: boolean }> {
    return this.withIdempotency(
      teamId,
      apiKeyId,
      idempotencyKey,
      "upsert_contact",
      { input },
      () => this.upsertContactInternal(teamId, apiKeyId, input),
    );
  }

  private async upsertContactInternal(
    teamId: string,
    apiKeyId: string,
    input: ExternalUpsertContactInput,
  ): Promise<{ contact: ExternalContact; created: boolean }> {
    const phone = normalizePhoneE164(input.phoneNumber);
    if (!phone) {
      throw new BadRequestException({
        error:
          "phoneNumber must be a valid international number (e.g. +1 555 555 0100)",
      });
    }
    const existing = await this.db.contact.findFirst({
      where: { teamId, phoneNumber: phone },
      select: { id: true, deletedAt: true },
    });
    // Not found OR soft-deleted → go through createContact. For a tombstoned
    // row create() hits P2002 and reviveSoftDeletedByPhone restores it (firing
    // contact.created), so re-upserting a removed contact behaves like a fresh
    // add rather than silently patching a hidden row.
    if (!existing || existing.deletedAt) {
      const contact = await this.createContact(teamId, apiKeyId, input);
      return { contact, created: true };
    }
    // Call the internal (un-wrapped) update — upsert's own idempotency is the
    // caller's concern at the /v1/contacts/upsert route, not a nested claim.
    const contact = await this.updateContactInternal(teamId, apiKeyId, existing.id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
    });
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
    teamId: string,
    apiKeyId: string,
    contactId: string,
  ): Promise<void> {
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, teamId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    await this.db.contact.update({
      where: { id: contactId },
      data: { deletedAt: new Date() },
    });

    await this.bus.publish({
      type: "contact.deleted",
      teamId,
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
  async getContactChannels(teamId: string, contactId: string) {
    const c = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      select: { id: true, phoneNumber: true, identityChannel: true, externalContactId: true },
    });
    if (!c) throw new NotFoundException({ error: "contact not found" });
    if (!c.phoneNumber) return { items: [] };
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

  addContactTags(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAddTagsInput,
    idempotencyKey?: string,
  ): Promise<ExternalContact> {
    return this.withIdempotency(
      teamId,
      apiKeyId,
      idempotencyKey,
      "add_contact_tags",
      { contactId, tagIds: input.tagIds },
      () => this.addContactTagsInternal(teamId, apiKeyId, contactId, input),
    );
  }

  private async addContactTagsInternal(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAddTagsInput,
  ): Promise<ExternalContact> {
    const contact = await this.db.contact.findFirst({
      // deletedAt:null — don't tag a tombstoned contact (would write join rows +
      // fan out workflow/webhook events for a contact hidden everywhere else).
      where: { id: contactId, teamId, deletedAt: null },
      include: EXTERNAL_CONTACT_INCLUDE,
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    const tags = await this.db.tag.findMany({
      where: { teamId, id: { in: input.tagIds } },
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
        where: { id: contactId, teamId, version: contact.version },
        data: {
          tags: { connect: newIds.map((id) => ({ id })) },
          version: { increment: 1 },
        },
        include: EXTERNAL_CONTACT_INCLUDE,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new ConflictException({
          error: "contact was modified by another writer, retry",
        });
      }
      throw err;
    }

    const tagIds = updated.tags.map((t) => t.id);
    await this.publishContactTagChange(
      teamId,
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
  removeContactTags(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    tagIds: string[],
    silent = false,
    idempotencyKey?: string,
  ): Promise<ExternalContact> {
    return this.withIdempotency(
      teamId,
      apiKeyId,
      idempotencyKey,
      "remove_contact_tags",
      { contactId, tagIds },
      () => this.removeContactTagsInternal(teamId, apiKeyId, contactId, tagIds, silent),
    );
  }

  private async removeContactTagsInternal(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    tagIds: string[],
    silent = false,
  ): Promise<ExternalContact> {
    const contact = await this.db.contact.findFirst({
      // deletedAt:null — consistent with the other /v1 contact mutators.
      where: { id: contactId, teamId, deletedAt: null },
      include: EXTERNAL_CONTACT_INCLUDE,
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    const existingIds = new Set(contact.tags.map((t) => t.id));
    const toRemove = tagIds.filter((id) => existingIds.has(id));
    if (toRemove.length === 0) {
      return toExternalContact(contact, [...existingIds]);
    }

    let updated;
    try {
      updated = await this.db.contact.update({
        where: { id: contactId, teamId, version: contact.version },
        data: {
          tags: { disconnect: toRemove.map((id) => ({ id })) },
          version: { increment: 1 },
        },
        include: EXTERNAL_CONTACT_INCLUDE,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new ConflictException({
          error: "contact was modified by another writer, retry",
        });
      }
      throw err;
    }
    const newTagIds = updated.tags.map((t) => t.id);
    await this.publishContactTagChange(
      teamId,
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
    teamId: string,
    apiKeyId: string,
    contactId: string,
    tagId: string,
    idempotencyKey?: string,
  ): Promise<ExternalContact> {
    // Delegate to the plural-tag path with a one-element array. The two
    // earlier internals (singular + plural) were almost-identical copies
    // and had drifted (singular had no `silent` param, so the public
    // DELETE /v1/contacts/:id/tags/:tagId always fanouts while the bulk
    // DELETE could be silenced). Collapsing closes the asymmetry.
    return this.withIdempotency(
      teamId,
      apiKeyId,
      idempotencyKey,
      "remove_contact_tag",
      { contactId, tagId },
      () =>
        this.removeContactTagsInternal(teamId, apiKeyId, contactId, [tagId], false),
    );
  }

  /**
   * Bulk add or remove tags across many contacts. We loop tag-by-tag so the
   * per-contact event payloads stay coherent (one `tagChanges` per tag id),
   * and emit ONE coalesced `contact.bulk_updated` at the end so the socket
   * layer fans out a single frame regardless of how many contacts × tags.
   */
  async bulkContactTags(
    teamId: string,
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
      teamId,
      apiKeyId,
      idempotencyKey,
      action === "tag-add" ? "bulk_contact_tags_add" : "bulk_contact_tags_remove",
      { action, contactIds: input.contactIds, tagIds: input.tagIds },
      () => this.bulkContactTagsInternal(teamId, apiKeyId, action, input),
    );
  }

  private async bulkContactTagsInternal(
    teamId: string,
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
      where: { teamId, deletedAt: null, id: { in: input.contactIds } },
      select: { id: true },
    });
    const ownedIds = ownContacts.map((c) => c.id);
    if (ownedIds.length === 0) {
      throw new NotFoundException({ error: "no matching contacts in this team" });
    }

    const validTags = await this.db.tag.findMany({
      where: { teamId, id: { in: input.tagIds } },
      select: { id: true },
    });
    const validTagIds = validTags.map((t) => t.id);
    if (validTagIds.length === 0) {
      throw new NotFoundException({ error: "no matching tags in this team" });
    }

    for (const tagId of validTagIds) {
      if (action === "tag-add") {
        await this.db.$executeRaw`
          INSERT INTO "_ContactToTag" ("A", "B")
          SELECT id, ${tagId} FROM "Contact"
          WHERE id = ANY(${ownedIds}::text[]) AND "teamId" = ${teamId}
          ON CONFLICT DO NOTHING
        `;
      } else {
        await this.db.$executeRaw`
          DELETE FROM "_ContactToTag"
          WHERE "A" = ANY(${ownedIds}::text[]) AND "B" = ${tagId}
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
      WHERE id = ANY(${ownedIds}::text[]) AND "teamId" = ${teamId}
    `;

    // Per-contact `contact.updated` events for workflow + audit dispatch —
    // `suppressSocketFanout: true` so the coalesced frame below is the
    // only socket fanout the clients see. Additionally, a narrow
    // `contact.tag_changed` per contact (NOT suppressed at the socket layer,
    // but the outbound-webhooks subscriber doesn't read that flag) so the
    // n8n "On Contact Tag updated" trigger fires per affected contact.
    const updated = await this.db.contact.findMany({
      where: { teamId, id: { in: ownedIds } },
      include: EXTERNAL_CONTACT_INCLUDE,
    });
    // Bounded 16-lane fanout — see contacts.service.ts for rationale. An
    // unbounded Promise.all over 500 ids × 6 sequential subscribers pinned
    // the event loop for hundreds of ms on the single VPS.
    await runWithConcurrency(updated, 16, async (c) => {
      const tagIds = c.tags.map((t) => t.id);
      const payload: DomainContact = {
        id: c.id,
        teamId: c.teamId,
        phoneNumber: c.phoneNumber,
        identityChannel: c.identityChannel,
        externalContactId: c.externalContactId,
        name: c.name,
        firstName: c.firstName,
        lastName: c.lastName,
        language: c.language,
        countryCode: c.countryCode,
        avatarUrl: c.avatarUrl ?? undefined,
        email: c.email ?? undefined,
        location: c.location ?? undefined,
        customFields: normalizeStringMap(c.customFields),
        source: c.source,
        stageId: c.stageId,
        tagIds,
        createdAt: c.createdAt.toISOString(),
      };
      const added =
        action === "tag-add" ? validTagIds.filter((t) => tagIds.includes(t)) : [];
      const removed =
        action === "tag-remove" ? validTagIds.filter((t) => !tagIds.includes(t)) : [];
      const tagChanges = { added, removed };

      await this.bus.publish({
        type: "contact.updated",
        teamId,
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

      if (added.length > 0 || removed.length > 0) {
        await this.bus.publish({
          type: "contact.tag_changed",
          teamId,
          contactId: c.id,
          // `before` lacks the changes — for the add path the prior set is
          // tagIds minus what we just added; for remove it's tagIds plus
          // what we just removed. Compute back from the post-state to
          // avoid re-reading the row.
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
      teamId,
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

  async listContactFields(teamId: string) {
    const rows = await this.db.contactFieldDefinition.findMany({
      where: { teamId },
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
  async findContactField(teamId: string, idOrKey: string) {
    const row = await this.db.contactFieldDefinition.findFirst({
      where: { teamId, OR: [{ id: idOrKey }, { key: idOrKey }] },
    });
    if (!row) throw new NotFoundException({ error: "contact field not found" });
    return { id: row.id, key: row.key, label: row.label, order: row.order };
  }

  async createContactField(teamId: string, input: ExternalCreateContactFieldInput) {
    const existing = await this.db.contactFieldDefinition.findMany({
      where: { teamId },
      select: { key: true, order: true },
      orderBy: { order: "desc" },
    });
    if (existing.length >= 50) {
      throw new BadRequestException({ error: "at most 50 contact fields per team" });
    }
    const baseKey = slugifyKey(input.label);
    if (!baseKey) {
      throw new BadRequestException({ error: "label must contain letters or digits" });
    }
    const usedKeys = new Set(existing.map((e) => e.key));
    let key = baseKey;
    let suffix = 2;
    while (usedKeys.has(key)) key = `${baseKey}_${suffix++}`;
    const nextOrder = (existing[0]?.order ?? -1) + 1;

    try {
      const created = await this.db.contactFieldDefinition.create({
        data: { teamId, key, label: input.label, order: nextOrder },
      });
      await this.bus.publish({
        type: "team.catalog_changed",
        teamId,
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
        throw new ConflictException({ error: "field with that key already exists" });
      }
      throw err;
    }
  }

  // ===========================================================================
  // TAGS catalog
  // ===========================================================================

  async listTags(teamId: string): Promise<{ items: Tag[] }> {
    const rows = await this.db.tag.findMany({
      where: { teamId },
      orderBy: { name: "asc" },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        name: r.name,
        color: normalizeColor(r.color),
      })),
    };
  }

  async createTag(teamId: string, input: ExternalCreateTagInput): Promise<Tag> {
    const color = normalizeColor(input.color);
    try {
      const created = await this.db.tag.create({
        data: { teamId, name: input.name, color },
      });
      await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "tags" });
      return {
        id: created.id,
        teamId: created.teamId,
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
          error: "name taken",
          detail: `A tag named "${input.name}" already exists.`,
        });
      }
      throw err;
    }
  }

  async updateTag(teamId: string, id: string, input: ExternalUpdateTagInput): Promise<Tag> {
    const existing = await this.db.tag.findFirst({ where: { id, teamId } });
    if (!existing) throw new NotFoundException({ error: "tag not found" });
    try {
      const updated = await this.db.tag.update({ where: { id }, data: input });
      await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "tags" });
      return {
        id: updated.id,
        teamId: updated.teamId,
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
        throw new ConflictException({ error: "a tag with that name already exists" });
      }
      throw err;
    }
  }

  async deleteTag(teamId: string, id: string): Promise<void> {
    const existing = await this.db.tag.findFirst({ where: { id, teamId } });
    if (!existing) throw new NotFoundException({ error: "tag not found" });
    await this.db.tag.delete({ where: { id } });
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "tags" });
  }

  // ===========================================================================
  // STAGES catalog (read-only via /v1)
  // ===========================================================================

  async listStages(teamId: string): Promise<{ items: ContactStage[] }> {
    const rows = await this.db.contactStage.findMany({
      where: { teamId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        name: r.name,
        color: r.color as TagColor,
        position: r.position,
        isDefault: r.isDefault,
      })),
    };
  }

  // ===========================================================================
  // USERS (read-only)
  // ===========================================================================

  async listUsers(teamId: string): Promise<{ items: User[] }> {
    const rows = await this.db.user.findMany({
      where: { teamId },
      orderBy: { name: "asc" },
    });
    return {
      items: rows.map((u) => ({
        id: u.id,
        teamId: u.teamId,
        role: u.role,
        name: u.name,
        email: u.email,
        ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
        isActive: u.deactivatedAt === null,
      })),
    };
  }

  async findUser(teamId: string, idOrEmail: string): Promise<{ user: User }> {
    const row = await this.db.user.findFirst({
      where: { teamId, OR: [{ id: idOrEmail }, { email: idOrEmail }] },
    });
    if (!row) throw new NotFoundException({ error: "user not found" });
    return {
      user: {
        id: row.id,
        teamId: row.teamId,
        role: row.role,
        name: row.name,
        email: row.email,
        ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
        isActive: row.deactivatedAt === null,
      },
    };
  }

  // ===========================================================================
  // CHANNELS — synthetic single-row response for parity
  // ===========================================================================

  async listChannels(teamId: string) {
    // One active connection per provider today; lists all the team's channels.
    const conns = await this.db.channelConnection.findMany({
      where: { teamId, isActive: true },
      select: { channel: true, config: true },
    });
    const items = conns
      .map((c) => {
        const cfg = (c.config ?? {}) as {
          phoneNumberId?: string;
          displayPhoneNumber?: string;
        };
        if (!cfg.phoneNumberId) return null;
        return {
          id: cfg.phoneNumberId,
          channel: c.channel,
          display: cfg.displayPhoneNumber ?? cfg.phoneNumberId,
        };
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
    teamId: string,
    apiKeyId: string,
    updated: Prisma.ContactGetPayload<{ include: { tags: { select: { id: true } } } }>,
    previousStageId: string | null,
    previousTagIds: string[],
    tagChanges: { added: string[]; removed: string[] },
    /** `silent: true` on the request → skip workflow re-trigger + webhook echo. */
    silent = false,
  ) {
    const tagIds = updated.tags.map((t) => t.id);
    const payload: DomainContact = {
      id: updated.id,
      teamId: updated.teamId,
      phoneNumber: updated.phoneNumber,
      identityChannel: updated.identityChannel,
      externalContactId: updated.externalContactId,
      name: updated.name,
      firstName: updated.firstName,
      lastName: updated.lastName,
      language: updated.language,
      countryCode: updated.countryCode,
      avatarUrl: updated.avatarUrl ?? undefined,
      email: updated.email ?? undefined,
      location: updated.location ?? undefined,
      customFields: normalizeStringMap(updated.customFields),
      source: updated.source,
      stageId: updated.stageId,
      tagIds,
      createdAt: updated.createdAt.toISOString(),
    };
    // Existing catch-all for legacy subscribers.
    await this.bus.publish({
      type: "contact.updated",
      teamId,
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
        teamId,
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

function normalizeCreateCustomFields(
  patch: Record<string, string | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

function mergeCustomFields(
  current: Record<string, unknown>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const merged = normalizeStringMap(current);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
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
