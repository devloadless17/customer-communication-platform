import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { getAudienceGroup, listAudienceGroups } from "@/lib/queries";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  CreateAudienceGroupInput,
  UpdateAudienceGroupInput,
} from "./audience-groups.schemas";

@Injectable()
export class AudienceGroupsService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  list(teamId: string) {
    return listAudienceGroups(teamId);
  }

  async get(teamId: string, id: string) {
    const group = await getAudienceGroup(teamId, id);
    if (!group) throw new NotFoundException({ error: "not found" });
    return group;
  }

  async create(teamId: string, userId: string, input: CreateAudienceGroupInput) {
    const description = input.description?.length ? input.description : null;

    // Cross-team id stuffing defense: filter to ids that actually belong
    // to this team. Foreign ids get silently dropped.
    const [validTagIds, validContactIds] = await Promise.all([
      this.ownedTagIds(teamId, input.tagIds),
      this.ownedContactIds(teamId, input.contactIds),
    ]);

    try {
      const created = await this.db.audienceGroup.create({
        data: {
          teamId,
          createdById: userId,
          name: input.name,
          description,
          tags: { connect: validTagIds.map((id) => ({ id })) },
          contacts: { connect: validContactIds.map((id) => ({ id })) },
        },
        select: { id: true },
      });
      const dto = await getAudienceGroup(teamId, created.id);
      await this.bus.publish({
        type: "team.catalog_changed",
        teamId,
        scope: "audience-groups",
      });
      return dto;
    } catch (err) {
      throwIfUniqueViolation(err, `A group named "${input.name}" already exists.`);
      throw err;
    }
  }

  async update(teamId: string, id: string, input: UpdateAudienceGroupInput) {
    const existing = await this.db.audienceGroup.findFirst({ where: { id, teamId } });
    if (!existing) throw new NotFoundException({ error: "not found" });

    // Build the update payload incrementally so unset fields stay untouched.
    // tagIds / contactIds use full-replace ("set") semantics when sent.
    const data: {
      name?: string;
      description?: string | null;
      tags?: { set: { id: string }[] };
      contacts?: { set: { id: string }[] };
    } = {};

    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.tagIds !== undefined) {
      const owned = await this.ownedTagIds(teamId, input.tagIds);
      data.tags = { set: owned.map((tid) => ({ id: tid })) };
    }
    if (input.contactIds !== undefined) {
      const owned = await this.ownedContactIds(teamId, input.contactIds);
      data.contacts = { set: owned.map((cid) => ({ id: cid })) };
    }

    try {
      await this.db.audienceGroup.update({ where: { id }, data });
      const updated = await getAudienceGroup(teamId, id);
      await this.bus.publish({
        type: "team.catalog_changed",
        teamId,
        scope: "audience-groups",
      });
      return updated;
    } catch (err) {
      throwIfUniqueViolation(err, "A group with that name already exists.");
      throw err;
    }
  }

  async remove(teamId: string, id: string): Promise<void> {
    const existing = await this.db.audienceGroup.findFirst({ where: { id, teamId } });
    if (!existing) throw new NotFoundException({ error: "not found" });
    // Broadcasts that referenced this group keep their `audienceGroupName`
    // snapshot for the audit trail — only the join row goes.
    await this.db.audienceGroup.delete({ where: { id } });
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "audience-groups",
    });
  }

  private async ownedTagIds(teamId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.tag.findMany({
      where: { teamId, id: { in: ids } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async ownedContactIds(teamId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.contact.findMany({
      // deletedAt: null — don't connect a soft-deleted contact to a group (it
      // would render as a phantom chip the member count excludes).
      where: { teamId, deletedAt: null, id: { in: ids } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
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
