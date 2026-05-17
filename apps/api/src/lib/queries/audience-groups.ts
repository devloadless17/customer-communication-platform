import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { AudienceGroupDto } from "@ccp/shared/dtos";
import type { Tag, TagColor } from "@ccp/shared/types";

// Audience groups: saved named lists of contacts. Hybrid composition —
// manual contact ids PLUS any contact carrying one of the group's tags.
// The resolver below is the single source of truth for "who's in this
// group right now"; both the audience-groups API and the broadcast runner
// call it.

// DTO shape lives in @ccp/shared/dtos so client components in apps/web
// can name it without reaching across the package boundary.
export type { AudienceGroupDto };

export async function listAudienceGroups(teamId: string): Promise<AudienceGroupDto[]> {
  const rows = await db.audienceGroup.findMany({
    where: { teamId },
    orderBy: { createdAt: "desc" },
    include: {
      createdBy: { select: { name: true } },
      tags: { select: { id: true } },
      contacts: { select: { id: true } },
    },
  });

  // Resolve member counts for every group in ONE query instead of one per
  // group (the previous Promise.all spawned N COUNT queries — fine at a
  // dozen groups, painful at fifty). Strategy:
  //   1. Collect every tag id referenced by any group on this page.
  //   2. Fetch each tag's contact carriers, scoped to this team, in a
  //      single Prisma query.
  //   3. For each group, union (manual contacts) ∪ (contacts carrying any
  //      of its tags) in memory and take the set size.
  // Memory bound: O(tagged-contacts × tags-per-contact). At the scale where
  // that gets uncomfortable (~50k contacts × 5+ tags) switch to a CTE-based
  // raw SQL aggregate that does the union server-side.
  const usedTagIds = Array.from(
    new Set(rows.flatMap((g) => g.tags.map((t) => t.id))),
  );
  const tagCarriers =
    usedTagIds.length > 0
      ? await db.contact.findMany({
          where: { teamId, tags: { some: { id: { in: usedTagIds } } } },
          select: {
            id: true,
            // Scope the tag list to the ids we care about; otherwise Prisma
            // would ship every tag on every matching contact.
            tags: {
              where: { id: { in: usedTagIds } },
              select: { id: true },
            },
          },
        })
      : [];

  const contactsByTag = new Map<string, Set<string>>();
  for (const c of tagCarriers) {
    for (const t of c.tags) {
      let bucket = contactsByTag.get(t.id);
      if (!bucket) {
        bucket = new Set();
        contactsByTag.set(t.id, bucket);
      }
      bucket.add(c.id);
    }
  }

  return rows.map((g) => {
    const members = new Set<string>(g.contacts.map((c) => c.id));
    for (const t of g.tags) {
      const carriers = contactsByTag.get(t.id);
      if (!carriers) continue;
      for (const id of carriers) members.add(id);
    }
    return {
      id: g.id,
      teamId: g.teamId,
      name: g.name,
      description: g.description,
      tagIds: g.tags.map((t) => t.id),
      contactIds: g.contacts.map((c) => c.id),
      memberCount: members.size,
      createdById: g.createdById,
      createdByName: g.createdBy?.name ?? "Removed user",
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    };
  });
}

export async function getAudienceGroup(
  teamId: string,
  id: string,
): Promise<AudienceGroupDto | null> {
  const g = await db.audienceGroup.findFirst({
    where: { id, teamId },
    include: {
      createdBy: { select: { name: true } },
      tags: { select: { id: true } },
      contacts: { select: { id: true } },
    },
  });
  if (!g) return null;
  const memberCount = await resolveAudienceGroupMemberCount(teamId, {
    tagIds: g.tags.map((t) => t.id),
    manualContactIds: g.contacts.map((c) => c.id),
  });
  return {
    id: g.id,
    teamId: g.teamId,
    name: g.name,
    description: g.description,
    tagIds: g.tags.map((t) => t.id),
    contactIds: g.contacts.map((c) => c.id),
    memberCount,
    createdById: g.createdById,
    createdByName: g.createdBy?.name ?? "Removed user",
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

/**
 * Resolve the actual contact-id set for a group. Used by the broadcast
 * runner when expanding a group audience into BroadcastRecipient rows.
 * UNION of manual + tag-matched, deduped server-side.
 */
export async function resolveAudienceGroupMembers(
  teamId: string,
  { tagIds, manualContactIds }: { tagIds: string[]; manualContactIds: string[] },
): Promise<string[]> {
  if (tagIds.length === 0 && manualContactIds.length === 0) return [];

  const where: Prisma.ContactWhereInput =
    tagIds.length > 0
      ? {
          teamId,
          OR: [
            { id: { in: manualContactIds } },
            { tags: { some: { id: { in: tagIds } } } },
          ],
        }
      : { teamId, id: { in: manualContactIds } };

  const rows = await db.contact.findMany({
    where,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

async function resolveAudienceGroupMemberCount(
  teamId: string,
  args: { tagIds: string[]; manualContactIds: string[] },
): Promise<number> {
  return countAudienceContacts(teamId, {
    tagIds: args.tagIds,
    contactIds: args.manualContactIds,
  });
}

/**
 * Count of contacts that carry ANY of `tagIds` OR appear in `contactIds` —
 * the audience-group union semantics. Powers the live recipient-count badges
 * in the broadcast wizard and the group form WITHOUT shipping the whole
 * contact list to the browser (the old approach was a client-side filter over
 * every contact, which falls apart past a few thousand).
 */
export async function countAudienceContacts(
  teamId: string,
  { tagIds = [], contactIds = [] }: { tagIds?: string[]; contactIds?: string[] },
): Promise<number> {
  const tags = tagIds.filter((s) => s.length > 0);
  const ids = contactIds.filter((s) => s.length > 0);
  if (tags.length === 0 && ids.length === 0) return 0;
  const where: Prisma.ContactWhereInput =
    tags.length > 0 && ids.length > 0
      ? {
          teamId,
          OR: [{ id: { in: ids } }, { tags: { some: { id: { in: tags } } } }],
        }
      : tags.length > 0
        ? { teamId, tags: { some: { id: { in: tags } } } }
        : { teamId, id: { in: ids } };
  return db.contact.count({ where });
}

/**
 * Recipients preview for a broadcast audience: total count + a capped sample
 * of `{id, name, phoneNumber}`, using the same UNION-of-tags-and-ids semantics
 * as {@link countAudienceContacts}. Lets the wizard show "who am I sending to"
 * without shipping the whole contact list.
 */
export async function previewAudienceContacts(
  teamId: string,
  { tagIds = [], contactIds = [] }: { tagIds?: string[]; contactIds?: string[] },
  sampleLimit = 200,
): Promise<{
  total: number;
  sample: Array<{
    id: string;
    name: string;
    phoneNumber: string | null;
    tags: Tag[];
  }>;
}> {
  const tags = tagIds.filter((s) => s.length > 0);
  const ids = contactIds.filter((s) => s.length > 0);
  if (tags.length === 0 && ids.length === 0) return { total: 0, sample: [] };
  const where: Prisma.ContactWhereInput =
    tags.length > 0 && ids.length > 0
      ? { teamId, OR: [{ id: { in: ids } }, { tags: { some: { id: { in: tags } } } }] }
      : tags.length > 0
        ? { teamId, tags: { some: { id: { in: tags } } } }
        : { teamId, id: { in: ids } };
  const [total, sample] = await Promise.all([
    db.contact.count({ where }),
    db.contact.findMany({
      where,
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        tags: { orderBy: { name: "asc" } },
      },
      orderBy: [{ name: "asc" }],
      take: Math.max(1, Math.min(sampleLimit, 500)),
    }),
  ]);
  return {
    total,
    sample: sample.map((c) => ({
      id: c.id,
      name: c.name,
      phoneNumber: c.phoneNumber,
      tags: c.tags.map((t) => ({
        id: t.id,
        teamId: t.teamId,
        name: t.name,
        color: t.color as TagColor,
      })),
    })),
  };
}
