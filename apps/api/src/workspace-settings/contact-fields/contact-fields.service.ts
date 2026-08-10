import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { isReservedFieldKey } from "@ccp/shared/contacts/reserved-fields";
import { invalidateSelectFieldDisplayCache } from "@/lib/contact-fields/select-values";
import {
  TAG_COLORS,
  type ContactFieldDefinition,
  type ContactFieldOption,
  type TagColor,
} from "@ccp/shared/types";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import {
  MAX_OPTIONS_PER_FIELD,
  type ContactPanelBuiltins,
  type CreateContactFieldInput,
  type CreateFieldOptionInput,
  type DeleteFieldOptionInput,
  type ReorderContactFieldsInput,
  type ReorderFieldOptionsInput,
  type UpdateContactFieldInput,
  type UpdateFieldOptionInput,
} from "./contact-fields.schemas";

const MAX_FIELDS_PER_TEAM = 50;

/**
 * Default visibility for built-in contact-panel fields. Used when the team's
 * `contactPanelBuiltins` JSON is empty (every team starts that way). Every
 * built-in column on Contact except phone + name is in this map; all default
 * to visible so a fresh team sees the full schema and the admin can hide.
 * Phone and name aren't toggleable: phone is the WhatsApp identity and name
 * is the panel heading.
 */
const DEFAULT_BUILTINS: Required<ContactPanelBuiltins> = {
  firstName: true,
  lastName: true,
  email: true,
  location: true,
  language: true,
  country: true,
  firstContacted: true,
};

function resolveBuiltins(raw: unknown): Required<ContactPanelBuiltins> {
  if (!raw || typeof raw !== "object") return DEFAULT_BUILTINS;
  const r = raw as Record<string, unknown>;
  return {
    firstName: typeof r.firstName === "boolean" ? r.firstName : DEFAULT_BUILTINS.firstName,
    lastName: typeof r.lastName === "boolean" ? r.lastName : DEFAULT_BUILTINS.lastName,
    email: typeof r.email === "boolean" ? r.email : DEFAULT_BUILTINS.email,
    location: typeof r.location === "boolean" ? r.location : DEFAULT_BUILTINS.location,
    language: typeof r.language === "boolean" ? r.language : DEFAULT_BUILTINS.language,
    country: typeof r.country === "boolean" ? r.country : DEFAULT_BUILTINS.country,
    firstContacted:
      typeof r.firstContacted === "boolean" ? r.firstContacted : DEFAULT_BUILTINS.firstContacted,
  };
}

@Injectable()
export class ContactFieldsService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  async list(workspaceId: string): Promise<ContactFieldDefinition[]> {
    const rows = await this.db.contactFieldDefinition.findMany({
      where: { workspaceId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      include: {
        options: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
      },
    });
    return rows.map(toDto);
  }

  async getBuiltins(workspaceId: string): Promise<Required<ContactPanelBuiltins>> {
    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { contactPanelBuiltins: true },
    });
    return resolveBuiltins(team?.contactPanelBuiltins ?? null);
  }

  async updateBuiltins(
    workspaceId: string,
    canManage: boolean,
    patch: ContactPanelBuiltins,
  ): Promise<Required<ContactPanelBuiltins>> {
    requireManage(canManage);
    const current = await this.getBuiltins(workspaceId);
    const next: Required<ContactPanelBuiltins> = {
      firstName: patch.firstName ?? current.firstName,
      lastName: patch.lastName ?? current.lastName,
      email: patch.email ?? current.email,
      location: patch.location ?? current.location,
      language: patch.language ?? current.language,
      country: patch.country ?? current.country,
      firstContacted: patch.firstContacted ?? current.firstContacted,
    };
    await this.db.workspace.update({
      where: { id: workspaceId },
      data: { contactPanelBuiltins: next },
    });
    // The workflow/broadcast token layer memoizes the select-field catalog
    // for display (lib/contact-fields/select-values.ts) — bust it so a
    // rename/recolor/delete propagates to token rendering immediately.
    invalidateSelectFieldDisplayCache(workspaceId);
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "contact-fields",
    });
    return next;
  }

  async create(
    workspaceId: string,
    canManage: boolean,
    input: CreateContactFieldInput,
  ): Promise<ContactFieldDefinition> {
    requireManage(canManage);

    // Cap definitions so a runaway client can't bloat the panel + the JSONB
    // column on every contact (every key gets rendered + serialized).
    const existing = await this.db.contactFieldDefinition.findMany({
      where: { workspaceId },
      select: { key: true, order: true },
      orderBy: { order: "desc" },
      take: MAX_FIELDS_PER_TEAM,
    });
    if (existing.length >= MAX_FIELDS_PER_TEAM) {
      throw new BadRequestException({
        error: `at most ${MAX_FIELDS_PER_TEAM} contact fields per team`,
      });
    }

    const baseKey = slugifyKey(input.label);
    if (!baseKey) {
      throw new BadRequestException({ error: "label_must_contain_letters_or_digits" });
    }
    // Block shadowing of built-in Contact columns ("location", "email",
    // "first_name", etc). Without this, the custom field saves to
    // `customFields[key]` but the inbox panel renders it next to the
    // identically-labeled built-in column, confusing reads + writes.
    if (isReservedFieldKey(input.label)) {
      throw new BadRequestException({
        error: "reserved_field",
        detail: `"${input.label}" is a built-in contact field — pick a different name.`,
      });
    }

    // Reject a duplicate LABEL (case-insensitive). There's a [workspaceId, key]
    // unique but NONE on label, so two fields named "Notes" both write to
    // row["Notes"] on CSV export (last-write-wins → the first field's data
    // silently vanishes + a duplicate column) and collapse to one key on
    // import (the other is unimportable). Silent CRM data loss; guard it here.
    await this.assertLabelAvailable(workspaceId, input.label, null);

    // Disambiguate against existing keys — two labels that collapse to the
    // same slug would otherwise hit the [workspaceId, key] unique index.
    const usedKeys = new Set(existing.map((e) => e.key));
    let key = baseKey;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${baseKey}_${suffix++}`;
    }

    const nextOrder = (existing[0]?.order ?? -1) + 1;
    const type = input.type ?? "text";

    // Inline options (select fields only — schema-enforced): reject
    // duplicates case-insensitively up front so the create is all-or-nothing
    // instead of tripping the [fieldId, name] unique halfway through.
    const inlineOptions = input.options ?? [];
    const seenNames = new Set<string>();
    for (const o of inlineOptions) {
      const lowered = o.name.trim().toLowerCase();
      if (seenNames.has(lowered)) {
        throw new BadRequestException({
          error: "duplicate_option_name",
          detail: `Option "${o.name}" appears more than once.`,
        });
      }
      seenNames.add(lowered);
    }

    try {
      const created = await this.db.$transaction(async (tx) => {
        const def = await tx.contactFieldDefinition.create({
          data: { workspaceId, key, label: input.label, order: nextOrder, type },
        });
        if (inlineOptions.length > 0) {
          const usedColors: string[] = [];
          await tx.contactFieldOption.createMany({
            data: inlineOptions.map((o, index) => {
              const color = o.color ?? pickNextPaletteColor(usedColors);
              usedColors.push(color);
              return { workspaceId, fieldId: def.id, name: o.name, color, position: index };
            }),
          });
        }
        return tx.contactFieldDefinition.findUniqueOrThrow({
          where: { id: def.id },
          include: {
            options: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
          },
        });
      });
      // The display cache memoizes even an EMPTY select-def list, so without
      // this bust a workspace's first select field (and its inline options)
      // stays invisible to token rendering for up to 5 minutes.
      invalidateSelectFieldDisplayCache(workspaceId);
      await this.bus.publish({
        type: "team.catalog_changed",
        workspaceId,
        scope: "contact-fields",
      });
      return toDto(created);
    } catch (err) {
      throwIfUniqueViolation(err, "field with that key already exists");
      throw err;
    }
  }

  async update(
    workspaceId: string,
    canManage: boolean,
    id: string,
    input: UpdateContactFieldInput,
  ): Promise<ContactFieldDefinition> {
    requireManage(canManage);

    const existing = await this.db.contactFieldDefinition.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "not_found" });

    // Same shadow-built-in guard as create. Stops a rename loophole: if a
    // user couldn't create "Location" they shouldn't be able to rename
    // "City info" → "Location" either.
    if (typeof input.label === "string" && isReservedFieldKey(input.label)) {
      throw new BadRequestException({
        error: "reserved_field",
        detail: `"${input.label}" is a built-in contact field — pick a different name.`,
      });
    }

    // Block a rename that collides with another field's label (case-insensitive,
    // excluding this row) — same CSV-corruption guard as create().
    if (typeof input.label === "string") {
      await this.assertLabelAvailable(workspaceId, input.label, id);
    }

    // Team-scoped mutation (defense-in-depth): even though the findFirst above
    // already proved ownership, the WRITE itself carries the workspaceId predicate
    // so a bare-id update can never touch another tenant's row. `input` no
    // longer carries `order` (dropped from the schema) — order changes only via
    // the transactional /reorder endpoint.
    const result = await this.db.contactFieldDefinition.updateMany({
      where: { id, workspaceId },
      data: input,
    });
    if (result.count === 0) throw new NotFoundException({ error: "not_found" });

    const updated = await this.db.contactFieldDefinition.findUniqueOrThrow({
      where: { id },
      include: {
        options: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
      },
    });
    // The workflow/broadcast token layer memoizes the select-field catalog
    // for display (lib/contact-fields/select-values.ts) — bust it so a
    // rename/recolor/delete propagates to token rendering immediately.
    invalidateSelectFieldDisplayCache(workspaceId);
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "contact-fields",
    });
    return toDto(updated);
  }

  /**
   * Bulk-reorder. `orderedIds[i].order = i`. Ids not in the list keep their
   * current order. One transaction so a partial failure can't leave duplicate
   * `order` values (the two-PATCH client path could). Capped at 50 fields so
   * the per-row update transaction stays tiny.
   */
  async reorder(
    workspaceId: string,
    canManage: boolean,
    input: ReorderContactFieldsInput,
  ): Promise<void> {
    requireManage(canManage);
    const ids = input.orderedIds;
    if (ids.length === 0) return;

    // Cross-tenant guard: every id must belong to this team or the whole
    // request rejects. Without this a malicious client could rewrite
    // orders on another tenant's fields.
    const owned = await this.db.contactFieldDefinition.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new BadRequestException({ error: "one_or_more_ids_are_not_in_this_team" });
    }

    await this.db.$transaction(
      ids.map((id, index) =>
        this.db.contactFieldDefinition.update({ where: { id }, data: { order: index } }),
      ),
    );
    // The workflow/broadcast token layer memoizes the select-field catalog
    // for display (lib/contact-fields/select-values.ts) — bust it so a
    // rename/recolor/delete propagates to token rendering immediately.
    invalidateSelectFieldDisplayCache(workspaceId);
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "contact-fields",
    });
  }

  async remove(workspaceId: string, canManage: boolean, id: string): Promise<void> {
    requireManage(canManage);

    const def = await this.db.contactFieldDefinition.findFirst({
      where: { id, workspaceId },
    });
    if (!def) throw new NotFoundException({ error: "not_found" });

    // Strip the key from every contact's customFields JSONB in the same
    // transaction as the definition delete. Without that strip, the column
    // would keep ghost-rendering the field on every contact's panel.
    //
    // Postgres `-` operator is the right tool here; Prisma doesn't expose
    // it typed so we drop to $executeRaw. The `?` (key existence) on the
    // WHERE keeps the indexable workspaceId predicate first for the bulk path.
    // Team-scoped delete (defense-in-depth): the findFirst above proved
    // ownership, but the DELETE itself carries the workspaceId predicate so a bare-id
    // delete can never remove another tenant's definition. deleteMany returns a
    // count we assert is non-zero.
    const [, deleted] = await this.db.$transaction([
      this.db.$executeRaw`
        UPDATE "Contact"
        SET "customFields" = "customFields" - ${def.key}
        WHERE "workspaceId" = ${workspaceId}
          AND "customFields" ? ${def.key}
      `,
      this.db.contactFieldDefinition.deleteMany({ where: { id, workspaceId } }),
    ]);
    if (deleted.count === 0) throw new NotFoundException({ error: "not_found" });

    // The workflow/broadcast token layer memoizes the select-field catalog
    // for display (lib/contact-fields/select-values.ts) — bust it so a
    // rename/recolor/delete propagates to token rendering immediately.
    invalidateSelectFieldDisplayCache(workspaceId);
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "contact-fields",
    });
  }

  // -------------------------------------------------------------------------
  // Select-field options. The value stored on contacts is the OPTION ID, so
  // rename/recolor are metadata-only; delete is guarded because Prisma can't
  // reach inside the customFields JSONB — mirrors stage delete semantics.
  // -------------------------------------------------------------------------

  /**
   * Per-option usage counts for one select field (settings badges + the
   * delete dialog). One raw aggregate — the values live in JSONB so Prisma's
   * groupBy can't express it. Only counts values matching a CURRENT option
   * id; a stale id (deleted option) counts toward nothing, same as the
   * export writing an empty cell for it.
   */
  async optionCounts(
    workspaceId: string,
    fieldId: string,
  ): Promise<{ countsByOptionId: Record<string, number> }> {
    const field = await this.getSelectField(workspaceId, fieldId);
    const rows = await this.db.$queryRaw<{ value: string; count: number }[]>`
      SELECT "customFields"->>${field.key} AS value, count(*)::int AS count
      FROM "Contact"
      WHERE "workspaceId" = ${workspaceId}
        AND "deletedAt" IS NULL
        AND "customFields" ? ${field.key}
      GROUP BY 1
    `;
    const known = new Set(field.options.map((o) => o.id));
    const countsByOptionId: Record<string, number> = {};
    for (const row of rows) {
      if (row.value && known.has(row.value)) countsByOptionId[row.value] = row.count;
    }
    return { countsByOptionId };
  }

  async createOption(
    workspaceId: string,
    canManage: boolean,
    fieldId: string,
    input: CreateFieldOptionInput,
  ): Promise<ContactFieldOption> {
    requireManage(canManage);
    const field = await this.getSelectField(workspaceId, fieldId);

    if (field.options.length >= MAX_OPTIONS_PER_FIELD) {
      throw new BadRequestException({
        error: "option_limit_reached",
        detail: `This field has reached its limit of ${MAX_OPTIONS_PER_FIELD} options.`,
      });
    }
    // Case-insensitive pre-check — the [fieldId, name] unique is
    // case-sensitive, and "Vip" next to "VIP" is the CSV-corruption class
    // (import matches names case-insensitively, so one of them becomes
    // unimportable).
    this.assertOptionNameAvailable(field.options, input.name, null);

    const nextPosition = (field.options.at(-1)?.position ?? -1) + 1;
    const color =
      input.color ?? pickNextPaletteColor(field.options.map((o) => o.color));
    try {
      const created = await this.db.contactFieldOption.create({
        data: { workspaceId, fieldId, name: input.name, color, position: nextPosition },
      });
      // Bust the token-display memo so a just-created option renders its name
      // (not the raw id) the moment an agent assigns it.
      invalidateSelectFieldDisplayCache(workspaceId);
      await this.bus.publish({
        type: "team.catalog_changed",
        workspaceId,
        scope: "contact-fields",
      });
      return toOptionDto(created);
    } catch (err) {
      throwIfUniqueViolation(err, "an option with this name already exists");
      throw err;
    }
  }

  async updateOption(
    workspaceId: string,
    canManage: boolean,
    fieldId: string,
    optionId: string,
    input: UpdateFieldOptionInput,
  ): Promise<ContactFieldOption> {
    requireManage(canManage);
    const field = await this.getSelectField(workspaceId, fieldId);
    if (!field.options.some((o) => o.id === optionId)) {
      throw new NotFoundException({ error: "not_found" });
    }
    if (typeof input.name === "string") {
      this.assertOptionNameAvailable(field.options, input.name, optionId);
    }

    try {
      // Workspace-scoped mutation (defense-in-depth), same rationale as the
      // field update above.
      const result = await this.db.contactFieldOption.updateMany({
        where: { id: optionId, fieldId, workspaceId },
        data: input,
      });
      if (result.count === 0) throw new NotFoundException({ error: "not_found" });
    } catch (err) {
      throwIfUniqueViolation(err, "an option with this name already exists");
      throw err;
    }
    const updated = await this.db.contactFieldOption.findUniqueOrThrow({
      where: { id: optionId },
    });
    // The workflow/broadcast token layer memoizes the select-field catalog
    // for display (lib/contact-fields/select-values.ts) — bust it so a
    // rename/recolor/delete propagates to token rendering immediately.
    invalidateSelectFieldDisplayCache(workspaceId);
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "contact-fields",
    });
    return toOptionDto(updated);
  }

  /** Bulk-reorder within one field — same contract as the field reorder. */
  async reorderOptions(
    workspaceId: string,
    canManage: boolean,
    fieldId: string,
    input: ReorderFieldOptionsInput,
  ): Promise<void> {
    requireManage(canManage);
    await this.getSelectField(workspaceId, fieldId);
    const ids = input.orderedIds;
    if (ids.length === 0) return;

    // Cross-tenant/cross-field guard: every id must belong to THIS field or
    // the whole request rejects.
    const owned = await this.db.contactFieldOption.findMany({
      where: { workspaceId, fieldId, id: { in: ids } },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new BadRequestException({ error: "one_or_more_ids_are_not_in_this_field" });
    }

    await this.db.$transaction(
      ids.map((id, index) =>
        this.db.contactFieldOption.update({ where: { id }, data: { position: index } }),
      ),
    );
    // The workflow/broadcast token layer memoizes the select-field catalog
    // for display (lib/contact-fields/select-values.ts) — bust it so a
    // rename/recolor/delete propagates to token rendering immediately.
    invalidateSelectFieldDisplayCache(workspaceId);
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "contact-fields",
    });
  }

  /**
   * Delete an option. Three modes on `moveToOptionId`:
   *   undefined — refuse while contacts still carry the value (409
   *               option_in_use + count; the UI opens the move dialog);
   *   a sibling option id — re-point every carrying contact to it, then
   *               delete, one transaction;
   *   null      — clear the value (drop the key) on every carrying contact,
   *               then delete, one transaction.
   *
   * The value lives inside customFields JSONB with no FK, so the move/clear
   * is raw SQL — and the delete happens in the SAME transaction so a
   * concurrent "set this option on a contact" either lands before (and gets
   * moved/cleared) or after (and fails validation against the now-missing
   * option). Serializable for the refuse path, mirroring stage delete's
   * TOCTOU reasoning.
   */
  async removeOption(
    workspaceId: string,
    canManage: boolean,
    fieldId: string,
    optionId: string,
    input: DeleteFieldOptionInput,
  ): Promise<void> {
    requireManage(canManage);
    const field = await this.getSelectField(workspaceId, fieldId);
    if (!field.options.some((o) => o.id === optionId)) {
      throw new NotFoundException({ error: "not_found" });
    }
    const moveTo = input?.moveToOptionId;

    if (moveTo === undefined) {
      // Fast pre-check for a friendly error; authoritative re-check in-tx.
      const inUse = await this.countOptionUsage(workspaceId, field.key, optionId);
      if (inUse > 0) throw optionInUse(inUse);
      await this.db.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count
            FROM "Contact"
            WHERE "workspaceId" = ${workspaceId}
              AND "deletedAt" IS NULL
              AND "customFields"->>${field.key} = ${optionId}
          `;
          const liveCount = rows[0]?.count ?? 0;
          if (liveCount > 0) throw optionInUse(liveCount);
          const deleted = await tx.contactFieldOption.deleteMany({
            where: { id: optionId, fieldId, workspaceId },
          });
          if (deleted.count === 0) throw new NotFoundException({ error: "not_found" });
        },
        { isolationLevel: "Serializable" },
      );
    } else {
      if (moveTo !== null) {
        const target = field.options.find((o) => o.id === moveTo);
        if (!target || moveTo === optionId) {
          throw new BadRequestException({ error: "invalid_move_target" });
        }
      }
      await this.db.$transaction(async (tx) => {
        if (moveTo === null) {
          // Clear: drop the key entirely (an empty string would render as a
          // set-but-blank value and break the "has a value" filter).
          // `version + 1` so a concurrent contact PATCH that read the
          // pre-image (still carrying this option id under the key) CAS-fails
          // instead of merging the deleted id back in — the ghost-resurrection
          // race the refuse path's Serializable tx already prevents
          // (audit 2026-08-10).
          await tx.$executeRaw`
            UPDATE "Contact"
            SET "customFields" = "customFields" - ${field.key},
                "version" = "version" + 1
            WHERE "workspaceId" = ${workspaceId}
              AND "customFields"->>${field.key} = ${optionId}
          `;
        } else {
          // Same version bump as the clear arm above.
          await tx.$executeRaw`
            UPDATE "Contact"
            SET "customFields" = jsonb_set("customFields", ARRAY[${field.key}], to_jsonb(${moveTo}::text)),
                "version" = "version" + 1
            WHERE "workspaceId" = ${workspaceId}
              AND "customFields"->>${field.key} = ${optionId}
          `;
        }
        const deleted = await tx.contactFieldOption.deleteMany({
          where: { id: optionId, fieldId, workspaceId },
        });
        if (deleted.count === 0) throw new NotFoundException({ error: "not_found" });
      });
    }
    // The workflow/broadcast token layer memoizes the select-field catalog
    // for display (lib/contact-fields/select-values.ts) — bust it so a
    // rename/recolor/delete propagates to token rendering immediately.
    invalidateSelectFieldDisplayCache(workspaceId);
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "contact-fields",
    });
  }

  /** Live contacts carrying this option id under this field's key. */
  private async countOptionUsage(
    workspaceId: string,
    fieldKey: string,
    optionId: string,
  ): Promise<number> {
    const rows = await this.db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM "Contact"
      WHERE "workspaceId" = ${workspaceId}
        AND "deletedAt" IS NULL
        AND "customFields"->>${fieldKey} = ${optionId}
    `;
    return rows[0]?.count ?? 0;
  }

  /** 404 unless the field exists in this workspace; 400 unless it's select. */
  private async getSelectField(
    workspaceId: string,
    fieldId: string,
  ): Promise<{
    id: string;
    key: string;
    options: { id: string; name: string; color: string; position: number }[];
  }> {
    const field = await this.db.contactFieldDefinition.findFirst({
      where: { id: fieldId, workspaceId },
      select: {
        id: true,
        key: true,
        type: true,
        options: {
          select: { id: true, name: true, color: true, position: true },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        },
      },
    });
    if (!field) throw new NotFoundException({ error: "not_found" });
    if (field.type !== "select") {
      throw new BadRequestException({ error: "not_a_select_field" });
    }
    return field;
  }

  private assertOptionNameAvailable(
    siblings: { id: string; name: string }[],
    name: string,
    excludeId: string | null,
  ): void {
    const lowered = name.trim().toLowerCase();
    if (
      siblings.some((o) => o.id !== excludeId && o.name.trim().toLowerCase() === lowered)
    ) {
      throw new ConflictException({
        error: "option_name_taken",
        detail: `An option named "${name}" already exists on this field.`,
      });
    }
  }

  /**
   * Throw 409 if another field on this team already uses `label` (compared by
   * its normalized slug, so "Notes" / "notes " / "NOTES" all collide). Pass
   * `excludeId` on update so a field doesn't conflict with itself. Prevents the
   * duplicate-label CSV-corruption class — distinct keys but identical export
   * column headers, which silently drops one field's data on export/import.
   */
  private async assertLabelAvailable(
    workspaceId: string,
    label: string,
    excludeId: string | null,
  ): Promise<void> {
    const slug = slugifyKey(label);
    if (!slug) return; // empty/invalid labels are rejected elsewhere by the key check
    const siblings = await this.db.contactFieldDefinition.findMany({
      where: { workspaceId, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { label: true },
    });
    if (siblings.some((s) => slugifyKey(s.label) === slug)) {
      throw new ConflictException({
        error: "duplicate_label",
        detail: `A contact field named "${label}" already exists — pick a different name.`,
      });
    }
  }
}

function toDto(r: {
  id: string;
  workspaceId: string;
  key: string;
  label: string;
  order: number;
  isVisible: boolean;
  type: "text" | "select";
  options?: { id: string; fieldId: string; name: string; color: string; position: number }[];
}): ContactFieldDefinition {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    key: r.key,
    label: r.label,
    order: r.order,
    isVisible: r.isVisible,
    type: r.type,
    // Present (possibly empty) for select fields, absent for text — matching
    // the shared contract so the panel doesn't render an empty catalog UI on
    // text fields.
    ...(r.type === "select" ? { options: (r.options ?? []).map(toOptionDto) } : {}),
  };
}

function toOptionDto(o: {
  id: string;
  fieldId: string;
  name: string;
  color: string;
  position: number;
}): ContactFieldOption {
  return {
    id: o.id,
    fieldId: o.fieldId,
    name: o.name,
    color: o.color as TagColor,
    position: o.position,
  };
}

/**
 * Choose the first palette color not yet used by a sibling option. Falls
 * back to slate once all 9 are taken. Same helper as stages — small enough
 * that a copy beats a cross-module import from the stages feature.
 */
function pickNextPaletteColor(used: string[]): TagColor {
  const usedSet = new Set(used);
  for (const c of TAG_COLORS) {
    if (!usedSet.has(c)) return c;
  }
  return "slate";
}

function optionInUse(count: number): ConflictException {
  return new ConflictException({
    error: "option_in_use",
    detail: `${count} contact${count === 1 ? " has" : "s have"} this option. Move them to another option first.`,
    contactCount: count,
  });
}

/**
 * Lowercase + underscored slug from a label. Keeps the JSONB key readable in
 * psql (`customFields->>'order_id'`) without letting users type collisions
 * like "Order ID" vs "order id" against the unique index.
 */
export function slugifyKey(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function requireManage(canManage: boolean): void {
  if (!canManage) throw new ForbiddenException({ error: "forbidden" });
}

function throwIfUniqueViolation(err: unknown, detail: string): void {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  ) {
    throw new ConflictException({ error: detail });
  }
}
