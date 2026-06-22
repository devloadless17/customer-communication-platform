import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { isReservedFieldKey } from "@ccp/shared/contacts/reserved-fields";
import type { ContactFieldDefinition } from "@ccp/shared/types";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  ContactPanelBuiltins,
  CreateContactFieldInput,
  ReorderContactFieldsInput,
  UpdateContactFieldInput,
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

  async list(teamId: string): Promise<ContactFieldDefinition[]> {
    const rows = await this.db.contactFieldDefinition.findMany({
      where: { teamId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(toDto);
  }

  async getBuiltins(teamId: string): Promise<Required<ContactPanelBuiltins>> {
    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: { contactPanelBuiltins: true },
    });
    return resolveBuiltins(team?.contactPanelBuiltins ?? null);
  }

  async updateBuiltins(
    teamId: string,
    canManage: boolean,
    patch: ContactPanelBuiltins,
  ): Promise<Required<ContactPanelBuiltins>> {
    requireManage(canManage);
    const current = await this.getBuiltins(teamId);
    const next: Required<ContactPanelBuiltins> = {
      firstName: patch.firstName ?? current.firstName,
      lastName: patch.lastName ?? current.lastName,
      email: patch.email ?? current.email,
      location: patch.location ?? current.location,
      language: patch.language ?? current.language,
      country: patch.country ?? current.country,
      firstContacted: patch.firstContacted ?? current.firstContacted,
    };
    await this.db.team.update({
      where: { id: teamId },
      data: { contactPanelBuiltins: next },
    });
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "contact-fields",
    });
    return next;
  }

  async create(
    teamId: string,
    canManage: boolean,
    input: CreateContactFieldInput,
  ): Promise<ContactFieldDefinition> {
    requireManage(canManage);

    // Cap definitions so a runaway client can't bloat the panel + the JSONB
    // column on every contact (every key gets rendered + serialized).
    const existing = await this.db.contactFieldDefinition.findMany({
      where: { teamId },
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
      throw new BadRequestException({ error: "label must contain letters or digits" });
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

    // Reject a duplicate LABEL (case-insensitive). There's a [teamId, key]
    // unique but NONE on label, so two fields named "Notes" both write to
    // row["Notes"] on CSV export (last-write-wins → the first field's data
    // silently vanishes + a duplicate column) and collapse to one key on
    // import (the other is unimportable). Silent CRM data loss; guard it here.
    await this.assertLabelAvailable(teamId, input.label, null);

    // Disambiguate against existing keys — two labels that collapse to the
    // same slug would otherwise hit the [teamId, key] unique index.
    const usedKeys = new Set(existing.map((e) => e.key));
    let key = baseKey;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${baseKey}_${suffix++}`;
    }

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
      return toDto(created);
    } catch (err) {
      throwIfUniqueViolation(err, "field with that key already exists");
      throw err;
    }
  }

  async update(
    teamId: string,
    canManage: boolean,
    id: string,
    input: UpdateContactFieldInput,
  ): Promise<ContactFieldDefinition> {
    requireManage(canManage);

    const existing = await this.db.contactFieldDefinition.findFirst({
      where: { id, teamId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "not found" });

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
      await this.assertLabelAvailable(teamId, input.label, id);
    }

    // Team-scoped mutation (defense-in-depth): even though the findFirst above
    // already proved ownership, the WRITE itself carries the teamId predicate
    // so a bare-id update can never touch another tenant's row. `input` no
    // longer carries `order` (dropped from the schema) — order changes only via
    // the transactional /reorder endpoint.
    const result = await this.db.contactFieldDefinition.updateMany({
      where: { id, teamId },
      data: input,
    });
    if (result.count === 0) throw new NotFoundException({ error: "not found" });

    const updated = await this.db.contactFieldDefinition.findUniqueOrThrow({
      where: { id },
    });
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
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
    teamId: string,
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
      where: { teamId, id: { in: ids } },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new BadRequestException({ error: "one or more ids are not in this team" });
    }

    await this.db.$transaction(
      ids.map((id, index) =>
        this.db.contactFieldDefinition.update({ where: { id }, data: { order: index } }),
      ),
    );
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "contact-fields",
    });
  }

  async remove(teamId: string, canManage: boolean, id: string): Promise<void> {
    requireManage(canManage);

    const def = await this.db.contactFieldDefinition.findFirst({
      where: { id, teamId },
    });
    if (!def) throw new NotFoundException({ error: "not found" });

    // Strip the key from every contact's customFields JSONB in the same
    // transaction as the definition delete. Without that strip, the column
    // would keep ghost-rendering the field on every contact's panel.
    //
    // Postgres `-` operator is the right tool here; Prisma doesn't expose
    // it typed so we drop to $executeRaw. The `?` (key existence) on the
    // WHERE keeps the indexable teamId predicate first for the bulk path.
    // Team-scoped delete (defense-in-depth): the findFirst above proved
    // ownership, but the DELETE itself carries the teamId predicate so a bare-id
    // delete can never remove another tenant's definition. deleteMany returns a
    // count we assert is non-zero.
    const [, deleted] = await this.db.$transaction([
      this.db.$executeRaw`
        UPDATE "Contact"
        SET "customFields" = "customFields" - ${def.key}
        WHERE "teamId" = ${teamId}
          AND "customFields" ? ${def.key}
      `,
      this.db.contactFieldDefinition.deleteMany({ where: { id, teamId } }),
    ]);
    if (deleted.count === 0) throw new NotFoundException({ error: "not found" });

    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "contact-fields",
    });
  }

  /**
   * Throw 409 if another field on this team already uses `label` (compared by
   * its normalized slug, so "Notes" / "notes " / "NOTES" all collide). Pass
   * `excludeId` on update so a field doesn't conflict with itself. Prevents the
   * duplicate-label CSV-corruption class — distinct keys but identical export
   * column headers, which silently drops one field's data on export/import.
   */
  private async assertLabelAvailable(
    teamId: string,
    label: string,
    excludeId: string | null,
  ): Promise<void> {
    const slug = slugifyKey(label);
    if (!slug) return; // empty/invalid labels are rejected elsewhere by the key check
    const siblings = await this.db.contactFieldDefinition.findMany({
      where: { teamId, ...(excludeId ? { id: { not: excludeId } } : {}) },
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
  teamId: string;
  key: string;
  label: string;
  order: number;
  isVisible: boolean;
}): ContactFieldDefinition {
  return {
    id: r.id,
    teamId: r.teamId,
    key: r.key,
    label: r.label,
    order: r.order,
    isVisible: r.isVisible,
  };
}

/**
 * Lowercase + underscored slug from a label. Keeps the JSONB key readable in
 * psql (`customFields->>'order_id'`) without letting users type collisions
 * like "Order ID" vs "order id" against the unique index.
 */
function slugifyKey(label: string): string {
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
