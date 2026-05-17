import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { canManageStages } from "@ccp/shared/auth/permissions";
import { TAG_COLORS, type ContactStage, type Role, type TagColor } from "@ccp/shared/types";

import { EventBus } from "../../events/event-bus.module";
import { PrismaService } from "../../prisma/prisma.service";
import type {
  CreateStageInput,
  ReorderStagesInput,
  UpdateStageInput,
} from "./stages.schemas";

const MAX_STAGES_PER_TEAM = 30;

@Injectable()
export class StagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /** Any signed-in user can read the catalog (contact panel + table need it). */
  async list(teamId: string): Promise<ContactStage[]> {
    const rows = await this.prisma.contactStage.findMany({
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
    const rows = await this.prisma.contact.groupBy({
      by: ["stageId"],
      where: { teamId },
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

  /** Admin / manager / superAdmin only — gated by canManageStages. */
  async create(
    teamId: string,
    role: Role,
    input: CreateStageInput,
  ): Promise<ContactStage> {
    requireManage(role);
    const color = pickColor(input.color);

    // Single read to learn count + next position + whether a default exists.
    const existing = await this.prisma.contactStage.findMany({
      where: { teamId },
      select: { id: true, position: true, isDefault: true },
      orderBy: { position: "desc" },
    });
    if (existing.length >= MAX_STAGES_PER_TEAM) {
      throw new BadRequestException({
        error: `at most ${MAX_STAGES_PER_TEAM} stages per team`,
      });
    }
    const nextPosition = (existing[0]?.position ?? -1) + 1;
    const isDefault = existing.length === 0;

    try {
      const created = await this.prisma.contactStage.create({
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
    role: Role,
    id: string,
    input: UpdateStageInput,
  ): Promise<ContactStage> {
    requireManage(role);

    const existing = await this.prisma.contactStage.findFirst({
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
      const updated = await this.prisma.$transaction(async (tx) => {
        if (input.isDefault === true && !existing.isDefault) {
          await tx.contactStage.updateMany({
            where: { teamId, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.contactStage.update({ where: { id }, data: input });
      });
      await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "stages" });
      return toDto(updated);
    } catch (err) {
      throwIfUniqueViolation(err, "a stage with this name already exists");
      throw err;
    }
  }

  async remove(teamId: string, role: Role, id: string): Promise<void> {
    requireManage(role);

    const stage = await this.prisma.contactStage.findFirst({
      where: { id, teamId },
      select: { id: true, isDefault: true },
    });
    if (!stage) throw new NotFoundException({ error: "not found" });

    // Refuse delete-while-in-use; carry the count back so the UI can
    // render "12 contacts still here — move them first".
    const contactCount = await this.prisma.contact.count({
      where: { teamId, stageId: id },
    });
    if (contactCount > 0) {
      throw new ConflictException({
        error: "stage in use",
        detail: `${contactCount} contact${contactCount === 1 ? " is" : "s are"} still in this stage. Move them to another stage first.`,
        contactCount,
      });
    }

    // Deleting the default while siblings exist is refused — admin must
    // promote one first. Deleting the LAST stage is allowed (ensureDefaultStage
    // re-creates one on next contact create).
    if (stage.isDefault) {
      const otherCount = await this.prisma.contactStage.count({
        where: { teamId, NOT: { id } },
      });
      if (otherCount > 0) {
        throw new ConflictException({
          error: "default stage",
          detail: "This is the default stage. Promote another stage to default before deleting.",
        });
      }
    }

    await this.prisma.contactStage.delete({ where: { id } });
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "stages" });
  }

  /**
   * Bulk-reorder. `orderedIds[i].position = i`. Ids not in the list keep
   * their current position. Capped at 30 stages so the per-row update
   * transaction stays tiny.
   */
  async reorder(
    teamId: string,
    role: Role,
    input: ReorderStagesInput,
  ): Promise<void> {
    requireManage(role);
    const ids = input.orderedIds;
    if (ids.length === 0) return;

    // Cross-tenant guard: every id must belong to this team or the whole
    // request rejects. Without this a malicious client could rewrite
    // positions on another tenant's stages.
    const owned = await this.prisma.contactStage.findMany({
      where: { teamId, id: { in: ids } },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new BadRequestException({ error: "one or more ids are not in this team" });
    }

    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.contactStage.update({ where: { id }, data: { position: index } }),
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

function requireManage(role: Role): void {
  if (!canManageStages(role)) throw new ForbiddenException({ error: "forbidden" });
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
