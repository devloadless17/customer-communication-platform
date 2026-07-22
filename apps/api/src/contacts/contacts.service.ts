import { normalizeStringMap } from "@/lib/normalize-string-map";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import type { ContactFieldChange } from "@ccp/shared/events/types";
import { getCountryFromPhone } from "@ccp/shared/utils";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import {
  countAudienceContacts,
  directoryContactWhere,
  ensureDefaultStage,
  listContacts,
  listPeople,
  lookupContacts,
  previewAudienceContacts,
  resolveContactIdsByFilter,
  toContactWire,
  type ListContactsOpts,
} from "@/lib/queries";
import type { Contact } from "@ccp/shared/types";
import { isPhoneChannel } from "@ccp/shared/providers/capabilities";
import { enrichSocialContactNames } from "@/lib/providers/ingest";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import { runWithConcurrency } from "../common/concurrency";
import {
  MAX_FILTER_MATCH,
  MAX_TOTAL_FIELDS,
  type AudienceCountInput,
  type AudiencePreviewInput,
  type BulkContactsInput,
  type BulkFilterInput,
  type CreateContactInput,
  type ListContactsQueryInput,
  type SetContactTagsInput,
  type UpdateContactInput,
} from "./contacts.schemas";

const MAX_TEXT = 500;

// Built-in (non-customField) Contact columns whose changes are surfaced as
// ContactFieldChange entries on contact.updated (so the outbound webhook's
// fieldChanges shows a rename / email edit etc.). Workflow-dispatch's
// contact_field_updated trigger MUST exclude these keys (stays custom-only).
const BUILT_IN_KEYS = [
  "name",
  "firstName",
  "lastName",
  "email",
  "location",
  "language",
  "countryCode",
] as const;

export interface ImportResult {
  /** Rows we attempted to process (after header). */
  total: number;
  /** Newly-inserted rows. */
  created: number;
  /** Soft-deleted rows the import brought back (un-tombstoned). Counted
   *  separately from `created` so the UI can say "X new, Y restored". */
  revived: number;
  /** Phone-number matches (active rows); left untouched. */
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
  list(workspaceId: string, query: ListContactsQueryInput) {
    const tagIds = query.tagIds
      ? query.tagIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
    const opts: ListContactsOpts = {
      search: query.search,
      cursor: query.cursor,
      page: query.page,
      take: query.take,
      fieldFilter:
        query.fieldKey && query.fieldValue
          ? { key: query.fieldKey, value: query.fieldValue }
          : undefined,
      source: query.source,
      tagIds,
      channel: query.channel,
      window: query.window,
      stageId: query.stageId,
      groupByPerson: query.groupByPerson,
    };
    // "Group by person" rolls the list up to one row per unified Customer;
    // otherwise the default per-channel-contact list.
    return query.groupByPerson ? listPeople(workspaceId, opts) : listContacts(workspaceId, opts);
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
    workspaceId: string,
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
    const stageId = await ensureDefaultStage(workspaceId);

    let created;
    try {
      created = await this.db.contact.create({
        data: {
          workspaceId,
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
        const revived = await this.reviveSoftDeletedByPhone(workspaceId, userId, phone, {
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

    const contact: Contact = toContactWire(created, { tagIds: [] });

    await this.bus.publish({
      type: "contact.created",
      workspaceId,
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
    workspaceId: string,
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
      // whatsapp-scoped: the phone unique slot being revived is WhatsApp-only.
      where: { workspaceId, phoneNumber: phone, identityChannel: "whatsapp", deletedAt: { not: null } },
      select: { id: true },
    });
    if (!existing) return null;

    // CAS on deletedAt: a concurrent revive (e.g. an inbound WhatsApp webhook
    // landing on the same phone) may have flipped this row live between the
    // findFirst above and here. Guard the revive so we don't clobber that
    // writer's directory fields with this manual payload — mirrors the hardened
    // import-revive path. If we lose the race, return the live row untouched.
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

    const row = await this.db.contact.findFirst({
      where: { id: existing.id },
      include: { tags: { select: { id: true } } },
    });
    if (!row) return null;
    const contact: Contact = toContactWire(row, {
      tagIds: row.tags.map((t) => t.id),
    });

    // Only announce a (re)creation when THIS call performed the revive; if a
    // concurrent writer won, the row is already live and they published it.
    if (revived.count > 0) {
      await this.bus.publish({
        type: "contact.created",
        workspaceId,
        contact,
        source: "manual",
        createdByUserId: userId,
      });
    }

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
    workspaceId: string,
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

    let result;
    try {
      result = await this.db.$transaction(async (tx) => {
        const existing = await tx.contact.findFirst({
          where: { id: contactId, workspaceId, deletedAt: null },
          include: { tags: { select: { id: true } } },
        });
        if (!existing) return null;

        // Validate stage ownership INSIDE the tx (was outside → TOCTOU with a
        // concurrent stage delete: the check could pass, the stage be deleted,
        // then this update set a dangling stageId / hit a raw FK error). Same
        // tx as the update narrows the window; the FK constraint is the
        // backstop. Requires a team-scoped DB hit, so it can't live in the
        // zod schema.
        if (typeof stageId === "string") {
          const ok = await tx.contactStage.findFirst({
            where: { id: stageId, workspaceId },
            select: { id: true },
          });
          if (!ok) {
            throw new BadRequestException({ error: "stage not found" });
          }
        }

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
    const contact: Contact = toContactWire(updated, { tagIds });

    const oldCustom = normalizeStringMap(existing.customFields);
    const newCustom = normalizeStringMap(updated.customFields);
    const fieldChanges: ContactFieldChange[] = [];
    const allKeys = new Set([...Object.keys(oldCustom), ...Object.keys(newCustom)]);
    for (const key of allKeys) {
      const prev = oldCustom[key] ?? null;
      const next = newCustom[key] ?? null;
      if (prev !== next) fieldChanges.push({ key, previous: prev, next });
    }
    // Also surface changed BUILT-IN columns (name/firstName/.../countryCode) as
    // fieldChanges so the outbound webhook's `fieldChanges` reflects a renamed
    // contact, not just custom-field edits. Pre/post images are full rows, so
    // we diff the columns directly. NOTE: workflow-dispatch's
    // contact_field_updated fan-out deliberately SKIPS these keys (it stays
    // custom-fields-only) — that guard lives on the dispatch side, keyed off
    // the same BUILT_IN_KEYS list.
    for (const key of BUILT_IN_KEYS) {
      const prev = (existing[key] as string | null) ?? null;
      const next = (updated[key] as string | null) ?? null;
      if (prev !== next) fieldChanges.push({ key, previous: prev, next });
    }

    // Catch-all `contact.updated` for legacy subscribers (workflow dispatch,
    // socket fanout, audit, web cache revalidate).
    await this.bus.publish({
      type: "contact.updated",
      workspaceId,
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
        workspaceId,
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
  async remove(workspaceId: string, userId: string, contactId: string): Promise<void> {
    // Soft-delete: tombstone the contact but PRESERVE its conversations,
    // messages, and media — removing a contact must NOT delete its chat. The
    // contact just leaves the directory; its thread stays in the inbox, and a
    // returning contact is re-activated by the ingest upsert.
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    // updateMany on (id, workspaceId) — the findFirst above already proves
    // ownership, but keeping the tenant scope on the mutation itself means a
    // future refactor that drops the gate isn't one line from a cross-tenant
    // write (mirrors conversations.service.remove's defense-in-depth).
    await this.db.contact.updateMany({
      where: { id: contactId, workspaceId },
      data: { deletedAt: new Date() },
    });

    await this.bus.publish({
      type: "contact.deleted",
      workspaceId,
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
   * Addressing: `delete` and the default (`mode: "ids"`) tag op carry an
   * explicit `contactIds` array. The `mode: "filter"` tag op instead carries
   * the active contacts-list FILTER and the server expands it to every
   * matching id ("select all N matching"). Delete is filter-mode-EXCLUDED by
   * schema (capped to the loaded selection — a deliberate safety limit).
   *
   * Returns:
   *   { ok, count }                    — delete
   *   { ok, count, action }            — tag op
   *   { ok, count, action, capped }    — filter-mode tag op that hit the cap
   */
  async bulk(
    workspaceId: string,
    userId: string,
    input: BulkContactsInput,
  ): Promise<{
    ok: boolean;
    count: number;
    action?: BulkContactsInput["action"];
    failed?: number;
    capped?: boolean;
  }> {
    // Resolve the target id set. Two addressing modes converge here so the rest
    // of the method is mode-agnostic:
    //   - filter mode (tag ops only): expand the active list filter to every
    //     matching LIVE id server-side, capped at MAX_FILTER_MATCH. The
    //     where-builder is the SAME one the list + count use, so the op targets
    //     exactly what the user sees. No re-validation needed — these ids come
    //     straight from a team-scoped, deletedAt-IS-NULL query.
    //   - id mode (delete + default tag op): scope the client-supplied ids to
    //     actually-owned, LIVE rows so we emit accurate per-id events and
    //     refuse ids that aren't ours.
    let ownedIds: string[];
    let capped = false;
    if (input.action !== "delete" && input.mode === "filter") {
      const resolved = await resolveContactIdsByFilter(
        workspaceId,
        this.filterToListOpts(input.filter),
        MAX_FILTER_MATCH,
      );
      ownedIds = resolved.ids;
      capped = resolved.capped;
    } else {
      const ownContacts = await this.db.contact.findMany({
        where: { workspaceId, id: { in: input.contactIds }, deletedAt: null },
        select: { id: true },
      });
      ownedIds = ownContacts.map((c) => c.id);
    }
    if (ownedIds.length === 0) {
      throw new NotFoundException({
        error: "no matching contacts in this team",
      });
    }

    if (input.action === "delete") {
      // Soft-delete: tombstone the contacts but PRESERVE conversations +
      // messages + media — a contact delete must not take its chat with it.
      await this.db.contact.updateMany({
        where: { workspaceId, id: { in: ownedIds }, deletedAt: null },
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
          workspaceId,
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
    const tag = await this.db.tag.findFirst({ where: { id: tagId, workspaceId } });
    if (!tag) throw new NotFoundException({ error: "tag not found" });

    // Pre-snapshot so the per-contact tagChanges payload reflects the actual
    // membership delta, not the requested intent (a tag-add of a tag the
    // contact already had → no diff → no workflow trigger).
    const beforeRows = await this.db.contact.findMany({
      where: { workspaceId, id: { in: ownedIds } },
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
        WHERE id = ANY(${ownedIds}::text[]) AND "workspaceId" = ${workspaceId}
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
      WHERE id = ANY(${ownedIds}::text[]) AND "workspaceId" = ${workspaceId}
    `;

    // Reload ALL ownedIds (not just succeeded) — emitting the current truth
    // for a failed update is harmless and keeps the socket payload simple.
    //
    // Reloaded and fanned out in CHUNKS. The comments below reason about "a
    // 500-id bulk-tag", which is the explicit-id cap (MAX_BULK_IDS) — but
    // filter mode ("select all N matching") caps at MAX_FILTER_MATCH = 50_000,
    // and this reload pulled every one of those as a FULL Contact row,
    // customFields JSONB included, into a single Prisma result. Several
    // hundred MB of heap in one request against a 2GB container, before the
    // fanout below adds up to two OutboundEvent INSERTs per contact on top.
    // Chunking does identical total work — every contact still gets its
    // per-contact events, because workflow triggers and the audit trail depend
    // on them — but the resident set stays bounded by the chunk, not by the
    // tenant's contact count.
    const RELOAD_CHUNK = 1_000;
    for (let i = 0; i < ownedIds.length; i += RELOAD_CHUNK) {
      const chunkIds = ownedIds.slice(i, i + RELOAD_CHUNK);
      const updated = await this.db.contact.findMany({
        where: { workspaceId, id: { in: chunkIds } },
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
          const payload: Contact = toContactWire(c, { tagIds });
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
            workspaceId,
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
              workspaceId,
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
    }

    // One coalesced socket frame for the whole batch. At 25 agents online
    // a 500-contact bulk-tag drops from ~12,500 socket frames to 25.
    await this.bus.publish({
      type: "contact.bulk_updated",
      workspaceId,
      contactIds: ownedIds,
      changeKind: "tags",
      changedByUserId: userId,
    });

    // After the join-table rewrite, the operation is one statement — either
    // it succeeded for every owned id or it threw. No partial-failure path.
    // `capped` is surfaced so the client can warn that a select-all-matching op
    // touched only the first MAX_FILTER_MATCH rows.
    return {
      ok: true,
      count: ownedIds.length,
      action,
      ...(capped ? { capped: true } : {}),
    };
  }

  /**
   * Map the bulk `filter` payload (array tagIds, fieldKey/fieldValue pair) onto
   * the `ListContactsOpts` the where-builder consumes — the same normalization
   * `ContactsService.list` does for the GET query, so filter-mode bulk targets
   * exactly the set the list shows.
   */
  private filterToListOpts(filter: BulkFilterInput): ListContactsOpts {
    return {
      search: filter.search,
      fieldFilter:
        filter.fieldKey && filter.fieldValue
          ? { key: filter.fieldKey, value: filter.fieldValue }
          : undefined,
      source: filter.source,
      tagIds: filter.tagIds,
      window: filter.window,
      stageId: filter.stageId,
      channel: filter.channel,
    };
  }

  // -------------------------------------------------------------------------
  // Pre-existing methods (small endpoints). Untouched by this port.
  // -------------------------------------------------------------------------

  /**
   * Total number of contacts in the team. Used by the broadcast wizard's
   * "All contacts" card — the existing `countAudience` endpoint returns 0
   * when called with no filters, by design (it has no "all" mode), so a
   * dedicated count keeps "all" semantics from leaking into the audience
   * union logic.
   */
  async countAll(workspaceId: string): Promise<number> {
    // Directory-scoped, matching the list: this feeds the broadcast wizard's
    // "All contacts" card, and anonymous widget visitors are neither listed nor
    // broadcastable — counting them would promise an audience we can't reach.
    return this.db.contact.count({
      where: { workspaceId, deletedAt: null, ...directoryContactWhere },
    });
  }

  /** Lightweight id→display lookup for picker chips. Cross-team ids dropped. */
  lookup(workspaceId: string, ids: string[]) {
    return lookupContacts(workspaceId, ids);
  }

  /** True when the contact exists in this team AND carries a captured
   *  (same-origin) avatar. Gates the avatar serve route so one team can't
   *  stream another team's contact avatar object. */
  async hasCapturedAvatar(workspaceId: string, contactId: string): Promise<boolean> {
    const row = await this.db.contact.findFirst({
      where: { workspaceId, id: contactId },
      select: { avatarUrl: true },
    });
    return Boolean(row?.avatarUrl && row.avatarUrl.startsWith("/api/contacts/"));
  }

  /**
   * On-demand refresh of a social contact's profile from Meta (name if still
   * the opaque id, @username, avatar, follower/verified signals). Enrichment
   * normally runs only on a new inbound, so this backfills contacts that
   * predate it and re-pulls signals (follower count) that drift over time.
   * Reuses the exact inbound-enrichment path so there's a single source of
   * truth; it publishes `contact.updated`, so the panel updates live too.
   * No-op (returns the current contact) for phone channels / non-social.
   */
  async syncSocialProfile(workspaceId: string, contactId: string): Promise<Contact> {
    const contact = await this.db.contact.findFirst({
      where: { workspaceId, id: contactId, deletedAt: null },
      include: { tags: { select: { id: true } } },
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    if (
      contact.identityChannel &&
      !isPhoneChannel(contact.identityChannel) &&
      contact.externalContactId
    ) {
      await enrichSocialContactNames(
        workspaceId,
        contact.identityChannel,
        [contact.externalContactId],
        { forceAvatar: true },
      );
    }

    // Re-read so the response reflects whatever enrichment just persisted.
    const fresh = await this.db.contact.findFirst({
      where: { workspaceId, id: contactId },
      include: { tags: { select: { id: true } } },
    });
    const row = fresh ?? contact;
    return toContactWire(row, { tagIds: row.tags.map((t) => t.id) });
  }

  /** Live recipient count for an audience selection, optionally scoped to the
   *  broadcast's target channel so the composer count matches what gets sent. */
  countAudience(workspaceId: string, input: AudienceCountInput): Promise<number> {
    return countAudienceContacts(
      workspaceId,
      { tagIds: input.tagIds, contactIds: input.contactIds, all: input.all },
      input.channel,
    );
  }

  /** First N matches for an audience selection (for the preview list). */
  previewAudience(workspaceId: string, input: AudiencePreviewInput) {
    const { limit, channel, ...audience } = input;
    return previewAudienceContacts(workspaceId, audience, limit, channel);
  }

  /**
   * Replace the full tag set on a contact. Diff the previous + next sets,
   * filter cross-team tag ids, then publish one `contact.updated` with
   * `tagChanges` populated — workflow-dispatch fans out one
   * `contact_tag_updated` trigger per added/removed id.
   */
  async setTags(
    workspaceId: string,
    actorUserId: string,
    contactId: string,
    input: SetContactTagsInput,
  ): Promise<{ tagIds: string[] }> {
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, workspaceId, deletedAt: null },
      include: { tags: { select: { id: true } } },
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    // Cross-team defense: only keep tag ids that actually live on this team.
    const validIds =
      input.tagIds.length === 0
        ? []
        : (
            await this.db.tag.findMany({
              where: { workspaceId, id: { in: input.tagIds } },
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
        where: { id: contactId, workspaceId, version: contact.version },
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

    const payload: Contact = toContactWire(updated, { tagIds: validIds });

    await this.bus.publish({
      type: "contact.updated",
      workspaceId,
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
        workspaceId,
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

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimOrNull(v: string | undefined): string | null {
  if (v === undefined) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function assertCustomFieldsTotal(
  map: Record<string, string>,
  previousCount = 0,
): void {
  const count = Object.keys(map).length;
  // Reject only NET growth past the cap. An already-over-cap bag (pre-cap data,
  // or one grown by an admin-configured workflow update-field step) stays
  // editable AND shrinkable — we only block a write that PUSHES it higher.
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
  // Cap NET growth past the ceiling (null-deletes already applied). A removal-
  // or edit-only PATCH — even on a bag already over the cap — never trips,
  // since it doesn't increase the key count; only net-new keys that push the
  // total higher are rejected. Bounds unbounded JSONB growth across PATCHes.
  assertCustomFieldsTotal(merged, previousCount);
  return merged;
}

