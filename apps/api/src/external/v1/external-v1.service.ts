import { Prisma } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  toExternalContact,
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
  ) {}

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
  ) {
    return this.messaging.assign(teamId, apiKeyId, conversationId, input);
  }

  setStatus(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalStatusInput,
  ) {
    return this.messaging.setStatus(teamId, apiKeyId, conversationId, input);
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
  ) {
    return this.messaging.sendMessage(
      teamId,
      apiKeyId,
      conversationId,
      input,
      idempotencyKey,
    );
  }

  assignByContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAssignInput,
  ) {
    return this.messaging.assignByContact(teamId, apiKeyId, contactId, input);
  }

  setStatusByContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactStatusInput,
  ) {
    return this.messaging.setStatusByContact(teamId, apiKeyId, contactId, input);
  }

  sendTopLevelMessage(
    teamId: string,
    apiKeyId: string,
    input: ExternalTopLevelSendMessageInput,
    idempotencyKey?: string,
  ) {
    return this.messaging.sendTopLevelMessage(teamId, apiKeyId, input, idempotencyKey);
  }

  createNote(teamId: string, conversationId: string, input: ExternalNoteInput) {
    return this.messaging.createNote(teamId, conversationId, input);
  }

  // ===========================================================================
  // CONTACTS — read
  // ===========================================================================

  async getContact(teamId: string, id: string) {
    const row = await this.db.contact.findFirst({
      where: { id, teamId },
      include: { tags: { select: { id: true } } },
    });
    if (!row) throw new NotFoundException({ error: "contact not found" });
    return toExternalContact(row, row.tags.map((t) => t.id));
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
        where: { teamId, phoneNumber: normalized },
        include: { tags: { select: { id: true } } },
        take: 1,
      });
      const items = rows.map((r) => toExternalContact(r, r.tags.map((t) => t.id)));
      return { items, nextCursor: null };
    }
    if (q.email) {
      const rows = await this.db.contact.findMany({
        where: { teamId, email: { equals: q.email.trim(), mode: "insensitive" } },
        include: { tags: { select: { id: true } } },
        take: 1,
      });
      const items = rows.map((r) => toExternalContact(r, r.tags.map((t) => t.id)));
      return { items, nextCursor: null };
    }
    if (q.externalContactId) {
      const rows = await this.db.contact.findMany({
        where: { teamId, externalContactId: q.externalContactId },
        include: { tags: { select: { id: true } } },
        take: 1,
      });
      const items = rows.map((r) => toExternalContact(r, r.tags.map((t) => t.id)));
      return { items, nextCursor: null };
    }

    const tagIds = q.tagIds
      ? q.tagIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : [];

    const rows = await this.db.contact.findMany({
      where: {
        teamId,
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
      include: { tags: { select: { id: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map((r) =>
      toExternalContact(r, r.tags.map((t) => t.id)),
    );
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

    // Account-manager validation — must be an active User on this team.
    let assignedUserId: string | null = null;
    if (input.assignedUserId) {
      const user = await this.db.user.findFirst({
        where: { id: input.assignedUserId, teamId, deactivatedAt: null },
        select: { id: true },
      });
      if (!user) throw new BadRequestException({ error: "assignedUserId not a member of this team" });
      assignedUserId = user.id;
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
          phoneNumber: phone,
          name,
          firstName: trimmedFirst,
          lastName: trimmedLast,
          language,
          countryCode,
          assignedUserId,
          email: email ?? undefined,
          location: location ?? undefined,
          customFields,
          stageId,
          source: "manual",
          ...(validTagIds.length > 0
            ? { tags: { connect: validTagIds.map((id) => ({ id })) } }
            : {}),
        },
        include: { tags: { select: { id: true } } },
      });
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
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
      identityProvider: created.identityProvider,
      externalContactId: created.externalContactId,
      name: created.name,
      firstName: created.firstName,
      lastName: created.lastName,
      language: created.language,
      countryCode: created.countryCode,
      assignedUserId: created.assignedUserId,
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
    });

    return toExternalContact(created, tagIds);
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
  ): Promise<ExternalContact> {
    const {
      name,
      firstName,
      lastName,
      language,
      countryCode,
      assignedUserId,
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

    // Validate + hydrate the new assignee (if set). null clears; cuid sets.
    // We fetch the User row up front so the contact.assignee_changed event
    // carries a fully-hydrated `afterUser` for webhook payload structure.
    let afterAssignee: User | null = null;
    if (typeof assignedUserId === "string") {
      const u = await this.db.user.findFirst({
        where: { id: assignedUserId, teamId, deactivatedAt: null },
        select: { id: true, name: true, email: true, role: true, teamId: true, avatarUrl: true, createdAt: true, deactivatedAt: true },
      });
      if (!u) throw new BadRequestException({ error: "assignedUserId not a member of this team" });
      afterAssignee = {
        id: u.id,
        teamId: u.teamId,
        role: u.role,
        name: u.name,
        email: u.email,
        ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
        ...(u.createdAt ? { createdAt: u.createdAt.toISOString() } : {}),
        isActive: u.deactivatedAt === null,
      };
    }

    let result;
    try {
      result = await this.db.$transaction(async (tx) => {
        const existing = await tx.contact.findFirst({
          where: { id: contactId, teamId },
          include: { tags: { select: { id: true } } },
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
            ...(assignedUserId !== undefined ? { assignedUserId } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(location !== undefined ? { location } : {}),
            ...(stageId !== undefined ? { stageId } : {}),
            ...(nextCustom !== undefined ? { customFields: nextCustom } : {}),
            version: { increment: 1 },
          },
          include: { tags: { select: { id: true } } },
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
      identityProvider: updated.identityProvider,
      externalContactId: updated.externalContactId,
      name: updated.name,
      firstName: updated.firstName,
      lastName: updated.lastName,
      language: updated.language,
      countryCode: updated.countryCode,
      assignedUserId: updated.assignedUserId,
      avatarUrl: updated.avatarUrl ?? undefined,
      email: updated.email ?? undefined,
      location: updated.location ?? undefined,
      customFields: newCustom,
      source: updated.source,
      stageId: updated.stageId,
      tagIds,
      createdAt: updated.createdAt.toISOString(),
    };

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
      });
    }
    if (existing.assignedUserId !== updated.assignedUserId) {
      await this.bus.publish({
        type: "contact.assignee_changed",
        teamId,
        contactId: updated.id,
        before: { assignedUserId: existing.assignedUserId },
        after: { assignedUserId: updated.assignedUserId },
        afterUser: afterAssignee,
        changedByUserId: null,
        changedByApiKeyId: apiKeyId,
      });
    }

    return toExternalContact(updated, tagIds);
  }

  /**
   * Create-or-update by phone — atomic find-then-create-or-update. Returns
   * `created: true` for new rows, `created: false` for updates.
   */
  async upsertContact(
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
      select: { id: true },
    });
    if (!existing) {
      const contact = await this.createContact(teamId, apiKeyId, input);
      return { contact, created: true };
    }
    const contact = await this.updateContact(teamId, apiKeyId, existing.id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
    });
    return { contact, created: false };
  }

  /**
   * Hard-delete. Cascade clears Conversation / Message / InternalNote /
   * BroadcastRecipient / Tag joins via FK. Blob unlink is best-effort
   * AFTER the DB commit — a stuck blob is preferable to a half-committed delete.
   */
  async deleteContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
  ): Promise<void> {
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      select: {
        id: true,
        conversations: {
          select: {
            id: true,
            messages: {
              where: { mediaKey: { not: null } },
              select: { mediaKey: true },
            },
          },
        },
      },
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    const mediaKeys = contact.conversations
      .flatMap((c) => c.messages)
      .map((m) => m.mediaKey)
      .filter((k): k is string => Boolean(k));
    const conversationIds = contact.conversations.map((c) => c.id);

    await this.db.contact.delete({ where: { id: contactId } });

    if (mediaKeys.length > 0) {
      // Lazy-import to keep startup graph small; blob-storage init touches
      // env / providers we don't want on every delete-less request.
      const { blobStorage } = await import("@/lib/blob-storage");
      await blobStorage.delete(mediaKeys);
    }

    await this.bus.publish({
      type: "contact.deleted",
      teamId,
      contactId,
      conversationIds,
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
      select: { id: true, phoneNumber: true, identityProvider: true, externalContactId: true },
    });
    if (!c) throw new NotFoundException({ error: "contact not found" });
    if (!c.phoneNumber) return { items: [] };
    return {
      items: [
        {
          channel: c.identityProvider ?? "meta_cloud",
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
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAddTagsInput,
  ): Promise<ExternalContact> {
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      include: { tags: { select: { id: true } } },
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
        include: { tags: { select: { id: true } } },
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
    teamId: string,
    apiKeyId: string,
    contactId: string,
    tagIds: string[],
  ): Promise<ExternalContact> {
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      include: { tags: { select: { id: true } } },
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
        include: { tags: { select: { id: true } } },
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
    );
    return toExternalContact(updated, newTagIds);
  }

  async removeContactTag(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    tagId: string,
  ): Promise<ExternalContact> {
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      include: { tags: { select: { id: true } } },
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    const hadTag = contact.tags.some((t) => t.id === tagId);
    if (!hadTag) {
      return toExternalContact(contact, contact.tags.map((t) => t.id));
    }

    let updated;
    try {
      updated = await this.db.contact.update({
        where: { id: contactId, teamId, version: contact.version },
        data: {
          tags: { disconnect: { id: tagId } },
          version: { increment: 1 },
        },
        include: { tags: { select: { id: true } } },
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
      { added: [], removed: [tagId] },
    );
    return toExternalContact(updated, tagIds);
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
  ): Promise<{ count: number; tagIds: string[]; contactIds: string[] }> {
    const ownContacts = await this.db.contact.findMany({
      where: { teamId, id: { in: input.contactIds } },
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
      include: { tags: { select: { id: true } } },
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
        identityProvider: c.identityProvider,
        externalContactId: c.externalContactId,
        name: c.name,
        firstName: c.firstName,
        lastName: c.lastName,
        language: c.language,
        countryCode: c.countryCode,
        assignedUserId: c.assignedUserId,
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
    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        metaPhoneNumberId: true,
        metaDisplayPhoneNumber: true,
      },
    });
    if (!team || !team.metaPhoneNumberId) {
      return { items: [] };
    }
    return {
      items: [
        {
          id: team.metaPhoneNumberId,
          channel: "meta_cloud",
          display: team.metaDisplayPhoneNumber ?? team.metaPhoneNumberId,
        },
      ],
    };
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
  ) {
    const tagIds = updated.tags.map((t) => t.id);
    const payload: DomainContact = {
      id: updated.id,
      teamId: updated.teamId,
      phoneNumber: updated.phoneNumber,
      identityProvider: updated.identityProvider,
      externalContactId: updated.externalContactId,
      name: updated.name,
      firstName: updated.firstName,
      lastName: updated.lastName,
      language: updated.language,
      countryCode: updated.countryCode,
      assignedUserId: updated.assignedUserId,
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

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
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
