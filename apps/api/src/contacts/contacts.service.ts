import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { blobStorage } from "@/lib/blob-storage";
import { serializeCsv, parseCsv } from "@/lib/csv";
import type { ContactFieldChange } from "@ccp/shared/events/types";
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
import type {
  AudienceCountInput,
  AudiencePreviewInput,
  BulkContactsInput,
  CreateContactInput,
  ListContactsQueryInput,
  SetContactTagsInput,
  UpdateContactInput,
} from "./contacts.schemas";

const MAX_BYTES = 5 * 1024 * 1024;
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
   */
  async create(teamId: string, input: CreateContactInput): Promise<Contact> {
    const phone = normalizePhoneE164(input.phoneNumber);
    if (!phone) {
      throw new BadRequestException({
        error:
          "phoneNumber must be a valid international number (e.g. +1 555 555 0100)",
      });
    }

    // Default the name to the phone number — matches the inbound webhook
    // path (ingest does the same when Meta hasn't given a profile name).
    const name =
      input.name && input.name.trim().length > 0
        ? input.name.trim().slice(0, MAX_TEXT)
        : phone;

    const email = trimOrNull(input.email);
    const location = trimOrNull(input.location);
    const customFields = normalizeCreateCustomFields(input.customFields ?? {});

    // Every contact lands in the team's default stage on create — lazy-init
    // covers older teams + admins who deleted the seeded default.
    const stageId = await ensureDefaultStage(teamId);

    try {
      const created = await this.db.contact.create({
        data: {
          teamId,
          phoneNumber: phone,
          name,
          email: email ?? undefined,
          location: location ?? undefined,
          customFields,
          stageId,
          // "manual" so the contacts list can show a "Added by you" badge
          // and filter manually-added apart from inbound rows.
          source: "manual",
        },
      });

      return {
        id: created.id,
        teamId: created.teamId,
        phoneNumber: created.phoneNumber,
        identityProvider: created.identityProvider,
        externalContactId: created.externalContactId,
        name: created.name,
        avatarUrl: created.avatarUrl ?? undefined,
        email: created.email ?? undefined,
        location: created.location ?? undefined,
        customFields: normalizeStringMap(created.customFields),
        source: created.source,
        stageId: created.stageId,
      };
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

      const updated = await tx.contact.update({
        where: { id: contactId },
        data: {
          ...(name !== undefined ? { name } : {}),
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
    const contact: Contact = {
      id: updated.id,
      teamId: updated.teamId,
      phoneNumber: updated.phoneNumber,
      identityProvider: updated.identityProvider,
      externalContactId: updated.externalContactId,
      name: updated.name,
      avatarUrl: updated.avatarUrl ?? undefined,
      email: updated.email ?? undefined,
      location: updated.location ?? undefined,
      customFields: normalizeStringMap(updated.customFields),
      source: updated.source,
      stageId: updated.stageId,
      tagIds,
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

    await this.bus.publish({
      type: "contact.updated",
      teamId,
      contact,
      previousStageId: existing.stageId,
      fieldChanges,
      changedByUserId: userId,
      workflowContact: workflowContactSnapshot(updated),
    });

    return contact;
  }

  /**
   * Hard-delete a contact and every row hanging off it. FK cascade clears
   * Conversation / Message / InternalNote / BroadcastRecipient / Tag joins;
   * blob unlinking is best-effort AFTER the DB commit — a stuck blob is
   * preferable to a half-committed delete.
   */
  async remove(teamId: string, userId: string, contactId: string): Promise<void> {
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
      await blobStorage.delete(mediaKeys);
    }

    await this.bus.publish({
      type: "contact.deleted",
      teamId,
      contactId,
      conversationIds,
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
      const conversationsWithMedia = await this.db.conversation.findMany({
        where: { teamId, contactId: { in: ownedIds } },
        select: {
          id: true,
          contactId: true,
          messages: {
            where: { mediaKey: { not: null } },
            select: { mediaKey: true },
          },
        },
      });
      const mediaKeys = conversationsWithMedia
        .flatMap((c) => c.messages)
        .map((m) => m.mediaKey)
        .filter((k): k is string => Boolean(k));

      // Group convo ids per-contact so each contact.deleted event carries
      // its own cascade list — mirrors the single-contact DELETE event.
      const conversationsByContact = new Map<string, string[]>();
      for (const c of conversationsWithMedia) {
        const list = conversationsByContact.get(c.contactId) ?? [];
        list.push(c.id);
        conversationsByContact.set(c.contactId, list);
      }

      await this.db.contact.deleteMany({
        where: { teamId, id: { in: ownedIds } },
      });

      if (mediaKeys.length > 0) {
        await blobStorage.delete(mediaKeys);
      }

      await Promise.all(
        ownedIds.map((id) =>
          this.bus.publish({
            type: "contact.deleted",
            teamId,
            contactId: id,
            conversationIds: conversationsByContact.get(id) ?? [],
            deletedByUserId: userId,
          }),
        ),
      );

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

    const op = action === "tag-add" ? "connect" : "disconnect";
    const results = await Promise.allSettled(
      ownedIds.map((id) =>
        this.db.contact.update({
          where: { id, teamId },
          data: { tags: { [op]: { id: tagId } } },
        }),
      ),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - succeeded;
    if (failed > 0) {
      const firstReason = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      )?.reason;
      console.error(
        `[contacts/bulk] ${action} partial failure: ${failed}/${results.length} contacts. First error:`,
        firstReason instanceof Error ? firstReason.message : firstReason,
      );
    }

    // Reload ALL ownedIds (not just succeeded) — emitting the current truth
    // for a failed update is harmless and keeps the socket payload simple.
    const updated = await this.db.contact.findMany({
      where: { teamId, id: { in: ownedIds } },
      include: { tags: { select: { id: true } } },
    });
    await Promise.all(
      updated.map((c) => {
        const tagIds = c.tags.map((t) => t.id);
        const payload: Contact = {
          id: c.id,
          teamId: c.teamId,
          phoneNumber: c.phoneNumber,
          identityProvider: c.identityProvider,
          externalContactId: c.externalContactId,
          name: c.name,
          avatarUrl: c.avatarUrl ?? undefined,
          email: c.email ?? undefined,
          location: c.location ?? undefined,
          customFields: normalizeStringMap(c.customFields),
          source: c.source,
          stageId: c.stageId,
          tagIds,
        };
        const before = hadTag.get(c.id) ?? false;
        const now = tagIds.includes(tagId);
        const tagChanges =
          before === now
            ? { added: [], removed: [] }
            : action === "tag-add"
              ? { added: [tagId], removed: [] }
              : { added: [], removed: [tagId] };
        return this.bus.publish({
          type: "contact.updated",
          teamId,
          contact: payload,
          previousStageId: c.stageId,
          fieldChanges: [],
          tagChanges,
          changedByUserId: userId,
          workflowContact: workflowContactSnapshot(c),
        });
      }),
    );

    return {
      ok: failed === 0,
      count: succeeded,
      action,
      ...(failed > 0 ? { failed } : {}),
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
      | { kind: "email" }
      | { kind: "location" }
      | { kind: "ignore" }
      | { kind: "field"; key: string };

    function classify(header: string): Mapping {
      const h = header.toLowerCase().trim();
      if (h === "phone_number" || h === "phone" || h === "phone number") {
        return { kind: "phone" };
      }
      if (h === "name" || h === "full name") return { kind: "name" };
      if (h === "email" || h === "e-mail") return { kind: "email" };
      if (h === "location" || h === "city") return { kind: "location" };
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
      email: string | null;
      location: string | null;
      customFields: Record<string, string>;
    }
    const pending: PendingRow[] = [];

    for (let i = 0; i < parsed.rows.length; i++) {
      const rowNumber = i + 2; // 1-indexed from header, matches Excel row numbers
      const row = parsed.rows[i] ?? {};
      let phoneRaw: string | undefined;
      let name = "";
      let email = "";
      let location = "";
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
          case "email":
            email = value.slice(0, MAX_TEXT);
            break;
          case "location":
            location = value.slice(0, MAX_TEXT);
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

      pending.push({
        rowNumber,
        phoneNumber: phone,
        name: name.trim() || phone,
        email: email.trim() || null,
        location: location.trim() || null,
        customFields,
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
    if (toCreate.length > 0) {
      // Default stage looked up once for the whole batch — every row lands
      // in the same place, no per-row roundtrip needed.
      const defaultStageId = await ensureDefaultStage(teamId);
      const result = await this.db.contact.createMany({
        data: toCreate.map((p) => ({
          teamId,
          phoneNumber: p.phoneNumber,
          name: p.name,
          email: p.email ?? undefined,
          location: p.location ?? undefined,
          customFields: p.customFields,
          stageId: defaultStageId,
          source: "manual",
        })),
        skipDuplicates: true,
      });
      created = result.count;
    }

    return {
      total: parsed.rows.length,
      created,
      skippedExisting: skippedExisting + (toCreate.length - created),
      errors,
      unknownColumns,
    };
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
    return previewAudienceContacts(teamId, input);
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

    const updated = await this.db.contact.update({
      where: { id: contactId },
      data: { tags: { set: validIds.map((tagId) => ({ id: tagId })) } },
      include: { tags: { select: { id: true } } },
    });

    const payload: Contact = {
      id: updated.id,
      teamId: updated.teamId,
      phoneNumber: updated.phoneNumber,
      identityProvider: updated.identityProvider,
      externalContactId: updated.externalContactId,
      name: updated.name,
      avatarUrl: updated.avatarUrl ?? undefined,
      email: updated.email ?? undefined,
      location: updated.location ?? undefined,
      customFields: normalizeStringMap(updated.customFields),
      source: updated.source,
      stageId: updated.stageId,
      tagIds: validIds,
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

    return { tagIds: validIds };
  }

  /**
   * Export every contact as CSV. Columns: base + per-team-field + per-one-off
   * key. Self-describing for re-import. No pagination — contact set is
   * usage-capped at the team level and a single SELECT keeps the response
   * deterministic.
   */
  async exportCsv(teamId: string): Promise<{ csv: string; filename: string }> {
    const [contacts, fieldDefs] = await Promise.all([
      this.db.contact.findMany({
        where: { teamId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      this.db.contactFieldDefinition.findMany({
        where: { teamId },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      }),
    ]);

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

    const baseColumns = ["phone_number", "name", "email", "location", "source"];
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
        email: c.email ?? "",
        location: c.location ?? "",
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

    const csv = serializeCsv(columns, rows);
    // Date-stamp so multiple exports in a day don't overwrite each other.
    const stamp = new Date().toISOString().slice(0, 10);
    return { csv, filename: `contacts-${stamp}.csv` };
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
