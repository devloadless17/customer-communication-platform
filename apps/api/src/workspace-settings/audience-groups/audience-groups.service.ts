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

  list(workspaceId: string) {
    return listAudienceGroups(workspaceId);
  }

  async get(workspaceId: string, id: string) {
    const group = await getAudienceGroup(workspaceId, id);
    if (!group) throw new NotFoundException({ error: "not_found" });
    return group;
  }

  /** `userId` is null when an API key created it — an integration is not a person. */
  async create(workspaceId: string, userId: string | null, input: CreateAudienceGroupInput) {
    const description = input.description?.length ? input.description : null;

    // Cross-team id stuffing defense: filter to ids that actually belong
    // to this team. Foreign ids get silently dropped.
    const [validTagIds, validContactIds] = await Promise.all([
      this.ownedTagIds(workspaceId, input.tagIds),
      this.ownedContactIds(workspaceId, input.contactIds),
    ]);

    try {
      const created = await this.db.audienceGroup.create({
        data: {
          workspaceId,
          createdById: userId,
          name: input.name,
          description,
          tags: { connect: validTagIds.map((id) => ({ id })) },
          contacts: { connect: validContactIds.map((id) => ({ id })) },
        },
        select: { id: true },
      });
      const dto = await getAudienceGroup(workspaceId, created.id);
      await this.bus.publish({
        type: "team.catalog_changed",
        workspaceId,
        scope: "audience-groups",
      });
      return dto;
    } catch (err) {
      throwIfUniqueViolation(err, `A group named "${input.name}" already exists.`);
      throw err;
    }
  }

  async update(workspaceId: string, id: string, input: UpdateAudienceGroupInput) {
    const existing = await this.db.audienceGroup.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException({ error: "not_found" });

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
      const owned = await this.ownedTagIds(workspaceId, input.tagIds);
      data.tags = { set: owned.map((tid) => ({ id: tid })) };
    }
    if (input.contactIds !== undefined) {
      const owned = await this.ownedContactIds(workspaceId, input.contactIds);
      data.contacts = { set: owned.map((cid) => ({ id: cid })) };
    }

    try {
      await this.db.audienceGroup.update({ where: { id }, data });
      const updated = await getAudienceGroup(workspaceId, id);
      await this.bus.publish({
        type: "team.catalog_changed",
        workspaceId,
        scope: "audience-groups",
      });
      return updated;
    } catch (err) {
      throwIfUniqueViolation(err, "A group with that name already exists.");
      throw err;
    }
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.db.audienceGroup.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException({ error: "not_found" });
    // Broadcasts that referenced this group keep their `audienceGroupName`
    // snapshot for the audit trail — only the join row goes.
    await this.db.audienceGroup.delete({ where: { id } });
    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "audience-groups",
    });
  }

  private async ownedTagIds(workspaceId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.tag.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async ownedContactIds(workspaceId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.contact.findMany({
      // deletedAt: null — don't connect a soft-deleted contact to a group (it
      // would render as a phantom chip the member count excludes).
      where: { workspaceId, deletedAt: null, id: { in: ids } },
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
    throw new ConflictException({ error: "name_taken", detail });
  }
}
