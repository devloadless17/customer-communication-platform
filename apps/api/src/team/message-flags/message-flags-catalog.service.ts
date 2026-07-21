import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";

import type {
  MessageFlagDefinition,
  MessageFlagDefinitionWithUsage,
} from "@ccp/shared/message-flags/types";
import { TAG_COLORS } from "@ccp/shared/types";

import { DbService } from "../../db/db.service";
import { EventBus } from "../../events/event-bus.module";
import {
  MESSAGE_FLAG_DEFINITION_SELECT,
  listFlagDefinitions,
  mapFlagDefinition,
} from "@/lib/message-flags/queries";
import type {
  CreateFlagDefinitionInput,
  UpdateFlagDefinitionInput,
} from "./message-flags-catalog.schemas";

/**
 * The message-flag catalog — which triage flags this team can raise.
 *
 * Side-effect contract, identical to TagsService: every mutation publishes
 * `team.catalog_changed` with `scope: "message-flags"`, which drives the
 * `team:catalog:changed` socket frame so every open inbox picks up a
 * new/renamed/retired flag without a reload.
 *
 * Delete policy — the one rule worth knowing: a definition with history is NOT
 * deletable, it is ARCHIVED. Hard-deleting would either orphan the triage
 * record of every complaint ever raised under it, or cascade them away
 * entirely. The FK is `onDelete: Restrict` as the backstop; this service turns
 * that into a friendly 409 that names the alternative.
 */
@Injectable()
export class MessageFlagsCatalogService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /** The picker's list — live definitions only. */
  async list(teamId: string): Promise<MessageFlagDefinition[]> {
    return listFlagDefinitions(this.db, teamId);
  }

  /**
   * The settings screen's list — archived included, each with its usage counts
   * so the UI can say "12 flags use this, 3 still open" before an archive and
   * disable Delete when anything at all uses it.
   *
   * Counts come from Prisma's `_count` with a filter, i.e. two correlated
   * aggregates in ONE query — not a per-definition loop (that would be an N+1
   * over the catalog).
   */
  async listWithUsage(teamId: string): Promise<MessageFlagDefinitionWithUsage[]> {
    const rows = await this.db.messageFlagDefinition.findMany({
      where: { teamId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        ...MESSAGE_FLAG_DEFINITION_SELECT,
        _count: { select: { flags: true } },
      },
    });
    const openCounts = await this.db.messageFlag.groupBy({
      by: ["definitionId"],
      where: { teamId, status: "open" },
      _count: { _all: true },
    });
    const openById = new Map(openCounts.map((g) => [g.definitionId, g._count._all]));

    return rows.map((row) => ({
      ...mapFlagDefinition(row),
      totalCount: row._count.flags,
      openCount: openById.get(row.id) ?? 0,
    }));
  }

  async create(
    teamId: string,
    input: CreateFlagDefinitionInput,
  ): Promise<MessageFlagDefinition> {
    try {
      const created = await this.db.messageFlagDefinition.create({
        data: {
          teamId,
          name: input.name,
          color: normalizeColor(input.color),
          description: input.description ?? null,
          sortOrder: input.sortOrder ?? 0,
        },
        select: MESSAGE_FLAG_DEFINITION_SELECT,
      });
      await this.publishCatalogChanged(teamId);
      return mapFlagDefinition(created);
    } catch (err) {
      throwIfUniqueViolation(err, `A message flag named "${input.name}" already exists.`);
      throw err;
    }
  }

  async update(
    teamId: string,
    id: string,
    input: UpdateFlagDefinitionInput,
  ): Promise<MessageFlagDefinition> {
    const existing = await this.db.messageFlagDefinition.findFirst({
      where: { id, teamId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "message_flag_definition_not_found" });

    try {
      const updated = await this.db.messageFlagDefinition.update({
        where: { id },
        data: input,
        select: MESSAGE_FLAG_DEFINITION_SELECT,
      });
      await this.publishCatalogChanged(teamId);
      return mapFlagDefinition(updated);
    } catch (err) {
      throwIfUniqueViolation(err, "A message flag with that name already exists.");
      throw err;
    }
  }

  async remove(teamId: string, id: string): Promise<void> {
    const existing = await this.db.messageFlagDefinition.findFirst({
      where: { id, teamId },
      select: { id: true, _count: { select: { flags: true } } },
    });
    if (!existing) throw new NotFoundException({ error: "message_flag_definition_not_found" });

    if (existing._count.flags > 0) {
      throw new ConflictException({
        error: "message_flag_definition_in_use",
        detail:
          `This flag has been raised ${existing._count.flags} time(s). ` +
          "Archive it instead — archiving hides it from the picker while keeping the history readable.",
        flagCount: existing._count.flags,
      });
    }

    await this.db.messageFlagDefinition.delete({ where: { id } });
    await this.publishCatalogChanged(teamId);
  }

  private async publishCatalogChanged(teamId: string): Promise<void> {
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "message-flags" });
  }
}

/** Shares the tag palette on purpose — one color vocabulary across the app. */
function normalizeColor(v: unknown): string {
  if (typeof v !== "string") return "slate";
  return (TAG_COLORS as string[]).includes(v) ? v : "slate";
}

function throwIfUniqueViolation(err: unknown, detail: string): void {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  ) {
    throw new ConflictException({ error: "name taken", detail });
  }
}
