import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { AudienceGroupDto } from "@ccp/shared/dtos";
import type { Channel, Tag, TagColor } from "@ccp/shared/types";

// Audience groups: saved named lists of contacts. Hybrid composition —
// manual contact ids PLUS any contact carrying one of the group's tags.
// The resolver below is the single source of truth for "who's in this
// group right now"; both the audience-groups API and the broadcast runner
// call it.

// DTO shape lives in @ccp/shared/dtos so client components in apps/web
// can name it without reaching across the package boundary.
export type { AudienceGroupDto };

/**
 * How many manual-member ids the LIST ships per group. The list UI only needs
 * a count ("+N manual"), which `manualContactCount` carries exactly; the chips
 * that actually render ids live on the single-group edit page, which calls
 * `getAudienceGroup` and gets the full set. Preview ids are kept so the shape
 * stays useful (and honest — see the DTO comment) without the list's payload
 * scaling with a group's membership.
 */
const LIST_CONTACT_ID_PREVIEW = 50;

export async function listAudienceGroups(teamId: string): Promise<AudienceGroupDto[]> {
  const rows = await db.audienceGroup.findMany({
    where: { teamId },
    orderBy: { createdAt: "desc" },
    include: {
      createdBy: { select: { name: true } },
      tags: { select: { id: true } },
      // Exclude soft-deleted contacts so the DTO's `contactIds` (the chips the
      // UI renders) stays consistent with `memberCount` (which filters
      // deletedAt: null) — otherwise a soft-deleted member shows as a phantom
      // chip with no matching count.
      //
      // BOUNDED: this used to be every manual member of every group (up to
      // 5000 each, the write-schema cap, times however many groups a team
      // has). See LIST_CONTACT_ID_PREVIEW — the exact number comes from the
      // aggregate below, so nothing here has to be complete to be correct.
      // `getAudienceGroup` is deliberately NOT truncated: its result feeds an
      // edit form that saves `contactIds` as a full replace.
      contacts: {
        where: { deletedAt: null },
        select: { id: true },
        take: LIST_CONTACT_ID_PREVIEW,
      },
    },
  });
  if (rows.length === 0) return [];

  // Member counts for every group in ONE server-side aggregate.
  //
  // This previously loaded every contact carrying ANY tag used by ANY group on
  // the page, then unioned them per group in JS. The in-code note called that
  // out and named ~50k contacts as the point to switch to "a CTE-based raw SQL
  // aggregate" — enterprise tenants are past it, and the trigger is worse than
  // contact count alone suggests: ONE broadly-applied tag ("customer") on one
  // group is enough to pull the entire book into memory on a settings-page
  // load, however small the groups are.
  //
  // The union is the same one `countAudienceContacts` expresses for a single
  // group — manual members ∪ tag carriers, deduped, soft-deleted excluded —
  // just evaluated for every group at once so it stays one round trip. Both
  // arms are teamId-scoped independently: membership rows are not
  // tenant-tagged themselves, so the Contact join is what enforces isolation.
  // `manualCount` rides along in the same pass so it stays soft-delete aware —
  // a Prisma `_count` can't carry the `deletedAt IS NULL` filter, and an
  // unfiltered manual count next to a filtered memberCount is exactly the
  // phantom-chip inconsistency the include comment above warns about.
  // SHAPE MATTERS HERE, and the obvious phrasing is a trap. Writing this as
  // `AudienceGroup LEFT JOIN Contact ON (EXISTS manual OR EXISTS tag)` reads
  // naturally and plans as a Nested Loop over a Seq Scan of Contact with the
  // EXISTS clauses as subplans — i.e. it evaluates them once per
  // (group x contact) PAIR. That is worse than the JS version it replaces:
  // 10 groups x 200k contacts is 2M subplan evaluations. (Confirmed with
  // EXPLAIN before rewriting — do that before changing this query.)
  //
  // So drive from the MEMBERSHIP tables instead. The lateral collects this
  // group's member ids from both arms (both indexed on "A" = the group), the
  // UNION-by-GROUP-BY dedupes a contact that is both manual and tag-matched,
  // and `bool_or(manual)` remembers whether any arm was the manual one. Only
  // then does it touch Contact, by primary key, to apply the team +
  // soft-delete filters. Cost is proportional to actual membership, never to
  // the tenant's contact count.
  //
  // `COUNT(c.id)` (not `COUNT(*)`) is load-bearing: it skips the NULLs left by
  // members the Contact join rejected — soft-deleted, or belonging to another
  // team. That join IS the tenant-isolation check, since membership rows carry
  // no teamId of their own.
  const counts = await db.$queryRaw<
    Array<{ groupId: string; count: bigint; manualCount: bigint }>
  >`
    SELECT g.id AS "groupId",
           COUNT(c.id)::bigint AS count,
           COUNT(c.id) FILTER (WHERE mem.manual)::bigint AS "manualCount"
    FROM "AudienceGroup" g
    LEFT JOIN LATERAL (
      SELECT u.contact_id, bool_or(u.manual) AS manual
      FROM (
        SELECT m."B" AS contact_id, true AS manual
        FROM "_AudienceGroupContacts" m
        WHERE m."A" = g.id
        UNION ALL
        SELECT ct."A" AS contact_id, false AS manual
        FROM "_AudienceGroupTags" gt
        JOIN "_ContactToTag" ct ON ct."B" = gt."B"
        WHERE gt."A" = g.id
      ) u
      GROUP BY u.contact_id
    ) mem ON TRUE
    LEFT JOIN "Contact" c
      ON c.id = mem.contact_id
     AND c."teamId" = g."teamId"
     AND c."deletedAt" IS NULL
    WHERE g."teamId" = ${teamId}
    GROUP BY g.id
  `;
  const countByGroup = new Map(
    counts.map((r) => [r.groupId, { total: Number(r.count), manual: Number(r.manualCount) }]),
  );

  return rows.map((g) => ({
    id: g.id,
    teamId: g.teamId,
    name: g.name,
    description: g.description,
    tagIds: g.tags.map((t) => t.id),
    contactIds: g.contacts.map((c) => c.id),
    manualContactCount: countByGroup.get(g.id)?.manual ?? 0,
    memberCount: countByGroup.get(g.id)?.total ?? 0,
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
      // Exclude soft-deleted contacts so the DTO's `contactIds` (the chips the
      // UI renders) stays consistent with `memberCount` (which filters
      // deletedAt: null) — otherwise a soft-deleted member shows as a phantom
      // chip with no matching count.
      contacts: { where: { deletedAt: null }, select: { id: true } },
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
    // Complete here (unlike the list), so the length IS the count.
    manualContactCount: g.contacts.length,
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
          deletedAt: null,
          OR: [
            { id: { in: manualContactIds } },
            { tags: { some: { id: { in: tagIds } } } },
          ],
        }
      : { teamId, deletedAt: null, id: { in: manualContactIds } };

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
  {
    tagIds = [],
    contactIds = [],
    all = false,
  }: { tagIds?: string[]; contactIds?: string[]; all?: boolean },
  // A broadcast sends on ONE channel and drops contacts on other channels, so
  // the composer's recipient count must be scoped to the target channel — else a
  // freeform Messenger broadcast to a mixed-channel tag shows the whole audience
  // but only reaches the Messenger subset. Omit to count every channel.
  channel?: Channel,
): Promise<number> {
  const channelFilter = channel ? { identityChannel: channel } : {};
  // "All contacts" audience: every team contact (channel-scoped), tags/ids
  // ignored. Kept separate from the empty-selection case below, which returns 0
  // on purpose so an unconfigured custom audience never fans out to everyone.
  if (all) {
    return db.contact.count({ where: { teamId, deletedAt: null, ...channelFilter } });
  }
  const tags = tagIds.filter((s) => s.length > 0);
  const ids = contactIds.filter((s) => s.length > 0);
  if (tags.length === 0 && ids.length === 0) return 0;
  const where: Prisma.ContactWhereInput =
    tags.length > 0 && ids.length > 0
      ? {
          teamId,
          deletedAt: null,
          ...channelFilter,
          OR: [{ id: { in: ids } }, { tags: { some: { id: { in: tags } } } }],
        }
      : tags.length > 0
        ? { teamId, deletedAt: null, ...channelFilter, tags: { some: { id: { in: tags } } } }
        : { teamId, deletedAt: null, ...channelFilter, id: { in: ids } };
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
  // Scoped exactly like `countAudienceContacts` — the preview answers "who am I
  // sending to", so it must resolve the same set the count shows and the runner
  // actually sends to. Unscoped, a freeform Instagram broadcast previewed every
  // WhatsApp contact in the group as a recipient it will never message.
  channel?: Channel,
): Promise<{
  total: number;
  sample: Array<{
    id: string;
    name: string;
    phoneNumber: string | null;
    tags: Tag[];
  }>;
}> {
  const channelFilter = channel ? { identityChannel: channel } : {};
  const tags = tagIds.filter((s) => s.length > 0);
  const ids = contactIds.filter((s) => s.length > 0);
  if (tags.length === 0 && ids.length === 0) return { total: 0, sample: [] };
  const where: Prisma.ContactWhereInput =
    tags.length > 0 && ids.length > 0
      ? {
          teamId,
          deletedAt: null,
          ...channelFilter,
          OR: [{ id: { in: ids } }, { tags: { some: { id: { in: tags } } } }],
        }
      : tags.length > 0
        ? { teamId, deletedAt: null, ...channelFilter, tags: { some: { id: { in: tags } } } }
        : { teamId, deletedAt: null, ...channelFilter, id: { in: ids } };
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
