import { Prisma } from "@prisma/client";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

import {
  toExternalContact,
  toExternalConversation,
  toExternalMessage,
  type ExternalContact,
  type ExternalMessage,
} from "@/lib/external-shapes";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import {
  sendTemplateInternal,
  SendTemplateValidationError,
} from "@/lib/messaging/send-template-internal";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { ensureDefaultStage } from "@/lib/queries";
import type {
  Contact as DomainContact,
  ContactStage,
  Message,
  Tag,
  User,
} from "@ccp/shared/types";
import type { ContactFieldChange } from "@ccp/shared/events/types";
import { TAG_COLORS, type TagColor } from "@ccp/shared/types";
import { getCountryFromPhone } from "@ccp/shared/utils";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import { computeWindowStatus } from "@ccp/shared/utils/window";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
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
 */
@Injectable()
export class ExternalV1Service {
  private readonly logger = new Logger(ExternalV1Service.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

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
    // Phone exact-match short-circuit. n8n's "find contact" flow always
    // posts a normalized E.164 phone; we accept loose input + normalize on
    // our side so an integration mis-formatted number still resolves.
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

    const result = await this.db.$transaction(async (tx) => {
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

      const updated = await tx.contact.update({
        where: { id: contactId },
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
        },
        include: { tags: { select: { id: true } } },
      });
      return { existing, updated };
    });

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

    const updated = await this.db.contact.update({
      where: { id: contactId },
      data: { tags: { connect: newIds.map((id) => ({ id })) } },
      include: { tags: { select: { id: true } } },
    });

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

    const updated = await this.db.contact.update({
      where: { id: contactId },
      data: { tags: { disconnect: toRemove.map((id) => ({ id })) } },
      include: { tags: { select: { id: true } } },
    });
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

    const updated = await this.db.contact.update({
      where: { id: contactId },
      data: { tags: { disconnect: { id: tagId } } },
      include: { tags: { select: { id: true } } },
    });
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
    await Promise.all(
      updated.map(async (c) => {
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
      }),
    );

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

  // ===========================================================================
  // CONVERSATIONS — existing
  // ===========================================================================

  async listConversations(teamId: string, q: ListConversationsQueryInput) {
    const rows = await this.db.conversation.findMany({
      where: {
        teamId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.phone ? { contact: { phoneNumber: q.phone } } : {}),
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map(toExternalConversation);
    const lastItem = items[items.length - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    return { items, nextCursor };
  }

  async getConversation(teamId: string, id: string) {
    const row = await this.db.conversation.findFirst({
      where: { id, teamId },
      include: { contact: { include: { tags: { select: { id: true } } } } },
    });
    if (!row) throw new NotFoundException({ error: "conversation not found" });
    return {
      conversation: toExternalConversation(row),
      contact: toExternalContact(row.contact, row.contact.tags.map((t) => t.id)),
    };
  }

  async assign(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalAssignInput,
  ) {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        assignedUserId: true,
        contact: { include: { tags: { select: { id: true } } } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    if (input.assignedUserId !== null) {
      const member = await this.db.user.findFirst({
        where: { id: input.assignedUserId, teamId },
        select: { id: true },
      });
      if (!member) throw new BadRequestException({ error: "user not in team" });
    }

    const updated = await this.db.conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: input.assignedUserId },
      include: { assignedUser: true },
    });

    const assignedUser: User | null = updated.assignedUser
      ? {
          id: updated.assignedUser.id,
          teamId: updated.assignedUser.teamId,
          role: updated.assignedUser.role,
          name: updated.assignedUser.name,
          email: updated.assignedUser.email,
          avatarUrl: updated.assignedUser.avatarUrl ?? undefined,
          isActive: updated.assignedUser.deactivatedAt === null,
        }
      : null;

    await this.bus.publish({
      type: "conversation.assigned",
      teamId,
      conversationId,
      assignedUser,
      previousAssignedUserId: conversation.assignedUserId,
      newAssignedUserId: input.assignedUserId,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      contact: workflowContactSnapshot(conversation.contact),
    });
  }

  async setStatus(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalStatusInput,
  ) {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      include: { contact: { include: { tags: { select: { id: true } } } } },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    const previousStatus = conversation.status;

    await this.db.conversation.update({
      where: { id: conversationId },
      data: { status: input.status },
    });

    await this.bus.publish({
      type: "conversation.status_changed",
      teamId,
      conversationId,
      previousStatus,
      newStatus: input.status,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      contact: workflowContactSnapshot(conversation.contact),
    });
  }

  // ===========================================================================
  // MESSAGES — existing + find
  // ===========================================================================

  async listMessages(
    teamId: string,
    conversationId: string,
    q: ListMessagesQueryInput,
  ) {
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true },
    });
    if (!conv) throw new NotFoundException({ error: "conversation not found" });

    const rows = await this.db.message.findMany({
      where: { conversationId },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map(toExternalMessage);
    const lastItem = items[items.length - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    return { items, nextCursor };
  }

  async findMessage(teamId: string, id: string) {
    const row = await this.db.message.findFirst({ where: { id, teamId } });
    if (!row) throw new NotFoundException({ error: "message not found" });
    return { message: toExternalMessage(row) };
  }

  async sendMessage(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSendMessageInput,
    /** Optional idempotency key from the `Idempotency-Key` request header. */
    idempotencyKey?: string,
  ) {
    // Idempotency — CLAIM-then-execute, not execute-then-record.
    //
    // The prior pattern (read cache → send to Meta → fire-and-forget upsert)
    // left a wide race window: a partner retry between the Meta call and the
    // background upsert would not see the cache yet, re-send the message,
    // and produce a duplicate customer-facing WhatsApp delivery.
    //
    // Now: insert a row with `responseStatus: 0` (sentinel = pending) before
    // any side effect. The unique index on (teamId, apiKeyId, key) makes
    // the insert serve as a row-level lock — concurrent retries see P2002
    // and read whatever row the winner committed. After the Meta send +
    // DB writes, we UPDATE the row with the real response body + status
    // + extend expiresAt to 24h. On send failure, DELETE so a retry can
    // claim fresh.
    //
    // Pending TTL is short (5min) so a crashed handler doesn't permanently
    // shadow the key — the sweeper at lib/sweepers/api-idempotency-cleanup
    // garbage-collects expired pending rows too.
    const PENDING_STATUS = 0;
    const PENDING_TTL_MS = 5 * 60_000;
    const COMPLETED_TTL_MS = 24 * 60 * 60_000;
    if (idempotencyKey) {
      try {
        await this.db.apiIdempotencyKey.create({
          data: {
            teamId,
            apiKeyId,
            key: idempotencyKey,
            responseBody: { _pending: true } as Prisma.InputJsonValue,
            responseStatus: PENDING_STATUS,
            expiresAt: new Date(Date.now() + PENDING_TTL_MS),
          },
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          // Another request already claimed this key. Read its state.
          const cached = await this.db.apiIdempotencyKey.findUnique({
            where: {
              teamId_apiKeyId_key: { teamId, apiKeyId, key: idempotencyKey },
            },
            select: { responseBody: true, responseStatus: true, expiresAt: true },
          });
          if (!cached) {
            // Vanished between P2002 and the read (sweeper / manual delete).
            // Surface as 409 — partner can retry, which will re-claim cleanly.
            throw new ConflictException({
              error: "idempotency_in_progress",
              detail: "Concurrent retry race — try again in a moment.",
            });
          }
          if (cached.responseStatus === PENDING_STATUS) {
            if (cached.expiresAt > new Date()) {
              throw new ConflictException({
                error: "idempotency_in_progress",
                detail:
                  "A previous request with this Idempotency-Key is still in flight. " +
                  "Retry in a few seconds.",
              });
            }
            // Stale pending row past TTL — clear and re-claim. Race with the
            // sweeper is harmless because deleteMany is no-op when zero rows.
            await this.db.apiIdempotencyKey.deleteMany({
              where: { teamId, apiKeyId, key: idempotencyKey },
            });
            // Loop back into the create path on caller retry; simplest is to
            // tell the partner so the next request gets a clean claim.
            throw new ConflictException({
              error: "idempotency_in_progress",
              detail: "Stale pending claim cleared — retry.",
            });
          }
          if (cached.expiresAt > new Date()) {
            return cached.responseBody as unknown as { message: ExternalMessage };
          }
          // Expired completed row — fall through to re-claim. Delete first
          // so the create below doesn't P2002 again.
          await this.db.apiIdempotencyKey.deleteMany({
            where: { teamId, apiKeyId, key: idempotencyKey },
          });
          await this.db.apiIdempotencyKey.create({
            data: {
              teamId,
              apiKeyId,
              key: idempotencyKey,
              responseBody: { _pending: true } as Prisma.InputJsonValue,
              responseStatus: PENDING_STATUS,
              expiresAt: new Date(Date.now() + PENDING_TTL_MS),
            },
          });
        } else {
          throw err;
        }
      }
    }

    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        contact: { select: { phoneNumber: true, lastInboundAt: true } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
    const win = computeWindowStatus(lastInboundAt);
    if (win.state === "closed" || win.state === "never") {
      throw new UnprocessableEntityException({
        error: "outside_24h_window",
        detail:
          "free-form messages are only allowed within 24h of the contact's last inbound. " +
          "use a pre-approved template for cold outbound (not yet exposed via the external API).",
        lastInboundAt,
      });
    }

    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (input.replyToMessageId) {
      const replyRow = await this.db.message.findFirst({
        where: { id: input.replyToMessageId, conversationId, teamId },
        select: { id: true, externalId: true },
      });
      if (!replyRow) {
        // Previously silently dropped — partner thought their reply was
        // quoted but the message went out as a top-level send. Surface
        // the failure so they can see the bad id in their automation logs.
        throw new BadRequestException({
          error: "reply_target_not_found",
          detail:
            "replyToMessageId does not match a message in this conversation. " +
            "It may have been deleted, belongs to a different conversation, or " +
            "is owned by a different team.",
        });
      }
      replyToMessageId = replyRow.id;
      if (!replyRow.externalId.startsWith("tmp_")) {
        replyToExternalId = replyRow.externalId;
      }
    }

    if (!conversation.contact.phoneNumber) {
      throw new BadRequestException({
        error: "contact_has_no_phone",
        detail: "This contact has no WhatsApp number.",
      });
    }

    let send;
    try {
      const config = await getMetaSendConfig(teamId);
      send = await getMetaProvider().sendText(
        {
          to: conversation.contact.phoneNumber,
          body: input.body,
          ...(replyToExternalId ? { replyToExternalId } : {}),
        },
        config,
      );
    } catch (err) {
      // Send failed — release the idempotency claim so the partner can
      // retry. Without this, the row stays in `pending` state for the full
      // PENDING_TTL_MS and every retry inside that window gets 409.
      if (idempotencyKey) {
        await this.db.apiIdempotencyKey
          .deleteMany({
            where: {
              teamId,
              apiKeyId,
              key: idempotencyKey,
              responseStatus: PENDING_STATUS,
            },
          })
          .catch(() => {
            /* best-effort */
          });
      }
      if (err instanceof ProviderNotConfiguredError) {
        throw new ConflictException({
          error: "whatsapp_not_connected",
          detail: err.message,
        });
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          detail: `Meta ${normalized.httpStatus}: ${normalized.message}${
            normalized.detail ? ` — ${normalized.detail}` : ""
          }`,
        });
      }
      this.logger.error("external sendText failed", err);
      throw new BadGatewayException({
        error: "send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const created = await createOutboundMessageIdempotent({
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: null,
      body: input.body,
      direction: "out",
      provider: "meta_cloud",
      status: "sent",
      rawPayload: { sentVia: "api/external/v1", apiKeyId } as Prisma.InputJsonValue,
      timestamp: send.timestamp,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });

    const preview = input.body.slice(0, 200);
    await this.db.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: send.timestamp, lastMessagePreview: preview },
    });

    const message: Message = {
      id: created.id,
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: null,
      body: input.body,
      direction: "out",
      provider: "meta_cloud",
      status: "sent",
      rawPayload: { sentVia: "api/external/v1", apiKeyId },
      timestamp: send.timestamp.toISOString(),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    };

    await this.bus.publish({
      type: "message.sent",
      teamId,
      conversationId,
      message,
      preview,
      lastMessageAt: send.timestamp.toISOString(),
      unreadDelta: 0,
      senderUserId: null,
      senderApiKeyId: apiKeyId,
    });

    const result = { message: toExternalMessage(created) };

    if (idempotencyKey) {
      // Complete the claim — flip the pending sentinel to the real response.
      // AWAITED (not fire-and-forget) so concurrent retries arriving at the
      // claim path immediately see the completed row instead of racing the
      // partner into a duplicate send.
      try {
        await this.db.apiIdempotencyKey.update({
          where: {
            teamId_apiKeyId_key: { teamId, apiKeyId, key: idempotencyKey },
          },
          data: {
            responseBody: result as unknown as Prisma.InputJsonValue,
            responseStatus: 200,
            expiresAt: new Date(Date.now() + COMPLETED_TTL_MS),
          },
        });
      } catch (err) {
        // The row should always exist here (we just claimed it). If it's
        // gone the sweeper got aggressive; log + continue so the partner
        // still gets their successful response. A subsequent retry will
        // re-send because the cache is missing — acceptable tail case.
        this.logger.warn(
          `idempotency-key completion failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return result;
  }

  // ===========================================================================
  // CONTACT-KEYED CONVERSATION ACTIONS (mirror respond.io's n8n surface)
  //
  // respond.io exposes "Assign or unassign a Conversation" and "Open or close
  // a Conversation" keyed by contactId — the user picks a contact, the action
  // resolves their active conversation server-side. We thin-wrap our existing
  // conversation-keyed methods so the trip count from n8n → /v1 stays at 1.
  // ===========================================================================

  /**
   * Find the contact's most-recent conversation. Returns null when the
   * contact has none (e.g. brand-new manual contact that hasn't received a
   * message yet). Caller decides whether to 404 or auto-create.
   */
  private async resolveContactConversation(
    teamId: string,
    contactId: string,
  ): Promise<{ id: string } | null> {
    const conversation = await this.db.conversation.findFirst({
      where: { teamId, contactId },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true },
    });
    return conversation;
  }

  /** Resolve `contact: { id } | { phone }` to a contactId. Throws 404 on miss. */
  private async resolveContactIdentifier(
    teamId: string,
    contact: { id: string } | { phone: string },
  ): Promise<string> {
    if ("id" in contact) {
      const row = await this.db.contact.findFirst({
        where: { id: contact.id, teamId },
        select: { id: true },
      });
      if (!row) throw new NotFoundException({ error: "contact not found" });
      return row.id;
    }
    const phone = normalizePhoneE164(contact.phone);
    if (!phone) {
      throw new BadRequestException({
        error: "invalid_phone",
        detail: "phone must be a valid international number (e.g. +1 555 555 0100)",
      });
    }
    const row = await this.db.contact.findFirst({
      where: { teamId, phoneNumber: phone },
      select: { id: true },
    });
    if (!row) throw new NotFoundException({ error: "contact not found" });
    return row.id;
  }

  async assignByContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAssignInput,
  ) {
    const contactRow = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      select: { id: true },
    });
    if (!contactRow) throw new NotFoundException({ error: "contact not found" });
    const conv = await this.resolveContactConversation(teamId, contactId);
    if (!conv) {
      throw new NotFoundException({
        error: "no_conversation_for_contact",
        detail: "this contact has no conversations yet — start one with POST /v1/messages first",
      });
    }
    await this.assign(teamId, apiKeyId, conv.id, { assignedUserId: input.assignedUserId });
    return { conversationId: conv.id };
  }

  async setStatusByContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactStatusInput,
  ) {
    const contactRow = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      select: { id: true },
    });
    if (!contactRow) throw new NotFoundException({ error: "contact not found" });
    const conv = await this.resolveContactConversation(teamId, contactId);
    if (!conv) {
      throw new NotFoundException({
        error: "no_conversation_for_contact",
        detail: "this contact has no conversations yet",
      });
    }
    await this.setStatus(teamId, apiKeyId, conv.id, { status: input.status });
    return { conversationId: conv.id };
  }

  // ===========================================================================
  // TOP-LEVEL POST /v1/messages — n8n-shaped send
  //
  // respond.io's "Send Message" node takes either a contact id or a phone
  // and ONE call sends. We mirror that by resolving the contact server-side,
  // finding-or-opening a conversation, and routing to the existing
  // conversation-keyed `sendMessage`.
  //
  // Today only `text` is wired (mirrors what `sendMessage` supports). `media`
  // and `template` slots are accepted by the schema for forward-compat with
  // the planned media + template send paths but return 501 until those land.
  // ===========================================================================

  async sendTopLevelMessage(
    teamId: string,
    apiKeyId: string,
    input: ExternalTopLevelSendMessageInput,
    idempotencyKey?: string,
  ): Promise<{ ok: true; message: ExternalMessage }> {
    if (input.media) {
      // URL-based media send is the natural shape for n8n flows. The current
      // internal media-send pipeline (messages.service.ts:sendMedia) takes a
      // multipart File from multer + streams via a temp file — adapting it
      // to a URL fetch is a half-day of work (URL → buffer → blob upload →
      // Meta `/media`). Captured as its own follow-up; until then, partners
      // who need media via the API should use POST /v1/conversations/:id/messages
      // with the existing internal media path once it lands here.
      throw new BadRequestException({
        error: "media_not_yet_supported",
        detail:
          "URL-based media send via /v1/messages is not yet wired. Use the existing " +
          "media-send paths via the inbox UI for now; the URL → upload → send pipeline " +
          "is on the roadmap.",
      });
    }

    const contactId = await this.resolveContactIdentifier(teamId, input.contact);

    // Find an active (non-closed) conversation or create one. Mirrors the
    // inbound-ingest "one-contact-one-conversation" invariant — if the most
    // recent conversation is closed, we reopen it via the existing
    // conversation-status path so the audit trail captures the reopen.
    let conv = await this.db.conversation.findFirst({
      where: { teamId, contactId },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, status: true },
    });
    if (!conv) {
      const created = await this.db.conversation.create({
        data: {
          teamId,
          contactId,
          status: "pending",
          lastMessageAt: new Date(),
          lastMessagePreview: "",
        },
        select: { id: true, status: true },
      });
      conv = created;
    } else if (conv.status === "closed") {
      // Reopen via setStatus so the audit + analytics counters fire correctly.
      await this.setStatus(teamId, apiKeyId, conv.id, { status: "pending" });
    }

    // ---- Template send ---------------------------------------------------
    //
    // Templates DON'T need the 24h customer-service window — that's their
    // whole point (cold outbound + re-engagement). Resolve `(name, language)`
    // to a templateId, then delegate to the framework-agnostic
    // sendTemplateInternal which validates placeholder counts + sends via
    // Meta + writes the Message row + publishes message.sent.
    if (input.template) {
      const template = await this.db.messageTemplate.findFirst({
        where: { teamId, name: input.template.name, language: input.template.language },
        select: { id: true },
      });
      if (!template) {
        throw new NotFoundException({
          error: "template_not_found",
          detail: `template "${input.template.name}" (${input.template.language}) not in this team's catalog`,
        });
      }

      try {
        const result = await sendTemplateInternal({
          teamId,
          conversationId: conv.id,
          templateId: template.id,
          variables: input.template.variables,
          senderUserId: null,
          // Pass through so the message.sent event carries the api key —
          // outbound-webhook envelope's `sender.type === "api"` discriminator
          // then matches what an n8n flow expects.
          senderApiKeyId: apiKeyId,
          sentVia: `api/external/v1/messages/template/${apiKeyId}`,
        });
        const message = await this.db.message.findUniqueOrThrow({
          where: { id: result.messageId },
        });
        return { ok: true, message: toExternalMessage(message) };
      } catch (err) {
        if (err instanceof SendTemplateValidationError) {
          throw new BadRequestException({
            error: err.code,
            ...(err.detail ? { detail: err.detail } : {}),
          });
        }
        const normalized = normalizeMetaSendError(err);
        if (normalized) {
          throw new UnprocessableEntityException({
            error: normalized.code,
            message: normalized.message,
            detail: normalized.detail,
          });
        }
        throw err;
      }
    }

    // ---- Text send (default) ---------------------------------------------
    if (!input.text) {
      throw new BadRequestException({ error: "text required" });
    }

    const result = await this.sendMessage(
      teamId,
      apiKeyId,
      conv.id,
      {
        body: input.text,
        ...(input.reply_to_message_id ? { replyToMessageId: input.reply_to_message_id } : {}),
      },
      idempotencyKey,
    );
    return { ok: true, message: result.message };
  }

  // ===========================================================================
  // NOTES — existing
  // ===========================================================================

  async createNote(
    teamId: string,
    conversationId: string,
    input: ExternalNoteInput,
  ) {
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true },
    });
    if (!conv) throw new NotFoundException({ error: "conversation not found" });

    if (!input.authorUserId) {
      throw new BadRequestException({
        error: "authorUserId_required",
        detail:
          "Notes created via /v1 must specify `authorUserId` (a member of " +
          "the team). Create a dedicated service-account user for your " +
          "integration if no human author applies.",
      });
    }
    const u = await this.db.user.findFirst({
      where: { id: input.authorUserId, teamId },
      select: { id: true },
    });
    if (!u) {
      throw new BadRequestException({
        error: "authorUserId is not a member of this team",
      });
    }
    const authorUserId: string = u.id;

    const note = await this.db.internalNote.create({
      data: { conversationId, authorUserId, body: input.body },
    });

    const notePayload = {
      id: note.id,
      conversationId,
      authorUserId,
      body: input.body,
      timestamp: note.timestamp.toISOString(),
    };

    await this.bus.publish({
      type: "note.created",
      teamId,
      conversationId,
      note: notePayload,
    });

    return { note: notePayload };
  }

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
