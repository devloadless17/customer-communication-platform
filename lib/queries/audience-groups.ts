import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { Tag, TagColor } from "@/lib/types";

// Audience groups: saved named lists of contacts. Hybrid composition —
// manual contact ids PLUS any contact carrying one of the group's tags.
// The resolver below is the single source of truth for "who's in this
// group right now"; both the audience-groups API and the broadcast runner
// call it.

export interface AudienceGroupDto {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  tagIds: string[];
  contactIds: string[];
  /** Computed member count at read time. */
  memberCount: number;
  /** Null when the creator was hard-deleted; UI shows "Removed user". */
  createdById: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

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
  // Resolve member counts in parallel — one query per group. Acceptable at
  // pilot scale (groups are dozens, not thousands). Switch to a single SQL
  // aggregate when this matters.
  const counts = await Promise.all(
    rows.map((g) =>
      resolveAudienceGroupMemberCount(teamId, {
        tagIds: g.tags.map((t) => t.id),
        manualContactIds: g.contacts.map((c) => c.id),
      }),
    ),
  );
  return rows.map((g, i) => ({
    id: g.id,
    teamId: g.teamId,
    name: g.name,
    description: g.description,
    tagIds: g.tags.map((t) => t.id),
    contactIds: g.contacts.map((c) => c.id),
    memberCount: counts[i] ?? 0,
    createdById: g.createdById,
    createdByName: g.createdBy?.name ?? "Removed user",
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  }));
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

  if (tagIds.length === 0 && manualContactIds.length === 0) return [];

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
    phoneNumber: string;
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
