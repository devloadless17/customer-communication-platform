import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { TAG_COLORS, type ContactStage, type TagColor } from "@ccp/shared/types";

import { invalidateDefaultStageCache } from "@/lib/queries/stages";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  CreateStageInput,
  ReorderStagesInput,
  UpdateStageInput,
} from "./stages.schemas";

const MAX_STAGES_PER_TEAM = 30;

@Injectable()
export class StagesService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /** Any signed-in user can read the catalog (contact panel + table need it). */
  async list(teamId: string): Promise<ContactStage[]> {
    const rows = await this.db.contactStage.findMany({
      where: { teamId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(toDto);
  }

  /**
   * Contact counts per stage + a roll-up of contacts with NO stage at all.
   * Drives the settings/stages page badges. One indexed aggregate query so
   * 50 stages don't fan out into 50 SELECTs.
   */
  async counts(
    teamId: string,
  ): Promise<{ countsByStageId: Record<string, number>; unassignedCount: number }> {
    const rows = await this.db.contact.groupBy({
      by: ["stageId"],
      // Soft-deleted contacts are out of the directory, so they must not
      // inflate the per-stage badge counts.
      where: { teamId, deletedAt: null },
      _count: { _all: true },
    });
    const countsByStageId: Record<string, number> = {};
    let unassignedCount = 0;
    for (const row of rows) {
      if (row.stageId === null) unassignedCount = row._count._all;
      else countsByStageId[row.stageId] = row._count._all;
    }
    return { countsByStageId, unassignedCount };
  }

  /** Gated by the caller's resolved `stages:manage` capability. */
  async create(
    teamId: string,
    canManage: boolean,
    input: CreateStageInput,
  ): Promise<ContactStage> {
    requireManage(canManage);

    // Single read to learn count + next position + whether a default exists.
    const existing = await this.db.contactStage.findMany({
      where: { teamId },
      select: { id: true, position: true, isDefault: true, color: true },
      orderBy: { position: "desc" },
    });
    if (existing.length >= MAX_STAGES_PER_TEAM) {
      throw new BadRequestException({
        error: `at most ${MAX_STAGES_PER_TEAM} stages per team`,
      });
    }
    const nextPosition = (existing[0]?.position ?? -1) + 1;
    const isDefault = existing.length === 0;
    // Round-robin a fresh palette color when the user didn't pick one — so
    // a fresh team's stages don't all default to slate (which reads as
    // identical washed-out chips). Stable across runs because the palette
    // order itself is stable.
    const color =
      typeof input.color === "string"
        ? pickColor(input.color)
        : pickNextPaletteColor(existing.map((e) => e.color));

    try {
      const created = await this.db.contactStage.create({
        data: { teamId, name: input.name, color, position: nextPosition, isDefault },
      });
      await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "stages" });
      return toDto(created);
    } catch (err) {
      throwIfUniqueViolation(err, "a stage with this name already exists");
      throw err;
    }
  }

  async update(
    teamId: string,
    canManage: boolean,
    id: string,
    input: UpdateStageInput,
  ): Promise<ContactStage> {
    requireManage(canManage);

    const existing = await this.db.contactStage.findFirst({
      where: { id, teamId },
      select: { id: true, isDefault: true },
    });
    if (!existing) throw new NotFoundException({ error: "not found" });

    // Demoting the current default is not allowed — admins promote a
    // different stage instead. Otherwise the team would have no default
    // and contact creation would have nowhere to park new rows.
    if (input.isDefault === false && existing.isDefault) {
      throw new BadRequestException({
        error: "can't unset isDefault directly — promote another stage to default instead",
      });
    }

    try {
      // Promoting one stage to default requires demoting the previous in
      // the same transaction; otherwise two defaults could coexist for a
      // round-trip and a concurrent create could pick the wrong one.
      const updated = await this.db.$transaction(async (tx) => {
        if (input.isDefault === true && !existing.isDefault) {
          await tx.contactStage.updateMany({
            where: { teamId, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.contactStage.update({ where: { id }, data: input });
      });
      // The default-stage memo in lib/queries/stages.ts holds a 5-min copy
      // for the webhook hot path; bust on every stage mutation so a flipped
      // default propagates immediately to inbound-message ingest.
      if (input.isDefault !== undefined) invalidateDefaultStageCache(teamId);
      await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "stages" });
      return toDto(updated);
    } catch (err) {
      throwIfUniqueViolation(err, "a stage with this name already exists");
      throw err;
    }
  }

  async remove(teamId: string, canManage: boolean, id: string): Promise<void> {
    requireManage(canManage);

    const stage = await this.db.contactStage.findFirst({
      where: { id, teamId },
      select: { id: true, isDefault: true },
    });
    if (!stage) throw new NotFoundException({ error: "not found" });

    // Refuse delete-while-in-use; carry the count back so the UI can
    // render "12 contacts still here — move them first". (Fast pre-check for a
    // friendly error; the authoritative re-check happens inside the tx below.)
    const contactCount = await this.db.contact.count({
      // Only live contacts block stage deletion — a tombstoned contact that
      // still carries this stageId shouldn't keep the stage un-deletable.
      where: { teamId, stageId: id, deletedAt: null },
    });
    if (contactCount > 0) {
      throw new ConflictException({
        error: "stage in use",
        detail: `${contactCount} contact${contactCount === 1 ? " is" : "s are"} still in this stage. Move them to another stage first.`,
        contactCount,
      });
    }

    // Re-check in-use AND default-protection INSIDE a Serializable tx, then
    // delete — so a concurrent assign-into-this-stage (manual/setTags/bulk) or
    // a concurrent default-promotion can't slip between the check and the
    // delete. Without this, the FK `onDelete: SetNull` would silently null the
    // racing contact's stageId (TOCTOU orphan). Serializable (no retry loop —
    // stage delete is a rare admin op; a P2034 conflict surfaces as a clean
    // error the admin re-tries) closes the window cheaply.
    await this.db.$transaction(
      async (tx) => {
        const liveInStage = await tx.contact.count({
          where: { teamId, stageId: id, deletedAt: null },
        });
        if (liveInStage > 0) {
          throw new ConflictException({
            error: "stage in use",
            detail: `${liveInStage} contact${liveInStage === 1 ? " is" : "s are"} still in this stage. Move them to another stage first.`,
            contactCount: liveInStage,
          });
        }
        // Deleting the default while siblings exist is refused — admin must
        // promote one first. Deleting the LAST stage is allowed
        // (ensureDefaultStage re-creates one on next contact create).
        if (stage.isDefault) {
          const otherCount = await tx.contactStage.count({
            where: { teamId, NOT: { id } },
          });
          if (otherCount > 0) {
            throw new ConflictException({
              error: "default stage",
              detail:
                "This is the default stage. Promote another stage to default before deleting.",
            });
          }
        }
        await tx.contactStage.delete({ where: { id } });
      },
      { isolationLevel: "Serializable" },
    );
    // Bust the default-stage memo so a cached pointer to the just-deleted
    // stage can't hand a deleted id to the webhook hot path.
    if (stage.isDefault) invalidateDefaultStageCache(teamId);
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "stages" });
  }

  /**
   * Bulk-reorder. `orderedIds[i].position = i`. Ids not in the list keep
   * their current position. Capped at 30 stages so the per-row update
   * transaction stays tiny.
   */
  async reorder(
    teamId: string,
    canManage: boolean,
    input: ReorderStagesInput,
  ): Promise<void> {
    requireManage(canManage);
    const ids = input.orderedIds;
    if (ids.length === 0) return;

    // Cross-tenant guard: every id must belong to this team or the whole
    // request rejects. Without this a malicious client could rewrite
    // positions on another tenant's stages.
    const owned = await this.db.contactStage.findMany({
      where: { teamId, id: { in: ids } },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new BadRequestException({ error: "one or more ids are not in this team" });
    }

    await this.db.$transaction(
      ids.map((id, index) =>
        this.db.contactStage.update({ where: { id }, data: { position: index } }),
      ),
    );
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "stages" });
  }
}

function toDto(r: {
  id: string;
  teamId: string;
  name: string;
  color: string;
  position: number;
  isDefault: boolean;
}): ContactStage {
  return {
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    color: r.color as TagColor,
    position: r.position,
    isDefault: r.isDefault,
  };
}

function pickColor(v: unknown): TagColor {
  if (typeof v !== "string") return "slate";
  return (TAG_COLORS as readonly string[]).includes(v) ? (v as TagColor) : "slate";
}

/**
 * Choose the first palette color not yet used by an existing stage in the
 * team. Falls back to slate once all 9 are taken. Pure function — caller
 * passes the already-used color set.
 */
function pickNextPaletteColor(used: string[]): TagColor {
  const usedSet = new Set(used);
  for (const c of TAG_COLORS) {
    if (!usedSet.has(c)) return c;
  }
  return "slate";
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
