import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { canManageContactFields } from "@ccp/shared/auth/permissions";
import { isReservedFieldKey } from "@ccp/shared/contacts/reserved-fields";
import type { ContactFieldDefinition, Role } from "@ccp/shared/types";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  ContactPanelBuiltins,
  CreateContactFieldInput,
  UpdateContactFieldInput,
} from "./contact-fields.schemas";

const MAX_FIELDS_PER_TEAM = 50;

/**
 * Default visibility for built-in contact-panel fields. Used when the team's
 * `contactPanelBuiltins` JSON is empty (every team starts that way). Preserves
 * the pre-feature behavior: email + location + firstContacted are rendered;
 * phone is rendered too but isn't toggleable so it's not in this map.
 */
const DEFAULT_BUILTINS: Required<ContactPanelBuiltins> = {
  email: true,
  location: true,
  firstContacted: true,
};

function resolveBuiltins(raw: unknown): Required<ContactPanelBuiltins> {
  if (!raw || typeof raw !== "object") return DEFAULT_BUILTINS;
  const r = raw as Record<string, unknown>;
  return {
    email: typeof r.email === "boolean" ? r.email : DEFAULT_BUILTINS.email,
    location: typeof r.location === "boolean" ? r.location : DEFAULT_BUILTINS.location,
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
    role: Role,
    patch: ContactPanelBuiltins,
  ): Promise<Required<ContactPanelBuiltins>> {
    requireManage(role);
    const current = await this.getBuiltins(teamId);
    const next: Required<ContactPanelBuiltins> = {
      email: patch.email ?? current.email,
      location: patch.location ?? current.location,
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
    role: Role,
    input: CreateContactFieldInput,
  ): Promise<ContactFieldDefinition> {
    requireManage(role);

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
    role: Role,
    id: string,
    input: UpdateContactFieldInput,
  ): Promise<ContactFieldDefinition> {
    requireManage(role);

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

    const updated = await this.db.contactFieldDefinition.update({
      where: { id },
      data: input,
    });
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "contact-fields",
    });
    return toDto(updated);
  }

  async remove(teamId: string, role: Role, id: string): Promise<void> {
    requireManage(role);

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
    await this.db.$transaction([
      this.db.$executeRaw`
        UPDATE "Contact"
        SET "customFields" = "customFields" - ${def.key}
        WHERE "teamId" = ${teamId}
          AND "customFields" ? ${def.key}
      `,
      this.db.contactFieldDefinition.delete({ where: { id } }),
    ]);

    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "contact-fields",
    });
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

function requireManage(role: Role): void {
  if (!canManageContactFields(role)) throw new ForbiddenException({ error: "forbidden" });
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
