import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { TAG_COLORS, type Tag, type TagColor } from "@ccp/shared/types";

import { scrubViewReferences } from "@/lib/inbox-views/scrub";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type { CreateTagInput, UpdateTagInput } from "./tags.schemas";

/** See create(). `list()` is deliberately unpaginated; this is its bound. */
const MAX_TAGS_PER_WORKSPACE = 300;

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
    const [rows, views] = await Promise.all([
      this.db.tag.findMany({
        where: { workspaceId },
        select: { id: true, _count: { select: { contacts: true } } },
      }),
      // Saved views that filter on a tag count as usage too. Counting contacts
      // alone under-reported the blast radius of a delete: a tag on zero
      // contacts reads as "unused" while a shared view still filters on it.
      this.db.inboxView.findMany({ where: { workspaceId }, select: { filters: true } }),
    ]);
    const usage: Record<string, number> = {};
    for (const r of rows) usage[r.id] = r._count.contacts;
    for (const v of views) {
      const tagIds = (v.filters as { tagIds?: unknown } | null)?.tagIds;
      if (!Array.isArray(tagIds)) continue;
      for (const t of tagIds) {
        if (typeof t === "string" && usage[t] !== undefined) usage[t] += 1;
      }
    }
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
    // Bounded like every other catalog (stages 30, contact fields 50, knowledge
    // docs 50). `list()` is unpaginated ON PURPOSE ("small N") and every client
    // in the workspace refetches it on `team.catalog_changed` — so an uncapped
    // catalog is a workspace-wide fanout of an unbounded payload, and
    // `tags:manage` defaults to TRUE for agents.
    const count = await this.db.tag.count({ where: { workspaceId } });
    if (count >= MAX_TAGS_PER_WORKSPACE) {
      throw new BadRequestException({
        error: "tag_limit_reached",
        detail: `This workspace has reached its limit of ${MAX_TAGS_PER_WORKSPACE} tags. Delete an unused one to make room.`,
      });
    }
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
    if (!existing) throw new NotFoundException({ error: "tag_not_found" });

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
    if (!existing) throw new NotFoundException({ error: "tag_not_found" });

    // Delete the tag AND scrub it out of every saved view that filtered on it,
    // in one transaction — same discipline as a contact-field delete, which
    // strips the JSONB key from every contact alongside the definition.
    //
    // Without this the FK cascade takes the M2M rows but leaves a DANGLING id
    // inside `InboxView.criteria`, and `inboxViewWhereClauses` turns it into a
    // predicate that can never match: in `tagMatch: "all"` mode the view
    // returns an empty inbox forever, with nothing on screen explaining why —
    // and a SHARED view does that for the whole workspace. Every other catalog
    // delete calls the same helper.
    await this.db.$transaction(async (tx) => {
      await tx.tag.delete({ where: { id } });
      await scrubViewReferences(tx, workspaceId, { tagIds: [id] });
    });

    // Only the tags frame: saved views are not event-driven (nothing in the
    // codebase publishes for them), so a corrected criteria document is picked
    // up on the next view load. The scrub is what matters — the stale in-memory
    // copy still filters on a tag that no longer matches anything either way.
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
    throw new ConflictException({ error: "name_taken", detail });
  }
}
