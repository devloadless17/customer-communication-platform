import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { TAG_COLORS, type Tag, type TagColor } from "@ccp/shared/types";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type { CreateTagInput, UpdateTagInput } from "./tags.schemas";

/**
 * Tag catalog operations. Everything below the HTTP layer goes here so the
 * controller stays a thin auth-validate-delegate shell.
 *
 * Side effect contract: every mutation publishes `team.catalog_changed`
 * with `scope: "tags"`. Two subscribers ride on that event:
 *
 *   - NestJS RealtimeFanout emits `team:catalog:changed` socket event
 *     (clients call `router.refresh()`).
 *   - Next.js cache-revalidate calls `revalidateTag("tags")` so the next
 *     RSC render reads fresh data via [lib/queries/tags.ts](../../../../../../lib/queries/tags.ts)'s
 *     `unstable_cache`.
 */
@Injectable()
export class TagsService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Contact-usage count per tag. Settings/tags shows this so an admin knows
   * how many contact rows would lose a label before they confirm a delete.
   * One aggregate query so 100 tags don't fan into 100 SELECTs.
   */
  async usage(workspaceId: string): Promise<Record<string, number>> {
    const rows = await this.db.tag.findMany({
      where: { workspaceId },
      select: { id: true, _count: { select: { contacts: true } } },
    });
    const usage: Record<string, number> = {};
    for (const r of rows) usage[r.id] = r._count.contacts;
    return usage;
  }

  async list(workspaceId: string): Promise<Tag[]> {
    const rows = await this.db.tag.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      color: normalizeColor(r.color),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async create(workspaceId: string, input: CreateTagInput): Promise<Tag> {
    const color = normalizeColor(input.color);
    try {
      const created = await this.db.tag.create({
        data: { workspaceId, name: input.name, color },
      });
      await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "tags" });
      return {
        id: created.id,
        workspaceId: created.workspaceId,
        name: created.name,
        color: normalizeColor(created.color),
        createdAt: created.createdAt.toISOString(),
      };
    } catch (err) {
      throwIfUniqueViolation(err, `A tag named "${input.name}" already exists.`);
      throw err;
    }
  }

  async update(workspaceId: string, id: string, input: UpdateTagInput): Promise<Tag> {
    const existing = await this.db.tag.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException({ error: "tag not found" });

    try {
      const updated = await this.db.tag.update({ where: { id }, data: input });
      await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "tags" });
      return {
        id: updated.id,
        workspaceId: updated.workspaceId,
        name: updated.name,
        color: normalizeColor(updated.color),
        createdAt: updated.createdAt.toISOString(),
      };
    } catch (err) {
      throwIfUniqueViolation(err, "A tag with that name already exists.");
      throw err;
    }
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.db.tag.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException({ error: "tag not found" });
    // Implicit M2M join rows go with the delete — contacts simply lose this tag.
    await this.db.tag.delete({ where: { id } });
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "tags" });
  }
}

function normalizeColor(v: unknown): TagColor {
  if (typeof v !== "string") return "slate";
  return (TAG_COLORS as string[]).includes(v) ? (v as TagColor) : "slate";
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
