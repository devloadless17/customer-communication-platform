import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { serializeCsv, parseCsv } from "@/lib/csv";
import type { ContactFieldChange } from "@ccp/shared/events/types";
import { getCountryFromPhone } from "@ccp/shared/utils";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import {
  countAudienceContacts,
  ensureDefaultStage,
  listContacts,
  lookupContacts,
  previewAudienceContacts,
  type ListContactsOpts,
} from "@/lib/queries";
import type { Contact } from "@ccp/shared/types";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import { runWithConcurrency } from "../common/concurrency";
import type {
  AudienceCountInput,
  AudiencePreviewInput,
  BulkContactsInput,
  CreateContactInput,
  ListContactsQueryInput,
  SetContactTagsInput,
  UpdateContactInput,
} from "./contacts.schemas";

// 5 MiB CSV is more than the 5000-row cap can ever fill (a 100-char row at
// 5000 rows is ~500 KB), and a pathological CSV with one row of 5M escaped
// chars pins the event loop hundreds of ms during parseCsv. 1 MiB is plenty
// for 5000 typical contact rows AND bounds the worst case to ~tens of ms.
const MAX_BYTES = 1 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_TEXT = 500;

export interface ImportResult {
  /** Rows we attempted to process (after header). */
  total: number;
  /** Newly-inserted rows. */
  created: number;
  /** Phone-number matches; left untouched. */
  skippedExisting: number;
  /** Rows we couldn't parse (missing phone, invalid format). */
  errors: Array<{ row: number; reason: string }>;
  /** Header columns that didn't match any known field — listed so the UI
   *  can prompt the user to add them as team fields. */
  unknownColumns: string[];
  /** Stage NAMES in the CSV that didn't match any team stage — those rows
   *  fell back to the default stage. Surfaced so the user can fix typos. */
  unknownStages?: string[];
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Paginated team-scoped list for the /contacts page. Filters mirror the
   * Next.js route exactly: search, fieldKey+fieldValue, source, tagIds,
   * window, stageId, cursor. Empty / unknown values are dropped silently.
   */
  list(teamId: string, query: ListContactsQueryInput) {
    const tagIds = query.tagIds
      ? query.tagIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
    const opts: ListContactsOpts = {
      search: query.search,
      cursor: query.cursor,
      fieldFilter:
        query.fieldKey && query.fieldValue
          ? { key: query.fieldKey, value: query.fieldValue }
          : undefined,
      source: query.source,
      tagIds,
      window: query.window,
      stageId: query.stageId,
    };
    return listContacts(teamId, opts);
  }

  /**
   * Manual contact create. Phone normalization + the team default-stage
   * fallback both live here so the controller stays declarative. Duplicate
   * phone (P2002) surfaces as 409 with a copy-paste-friendly message.
   *
   * Publishes `contact.created` AFTER the row commits so n8n flows on
   * "On Contact created" fire for human-driven creates. (Inbound + /v1
   * paths fire the same event from their own create sites.)
   */
  async create(
    teamId: string,
    userId: string,
    input: CreateContactInput,
  ): Promise<Contact> {
    const phone = normalizePhoneE164(input.phoneNumber);
    if (!phone) {
      throw new BadRequestException({
        error:
          "phoneNumber must be a valid international number (e.g. +1 555 555 0100)",
      });
    }

    // Name resolution mirrors the /v1 path: explicit `name` wins; else
    // derive from first + last; else fall back to phone.
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
    const countryCode = input.countryCode ?? getCountryFromPhone(phone);
    const customFields = normalizeCreateCustomFields(input.customFields ?? {});

    // Every contact lands in the team's default stage on create — lazy-init
    // covers older teams + admins who deleted the seeded default.
    const stageId = await ensureDefaultStage(teamId);

    let created;
    try {
      created = await this.db.contact.create({
        data: {
          teamId,
          // Manual contact-create from the UI is WhatsApp-only today (it
          // takes a phone number). Stamp the channel explicitly so the row
          // is self-describing; future channels would get their own create
          // path that stamps their own channel.
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
          // "manual" so the contacts list can show a "Added by you" badge
          // and filter manually-added apart from inbound rows.
          source: "manual",
        },
      });
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        // A soft-deleted contact still holds this phone's unique slot. Re-adding
        // the number should revive that tombstoned row (and its preserved
        // conversation) rather than 409 on a contact the agent can't even see.
        const revived = await this.reviveSoftDeletedByPhone(teamId, userId, phone, {
          name,
          firstName: trimmedFirst,
          lastName: trimmedLast,
          language,
          countryCode,
          email,
          location,
          customFields,
          stageId,
        });
        if (revived) return revived;
        throw new ConflictException({
          error: "a contact with this phone number already exists",
        });
      }
      throw err;
    }

    const contact: Contact = {
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
      customFields: normalizeStringMap(created.customFields),
      source: created.source,
      stageId: created.stageId,
      tagIds: [],
      createdAt: created.createdAt.toISOString(),
    };

    await this.bus.publish({
      type: "contact.created",
      teamId,
      contact,
      source: "manual",
      createdByUserId: userId,
    });

    return contact;
  }

  /**
   * Revive a soft-deleted contact occupying `phone`'s unique slot. Clears the
   * tombstone, overwrites the directory fields with the re-add payload, and
   * republishes `contact.created` — to every subscriber a revived contact is a
   * fresh appearance in the directory. Returns `null` when no soft-deleted row
   * exists (so the caller falls through to a real 409 for a live duplicate).
   *
   * The conversation + message history hanging off the row are untouched: this
   * is the manual-create mirror of the ingest upsert's `deletedAt: null` revive.
   */
  private async reviveSoftDeletedByPhone(
    teamId: string,
    userId: string,
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
    },
  ): Promise<Contact | null> {
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
      },
      include: { tags: { select: { id: true } } },
    });

    const contact: Contact = {
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
      tagIds: updated.tags.map((t) => t.id),
      createdAt: updated.createdAt.toISOString(),
    };

    await this.bus.publish({
      type: "contact.created",
      teamId,
      contact,
      source: "manual",
      createdByUserId: userId,
    });

    return contact;
  }

  /**
   * Partial update. Loads pre-image inside a transaction so the
   * customFields merge sees a consistent snapshot, then computes the
   * fieldChanges diff once for the published event so subscribers
   * (workflow-dispatch) don't have to re-read the bag.
   *
   * Caller (controller) is responsible for rejecting payloads that include
   * `phoneNumber` — that lives in the controller so the error message can
   * be specific (CLAUDE.md memory: contact phone is immutable).
   */
  async update(
    teamId: string,
    userId: string,
    contactId: string,
    input: UpdateContactInput,
  ): Promise<Contact> {
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

    // Validate stage ownership when set to a concrete id — done here (not in
    // the schema) because it requires a DB hit against the team scope.
    if (typeof stageId === "string") {
      const ok = await this.db.contactStage.findFirst({
        where: { id: stageId, teamId },
        select: { id: true },
      });
      if (!ok) {
        throw new BadRequestException({ error: "stage not found" });
      }
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

        // When firstName or lastName changes (and `name` wasn't in the same
        // patch), recompute `name` to keep the canonical display in lockstep —
        // mirrors the /v1 update path so both entry points converge.
        let derivedName: string | undefined;
        if (name === undefined && (firstName !== undefined || lastName !== undefined)) {
          const nextFirst = firstName !== undefined ? firstName ?? "" : existing.firstName ?? "";
          const nextLast = lastName !== undefined ? lastName ?? "" : existing.lastName ?? "";
          const combined = `${nextFirst}${nextFirst && nextLast ? " " : ""}${nextLast}`.trim();
          if (combined.length > 0) derivedName = combined.slice(0, MAX_TEXT);
        }

        // CAS on `version` — concurrent writers race to bump, exactly one
        // wins. The loser hits P2025 → caught below and rethrown as 409.
        // Without this, two PATCHes editing different fields would race
        // read-modify-write and silently lose one set of changes.
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
          include: { tags: { select: { id: true } } },
        });
        return { existing, updated };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        // CAS lost — a concurrent writer bumped version between our read
        // and write. Surface as 409 so the conflict-park UI in
        // contact-panel re-seeds and the agent can retry on fresh state.
        throw new ConflictException({
          error: "contact was modified by another writer, retry",
        });
      }
      throw err;
    }

    if (!result) throw new NotFoundException({ error: "contact not found" });
    const { existing, updated } = result;

    const tagIds = updated.tags.map((t) => t.id);
    const contact: Contact = {
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

    const oldCustom = normalizeStringMap(existing.customFields);
    const newCustom = normalizeStringMap(updated.customFields);
    const fieldChanges: ContactFieldChange[] = [];
    const allKeys = new Set([...Object.keys(oldCustom), ...Object.keys(newCustom)]);
    for (const key of allKeys) {
      const prev = oldCustom[key] ?? null;
      const next = newCustom[key] ?? null;
      if (prev !== next) fieldChanges.push({ key, previous: prev, next });
    }

    // Catch-all `contact.updated` for legacy subscribers (workflow dispatch,
    // socket fanout, audit, web cache revalidate).
    await this.bus.publish({
      type: "contact.updated",
      teamId,
      contact,
      previousStageId: existing.stageId,
      fieldChanges,
      changedByUserId: userId,
      workflowContact: workflowContactSnapshot(updated),
    });

    // Narrow first-class event for the n8n "On Contact Lifecycle updated"
    // trigger — only fire when the stage actually changed.
    if (existing.stageId !== updated.stageId) {
      await this.bus.publish({
        type: "contact.lifecycle_changed",
        teamId,
        contactId: updated.id,
        before: { stageId: existing.stageId },
        after: { stageId: updated.stageId },
        changedByUserId: userId,
      });
    }

    return contact;
  }

  /**
   * Hard-delete a contact and every row hanging off it. FK cascade clears
   * Conversation / Message / InternalNote / BroadcastRecipient / Tag joins;
   * blob unlinking is best-effort AFTER the DB commit — a stuck blob is
   * preferable to a half-committed delete.
   */
  async remove(teamId: string, userId: string, contactId: string): Promise<void> {
    // Soft-delete: tombstone the contact but PRESERVE its conversations,
    // messages, and media — removing a contact must NOT delete its chat. The
    // contact just leaves the directory; its thread stays in the inbox, and a
    // returning contact is re-activated by the ingest upsert.
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, teamId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    // updateMany on (id, teamId) — the findFirst above already proves
    // ownership, but keeping the tenant scope on the mutation itself means a
    // future refactor that drops the gate isn't one line from a cross-tenant
    // write (mirrors conversations.service.remove's defense-in-depth).
    await this.db.contact.updateMany({
      where: { id: contactId, teamId },
      data: { deletedAt: new Date() },
    });

    await this.bus.publish({
      type: "contact.deleted",
      teamId,
      contactId,
      // Conversations are preserved on soft-delete — none to splice from lists.
      conversationIds: [],
      deletedByUserId: userId,
    });
  }

  /**
   * Bulk delete OR bulk tag-add/tag-remove. One endpoint instead of three
   * because the auth + ownership filter + fan-out shape is identical; the
   * action discriminator lives in the input schema.
   *
   * Returns:
   *   { ok, count }            — delete
   *   { ok, count, action }    — tag op (no failures)
   *   { ok: false, count, action, failed } — tag op partial failure
   */
  async bulk(
    teamId: string,
    userId: string,
    input: BulkContactsInput,
  ): Promise<{
    ok: boolean;
    count: number;
    action?: BulkContactsInput["action"];
    failed?: number;
  }> {
    // Scope to actually-owned rows. Downstream calls already filter by
    // teamId, but doing it explicitly lets us emit accurate per-id events
    // and refuse client-supplied ids that aren't ours.
    const ownContacts = await this.db.contact.findMany({
      where: { teamId, id: { in: input.contactIds } },
      select: { id: true },
    });
    const ownedIds = ownContacts.map((c) => c.id);
    if (ownedIds.length === 0) {
      throw new NotFoundException({
        error: "no matching contacts in this team",
      });
    }

    if (input.action === "delete") {
      // Soft-delete: tombstone the contacts but PRESERVE conversations +
      // messages + media — a contact delete must not take its chat with it.
      await this.db.contact.updateMany({
        where: { teamId, id: { in: ownedIds }, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // Bounded fanout: 500 ids × 6 sequential subscribers via Promise.all
      // pinned the event loop and blocked unrelated requests on the single
      // VPS. 16-lane runner caps concurrent subscriber chains so the lane
      // serializes within itself; total wall time is roughly the same as
      // before, but the event loop stays responsive between lanes.
      await runWithConcurrency(ownedIds, 16, async (id) => {
        await this.bus.publish({
          type: "contact.deleted",
          teamId,
          contactId: id,
          // Conversations preserved on soft-delete — none to splice.
          conversationIds: [],
          deletedByUserId: userId,
        });
      });

      return { ok: true, count: ownedIds.length };
    }

    // ---- tag-add / tag-remove ----------------------------------------------
    const { action, tagId } = input;
    const tag = await this.db.tag.findFirst({ where: { id: tagId, teamId } });
    if (!tag) throw new NotFoundException({ error: "tag not found" });

    // Pre-snapshot so the per-contact tagChanges payload reflects the actual
    // membership delta, not the requested intent (a tag-add of a tag the
    // contact already had → no diff → no workflow trigger).
    const beforeRows = await this.db.contact.findMany({
      where: { teamId, id: { in: ownedIds } },
      select: { id: true, tags: { select: { id: true } } },
    });
    const hadTag = new Map(
      beforeRows.map((r) => [r.id, r.tags.some((t) => t.id === tagId)]),
    );

    // Single round-trip via the implicit `_ContactToTag` join table — was
    // N updates fired in parallel, which drained the connection pool on
    // any 100+ contact bulk-tag and blocked unrelated requests for ~1s.
    // ownedIds is already team-scoped (validated above), so a raw INSERT/
    // DELETE bounded by that list can't escape the tenant.
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
    // Bump version on every affected Contact so any in-flight per-contact
    // PATCH (especially `setTags` which uses `tags: { set: ... }`) CAS-
    // fails instead of silently overwriting the bulk's tag change.
    // The join-table INSERT/DELETE above does NOT touch Contact.version on
    // its own — we need a separate UPDATE to bump it.
    await this.db.$executeRaw`
      UPDATE "Contact"
      SET version = version + 1
      WHERE id = ANY(${ownedIds}::text[]) AND "teamId" = ${teamId}
    `;

    // Reload ALL ownedIds (not just succeeded) — emitting the current truth
    // for a failed update is harmless and keeps the socket payload simple.
    const updated = await this.db.contact.findMany({
      where: { teamId, id: { in: ownedIds } },
      include: { tags: { select: { id: true } } },
    });
    // Per-contact events for workflow + audit subscribers (granular
    // trigger dispatch). `suppressSocketFanout: true` skips the per-contact
    // socket emit — the coalesced `contact.bulk_updated` below carries
    // the whole id set in one frame instead.
    //
    // Bounded 16-lane fanout so the subscriber chain doesn't pin the event
    // loop on a 500-id bulk-tag. Per-subscriber try/catch in the bus
    // prevents one bad subscriber from breaking the rest.
    await runWithConcurrency(updated, 16, async (c) => {
        const tagIds = c.tags.map((t) => t.id);
        const payload: Contact = {
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
        const before = hadTag.get(c.id) ?? false;
        const now = tagIds.includes(tagId);
        const actuallyChanged = before !== now;
        const tagChanges = actuallyChanged
          ? action === "tag-add"
            ? { added: [tagId], removed: [] }
            : { added: [], removed: [tagId] }
          : { added: [], removed: [] };

        await this.bus.publish({
          type: "contact.updated",
          teamId,
          contact: payload,
          previousStageId: c.stageId,
          fieldChanges: [],
          tagChanges,
          changedByUserId: userId,
          workflowContact: workflowContactSnapshot(c),
          suppressSocketFanout: true,
        });

        // Narrow `contact.tag_changed` only when membership actually shifted.
        if (actuallyChanged) {
          await this.bus.publish({
            type: "contact.tag_changed",
            teamId,
            contactId: c.id,
            before: {
              tagIds:
                action === "tag-add"
                  ? tagIds.filter((id) => id !== tagId)
                  : [...tagIds, tagId],
            },
            after: { tagIds },
            added: tagChanges.added,
            removed: tagChanges.removed,
            changedByUserId: userId,
          });
        }
      });

    // One coalesced socket frame for the whole batch. At 25 agents online
    // a 500-contact bulk-tag drops from ~12,500 socket frames to 25.
    await this.bus.publish({
      type: "contact.bulk_updated",
      teamId,
      contactIds: ownedIds,
      changeKind: "tags",
      changedByUserId: userId,
    });

    // After the join-table rewrite, the operation is one statement — either
    // it succeeded for every owned id or it threw. No partial-failure path.
    return {
      ok: true,
      count: ownedIds.length,
      action,
    };
  }

  /**
   * CSV import. Dedupe rule: phone is the WhatsApp identity, so we use
   * `createMany({ skipDuplicates: true })` plus a pre-check against existing
   * phones — re-uploading the same file is a true no-op, and a webhook
   * landing the same number mid-import is implicitly counted as "skipped".
   *
   * Source is always forced to `manual` on import (the round-trip from
   * export→import flips inbound→manual on the second pass; only NEW rows
   * change, since matching phones are left untouched).
   */
  async importCsv(teamId: string, fileBytes: Buffer): Promise<ImportResult> {
    if (fileBytes.length > MAX_BYTES) {
      throw new BadRequestException({
        error: `file too large (max ${MAX_BYTES} bytes)`,
      });
    }
    const text = fileBytes.toString("utf-8");

    let parsed;
    try {
      parsed = parseCsv(text);
    } catch (e) {
      throw new BadRequestException({
        error: e instanceof Error ? e.message : "couldn't parse CSV",
      });
    }

    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      throw new BadRequestException({ error: "CSV is empty" });
    }
    if (parsed.rows.length > MAX_ROWS) {
      throw new BadRequestException({
        error: `too many rows (max ${MAX_ROWS}, got ${parsed.rows.length})`,
      });
    }

    const fieldDefs = await this.db.contactFieldDefinition.findMany({
      where: { teamId },
      select: { key: true, label: true },
    });
    const labelToKey = new Map(
      fieldDefs.map((d) => [d.label.toLowerCase(), d.key]),
    );

    type Mapping =
      | { kind: "phone" }
      | { kind: "name" }
      | { kind: "firstName" }
      | { kind: "lastName" }
      | { kind: "email" }
      | { kind: "location" }
      | { kind: "language" }
      | { kind: "country" }
      | { kind: "tags" }
      | { kind: "stage" }
      | { kind: "ignore" }
      | { kind: "field"; key: string };

    function classify(header: string): Mapping {
      const h = header.toLowerCase().trim();
      if (h === "phone_number" || h === "phone" || h === "phone number") {
        return { kind: "phone" };
      }
      if (h === "name" || h === "full name" || h === "full_name") {
        return { kind: "name" };
      }
      if (
        h === "first_name" ||
        h === "firstname" ||
        h === "first name" ||
        h === "given_name" ||
        h === "given name"
      ) {
        return { kind: "firstName" };
      }
      if (
        h === "last_name" ||
        h === "lastname" ||
        h === "last name" ||
        h === "surname" ||
        h === "family_name" ||
        h === "family name"
      ) {
        return { kind: "lastName" };
      }
      if (h === "email" || h === "e-mail" || h === "email_address") {
        return { kind: "email" };
      }
      if (h === "location" || h === "city") return { kind: "location" };
      if (h === "language") return { kind: "language" };
      if (h === "country" || h === "country_code" || h === "country code") {
        return { kind: "country" };
      }
      // Tags: one column, semicolon-separated tag NAMES (e.g. "VIP;Lead").
      // Unknown names are auto-created on import (same as the UI tag picker).
      if (h === "tags" || h === "tag") return { kind: "tags" };
      // Stage: one column, the stage NAME (e.g. "Stage 2"). Blank or unknown
      // → team default stage. Stages are never auto-created (curated pipeline).
      if (h === "stage" || h === "stage_name" || h === "stage name") {
        return { kind: "stage" };
      }
      // `source` is intentionally ignored — imported rows are always 'manual'.
      // `id` from a round-trip export is meaningless on import.
      if (h === "source" || h === "id") return { kind: "ignore" };
      const key = labelToKey.get(h);
      if (key) return { kind: "field", key };
      return { kind: "ignore" };
    }

    const headerMap = new Map(parsed.headers.map((h) => [h, classify(h)]));
    const unknownColumns: string[] = [];
    for (const [header, mapping] of headerMap) {
      if (
        mapping.kind === "ignore" &&
        header.toLowerCase() !== "source" &&
        header.toLowerCase() !== "id"
      ) {
        unknownColumns.push(header);
      }
    }

    const errors: ImportResult["errors"] = [];

    interface PendingRow {
      rowNumber: number;
      phoneNumber: string;
      name: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      location: string | null;
      language: string | null;
      countryCode: string | null;
      customFields: Record<string, string>;
      /** Tag NAMES from the CSV cell (de-duped, capped). Resolved to ids
       *  (get-or-create) after the create batch. */
      tagNames: string[];
      /** Raw stage NAME from the CSV (empty = use default). */
      stageName: string;
    }
    const pending: PendingRow[] = [];

    for (let i = 0; i < parsed.rows.length; i++) {
      const rowNumber = i + 2; // 1-indexed from header, matches Excel row numbers
      const row = parsed.rows[i] ?? {};
      let phoneRaw: string | undefined;
      let name = "";
      let firstName = "";
      let lastName = "";
      let email = "";
      let location = "";
      let language = "";
      let country = "";
      let tagsRaw = "";
      let stageRaw = "";
      const customFields: Record<string, string> = {};

      for (const [header, value] of Object.entries(row)) {
        const mapping = headerMap.get(header);
        if (!mapping) continue;
        switch (mapping.kind) {
          case "phone":
            phoneRaw = value;
            break;
          case "name":
            name = value.slice(0, MAX_TEXT);
            break;
          case "firstName":
            firstName = value.slice(0, MAX_TEXT);
            break;
          case "lastName":
            lastName = value.slice(0, MAX_TEXT);
            break;
          case "email":
            email = value.slice(0, MAX_TEXT);
            break;
          case "location":
            location = value.slice(0, MAX_TEXT);
            break;
          case "language":
            language = value.slice(0, MAX_TEXT);
            break;
          case "country":
            country = value.slice(0, MAX_TEXT);
            break;
          case "tags":
            tagsRaw = value.slice(0, MAX_TEXT);
            break;
          case "stage":
            stageRaw = value.slice(0, MAX_TEXT);
            break;
          case "field":
            customFields[mapping.key] = value.slice(0, MAX_TEXT);
            break;
          case "ignore":
            break;
        }
      }

      if (!phoneRaw) {
        errors.push({ row: rowNumber, reason: "missing phone number" });
        continue;
      }
      const phone = normalizePhoneE164(phoneRaw);
      if (!phone) {
        errors.push({ row: rowNumber, reason: `invalid phone "${phoneRaw}"` });
        continue;
      }

      // Synthesize the display `name` from first/last when the row has them
      // but no explicit Name column. Mirrors the create-contact server behavior
      // so a CSV of "first_name + last_name" only doesn't end up as the bare
      // phone number for every contact.
      let displayName = name.trim();
      if (!displayName) {
        const composed = `${firstName.trim()} ${lastName.trim()}`.trim();
        if (composed) displayName = composed;
      }

      // Country must be a 2-letter ISO code. Anything else gets dropped
      // silently — same shape as the Zod schema for the JSON API; the
      // importer doesn't surface row-level validation for this one column
      // because the phone-derived fallback will still produce a sane value.
      const countryNormalized = country.trim().toUpperCase();
      const countryValid =
        countryNormalized.length === 2 && /^[A-Z]{2}$/.test(countryNormalized);

      // Tags: split on ";", trim, drop blanks, de-dupe (case-insensitive on
      // the key but keep first-seen casing for create), cap at 25/row so a
      // pathological cell can't blow up the tag catalog.
      const seenTagKeys = new Set<string>();
      const tagNames: string[] = [];
      for (const raw of tagsRaw.split(";")) {
        const t = raw.trim().slice(0, MAX_TEXT);
        if (!t) continue;
        const key = t.toLowerCase();
        if (seenTagKeys.has(key)) continue;
        seenTagKeys.add(key);
        tagNames.push(t);
        if (tagNames.length >= 25) break;
      }

      pending.push({
        rowNumber,
        phoneNumber: phone,
        name: displayName || phone,
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        email: email.trim() || null,
        location: location.trim() || null,
        language: language.trim() || null,
        countryCode: countryValid ? countryNormalized : null,
        customFields,
        tagNames,
        stageName: stageRaw.trim(),
      });
    }

    const existing = await this.db.contact.findMany({
      where: { teamId, phoneNumber: { in: pending.map((p) => p.phoneNumber) } },
      select: { phoneNumber: true },
    });
    const existingSet = new Set(existing.map((e) => e.phoneNumber));

    const toCreate = pending.filter((p) => !existingSet.has(p.phoneNumber));
    const skippedExisting = pending.length - toCreate.length;

    let created = 0;
    const unknownStages = new Set<string>();
    if (toCreate.length > 0) {
      // Default stage looked up once for the whole batch — rows with no (or an
      // unknown) stage land here.
      const defaultStageId = await ensureDefaultStage(teamId);

      // Resolve the DISTINCT stage names present in the CSV to ids in one
      // query (stages are a small curated set). Case-insensitive match;
      // unknown names fall back to default and are reported in the summary.
      // Stages are NEVER auto-created — a typo shouldn't multiply the pipeline.
      const stageNameKeys = new Set(
        toCreate
          .map((p) => p.stageName)
          .filter((s) => s.length > 0)
          .map((s) => s.toLowerCase()),
      );
      const stageIdByNameKey = new Map<string, string>();
      if (stageNameKeys.size > 0) {
        const stageRows = await this.db.contactStage.findMany({
          where: { teamId },
          select: { id: true, name: true },
        });
        for (const s of stageRows) {
          stageIdByNameKey.set(s.name.toLowerCase(), s.id);
        }
      }
      const resolveStage = (name: string): string => {
        if (!name) return defaultStageId;
        const hit = stageIdByNameKey.get(name.toLowerCase());
        if (hit) return hit;
        unknownStages.add(name);
        return defaultStageId;
      };

      // createMany is fast but can't connect M2M tags, so do it in two steps:
      // bulk-insert the rows, then bulk-link tags by reading the created ids
      // back by phone. skipDuplicates guards the (teamId, phone) unique against
      // a concurrent inbound that created the same contact mid-import.
      const result = await this.db.contact.createMany({
        data: toCreate.map((p) => ({
          teamId,
          // CSV import is WhatsApp-only (phone is the natural key for each
          // row). Channel stamped explicitly so every imported contact is
          // self-describing in cross-channel queries.
          identityChannel: "whatsapp",
          phoneNumber: p.phoneNumber,
          name: p.name,
          firstName: p.firstName ?? undefined,
          lastName: p.lastName ?? undefined,
          email: p.email ?? undefined,
          location: p.location ?? undefined,
          language: p.language ?? undefined,
          // Falls back to `getCountryFromPhone(phone)` server-side when null;
          // we only set when the CSV provided a valid ISO code so a bogus
          // header value doesn't overwrite the libphonenumber-derived one.
          countryCode:
            p.countryCode ?? getCountryFromPhone(p.phoneNumber) ?? undefined,
          customFields: p.customFields,
          stageId: resolveStage(p.stageName),
          source: "manual",
        })),
        skipDuplicates: true,
      });
      created = result.count;

      // ---- Tag links --------------------------------------------------------
      // Only the rows that actually carry tags. Resolve every distinct name to
      // an id via get-or-create (auto-create unknown tags, slate color — same
      // as the UI), then one bulk INSERT into the implicit M2M join table.
      const rowsWithTags = toCreate.filter((p) => p.tagNames.length > 0);
      if (rowsWithTags.length > 0) {
        const distinctTagNames = new Map<string, string>(); // key → first-seen name
        for (const p of rowsWithTags) {
          for (const t of p.tagNames) {
            const k = t.toLowerCase();
            if (!distinctTagNames.has(k)) distinctTagNames.set(k, t);
          }
        }
        const tagIdByNameKey = await this.resolveTagIdsByName(
          teamId,
          [...distinctTagNames.values()],
        );

        // Map phone → created contact id (createMany returns no ids). Scope to
        // the phones we just tried to create.
        const createdRows = await this.db.contact.findMany({
          where: {
            teamId,
            phoneNumber: { in: rowsWithTags.map((p) => p.phoneNumber) },
          },
          select: { id: true, phoneNumber: true },
        });
        const idByPhone = new Map(createdRows.map((r) => [r.phoneNumber, r.id]));

        // Build the (contactId, tagId) pairs, de-duped.
        const pairs: Array<{ contactId: string; tagId: string }> = [];
        const seenPair = new Set<string>();
        for (const p of rowsWithTags) {
          const contactId = idByPhone.get(p.phoneNumber);
          if (!contactId) continue; // lost to a concurrent create — skip
          for (const t of p.tagNames) {
            const tagId = tagIdByNameKey.get(t.toLowerCase());
            if (!tagId) continue;
            const pk = `${contactId}:${tagId}`;
            if (seenPair.has(pk)) continue;
            seenPair.add(pk);
            pairs.push({ contactId, tagId });
          }
        }
        if (pairs.length > 0) {
          // Single bulk insert into the implicit join table, mirroring the
          // bulk tag-add path. ON CONFLICT DO NOTHING so a re-import / racing
          // link is a no-op. Prisma's implicit M2M table is "_ContactToTag"
          // with A=Contact.id, B=Tag.id.
          const contactIds = pairs.map((p) => p.contactId);
          const tagIds = pairs.map((p) => p.tagId);
          await this.db.$executeRaw`
            INSERT INTO "_ContactToTag" ("A", "B")
            SELECT * FROM UNNEST(${contactIds}::text[], ${tagIds}::text[])
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }

    return {
      total: parsed.rows.length,
      created,
      skippedExisting: skippedExisting + (toCreate.length - created),
      errors,
      unknownColumns,
      ...(unknownStages.size > 0
        ? { unknownStages: [...unknownStages].sort() }
        : {}),
    };
  }

  /**
   * Get-or-create tags by NAME for CSV import. Returns a map keyed by the
   * LOWERCASED name → tag id. Existing tags are reused (case-insensitive on
   * the unique (teamId, name)); missing ones are created with the default
   * color, mirroring the UI tag picker's "create on the fly" behavior. One
   * `catalog_changed` event after any creates so open clients refresh.
   */
  private async resolveTagIdsByName(
    teamId: string,
    names: string[],
  ): Promise<Map<string, string>> {
    const byKey = new Map<string, string>();
    if (names.length === 0) return byKey;

    const existing = await this.db.tag.findMany({
      where: { teamId },
      select: { id: true, name: true },
    });
    for (const t of existing) byKey.set(t.name.toLowerCase(), t.id);

    const toCreate = names.filter((n) => !byKey.has(n.toLowerCase()));
    let createdAny = false;
    for (const name of toCreate) {
      // Per-name create (not createMany) so a P2002 from a concurrent create
      // of the same name is caught and the winner reused — keeps the import
      // resilient to a teammate adding the same tag mid-run.
      try {
        const created = await this.db.tag.create({
          data: { teamId, name, color: "slate" },
          select: { id: true },
        });
        byKey.set(name.toLowerCase(), created.id);
        createdAny = true;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          const winner = await this.db.tag.findFirst({
            where: { teamId, name },
            select: { id: true },
          });
          if (winner) byKey.set(name.toLowerCase(), winner.id);
        } else {
          throw err;
        }
      }
    }
    if (createdAny) {
      await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "tags" });
    }
    return byKey;
  }

  // -------------------------------------------------------------------------
  // Pre-existing methods (small endpoints). Untouched by this port.
  // -------------------------------------------------------------------------

  /** Lightweight id→display lookup for picker chips. Cross-team ids dropped. */
  lookup(teamId: string, ids: string[]) {
    return lookupContacts(teamId, ids);
  }

  /** Live recipient count for an audience selection. */
  countAudience(teamId: string, input: AudienceCountInput): Promise<number> {
    return countAudienceContacts(teamId, input);
  }

  /** First N matches for an audience selection (for the preview list). */
  previewAudience(teamId: string, input: AudiencePreviewInput) {
    const { limit, ...audience } = input;
    return previewAudienceContacts(teamId, audience, limit);
  }

  /**
   * Replace the full tag set on a contact. Diff the previous + next sets,
   * filter cross-team tag ids, then publish one `contact.updated` with
   * `tagChanges` populated — workflow-dispatch fans out one
   * `contact_tag_updated` trigger per added/removed id.
   */
  async setTags(
    teamId: string,
    actorUserId: string,
    contactId: string,
    input: SetContactTagsInput,
  ): Promise<{ tagIds: string[] }> {
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      include: { tags: { select: { id: true } } },
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    // Cross-team defense: only keep tag ids that actually live on this team.
    const validIds =
      input.tagIds.length === 0
        ? []
        : (
            await this.db.tag.findMany({
              where: { teamId, id: { in: input.tagIds } },
              select: { id: true },
            })
          ).map((t) => t.id);

    const previousIds = new Set(contact.tags.map((t) => t.id));
    const nextIds = new Set(validIds);
    const added = validIds.filter((tagId) => !previousIds.has(tagId));
    const removed = [...previousIds].filter((tagId) => !nextIds.has(tagId));

    let updated;
    try {
      updated = await this.db.contact.update({
        where: { id: contactId, teamId, version: contact.version },
        data: {
          tags: { set: validIds.map((tagId) => ({ id: tagId })) },
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

    const payload: Contact = {
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
      tagIds: validIds,
      createdAt: updated.createdAt.toISOString(),
    };

    await this.bus.publish({
      type: "contact.updated",
      teamId,
      contact: payload,
      previousStageId: contact.stageId,
      fieldChanges: [],
      tagChanges: { added, removed },
      changedByUserId: actorUserId,
      workflowContact: workflowContactSnapshot(updated),
    });

    if (added.length > 0 || removed.length > 0) {
      await this.bus.publish({
        type: "contact.tag_changed",
        teamId,
        contactId: updated.id,
        before: { tagIds: [...previousIds] },
        after: { tagIds: validIds },
        added,
        removed,
        changedByUserId: actorUserId,
      });
    }

    return { tagIds: validIds };
  }

  /**
   * Export every contact as CSV. Columns: base + per-team-field + per-one-off
   * key. Self-describing for re-import. No pagination — contact set is
   * usage-capped at the team level and a single SELECT keeps the response
   * deterministic.
   */
  async exportCsv(teamId: string): Promise<{ csv: string; filename: string; truncated: boolean }> {
    // Hard cap. Without it a tenant with 200k contacts triggers a single
    // SELECT that loads every row + serializes in one shot — multi-MB
    // JSON response on the wire AND a multi-MB CSV string serialized
    // synchronously on the event loop. 50k rows is plenty for the bulk of
    // teams; over that, the operator should filter the audience first or
    // we should ship a true streaming export.
    const EXPORT_HARD_CAP = 50_000;
    const [contacts, fieldDefs, stages] = await Promise.all([
      this.db.contact.findMany({
        // Export is a directory dump — soft-deleted contacts stay out.
        where: { teamId, deletedAt: null },
        select: {
          phoneNumber: true,
          name: true,
          firstName: true,
          lastName: true,
          email: true,
          location: true,
          language: true,
          countryCode: true,
          source: true,
          stageId: true,
          // Tag NAMES (not ids) so the CSV round-trips on import. The implicit
          // M2M is small per contact; selecting names here avoids a second
          // catalog join per row.
          tags: { select: { name: true } },
          customFields: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: EXPORT_HARD_CAP + 1,
      }),
      this.db.contactFieldDefinition.findMany({
        where: { teamId },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      }),
      this.db.contactStage.findMany({
        where: { teamId },
        select: { id: true, name: true },
      }),
    ]);
    const stageNameById = new Map(stages.map((s) => [s.id, s.name]));

    // Collect per-contact one-off keys we encounter. Render after team-wide
    // columns so the schema-defined fields stay in stable order.
    const teamKeys = new Set(fieldDefs.map((d) => d.key));
    const oneOffKeys = new Set<string>();
    for (const c of contacts) {
      if (
        c.customFields &&
        typeof c.customFields === "object" &&
        !Array.isArray(c.customFields)
      ) {
        for (const k of Object.keys(c.customFields as Record<string, unknown>)) {
          if (!teamKeys.has(k)) oneOffKeys.add(k);
        }
      }
    }

    const baseColumns = [
      "phone_number",
      "name",
      "first_name",
      "last_name",
      "email",
      "location",
      "language",
      "country",
      "tags",
      "stage",
      "source",
    ];
    const teamColumns = fieldDefs.map((d) => d.label);
    const oneOffColumns = Array.from(oneOffKeys).sort();
    const columns = [...baseColumns, ...teamColumns, ...oneOffColumns];

    const rows = contacts.map((c) => {
      const cf =
        c.customFields &&
        typeof c.customFields === "object" &&
        !Array.isArray(c.customFields)
          ? (c.customFields as Record<string, unknown>)
          : {};
      const row: Record<string, string> = {
        phone_number: c.phoneNumber ?? "",
        name: c.name,
        first_name: c.firstName ?? "",
        last_name: c.lastName ?? "",
        email: c.email ?? "",
        location: c.location ?? "",
        language: c.language ?? "",
        country: c.countryCode ?? "",
        // Semicolon-separated tag names — round-trips with the import parser.
        tags: c.tags.map((t) => t.name).join(";"),
        stage: (c.stageId && stageNameById.get(c.stageId)) || "",
        source: c.source,
      };
      for (const def of fieldDefs) {
        const v = cf[def.key];
        row[def.label] = typeof v === "string" ? v : "";
      }
      for (const key of oneOffColumns) {
        const v = cf[key];
        row[key] = typeof v === "string" ? v : "";
      }
      return row;
    });

    const truncated = contacts.length > 50_000;
    const cappedRows = truncated ? rows.slice(0, 50_000) : rows;
    const csv = serializeCsv(columns, cappedRows);
    // Date-stamp so multiple exports in a day don't overwrite each other.
    const stamp = new Date().toISOString().slice(0, 10);
    return { csv, filename: `contacts-${stamp}.csv`, truncated };
  }

  /**
   * Total number of contacts in the team. Used by the broadcast wizard's
   * "All contacts" card — the existing `countAudience` endpoint returns 0
   * when called with no filters, by design (it has no "all" mode), so a
   * dedicated count keeps "all" semantics from leaking into the audience
   * union logic.
   */
  async countAll(teamId: string): Promise<number> {
    return this.db.contact.count({ where: { teamId, deletedAt: null } });
  }

  /**
   * Import template — header row + ONE clearly-fake example row that documents
   * the expected formats inline (phone WITH country code, tags semicolon-
   * separated, stage by name). Built from the same recognized headers as the
   * importer plus the team's custom-field labels, so a fresh download always
   * matches the current schema.
   *
   * Why an example row now (was header-only): the #1 import mistake is the
   * phone format (missing country code, or a local number). A visible example
   * is the clearest possible guidance. The example contact ("John Example",
   * `15551234567`) is obvious filler the user overwrites; if imported as-is it
   * creates one easily-deleted contact — a far smaller cost than a batch of
   * unreachable local numbers. Same approach Respond.io / HubSpot templates use.
   */
  async importTemplateCsv(teamId: string): Promise<{ csv: string; filename: string }> {
    const fieldDefs = await this.db.contactFieldDefinition.findMany({
      where: { teamId, isVisible: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { label: true },
    });
    const baseColumns = [
      "phone_number",
      "name",
      "first_name",
      "last_name",
      "email",
      "location",
      "language",
      "country",
      "tags",
      "stage",
    ];
    const customColumns = fieldDefs.map((d) => d.label);
    const columns = [...baseColumns, ...customColumns];

    // One example row. phone_number is full international WITH country code and
    // NO "+" (a "+" works too — the importer strips it — but showing it without
    // is the safe Excel-friendly form). Tags are ";"-separated; stage is a name.
    const example: Record<string, string> = {
      phone_number: "15551234567",
      name: "John Example",
      first_name: "John",
      last_name: "Example",
      email: "john@example.com",
      location: "New York",
      language: "en",
      country: "US",
      tags: "VIP;Lead",
      stage: "Stage 1",
    };
    const exampleRow = columns.map((c) => example[c] ?? "");

    const esc = (c: string) =>
      /[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
    // CRLF line endings — Excel-friendly, matches the export path.
    const csv =
      columns.map(esc).join(",") + "\r\n" + exampleRow.map(esc).join(",") + "\r\n";
    return { csv, filename: "contacts-template.csv" };
  }
}

// ---------------------------------------------------------------------------
// Helpers
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
