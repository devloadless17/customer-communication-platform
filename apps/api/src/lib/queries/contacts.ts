import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { ListContactsOpts } from "@ccp/shared/dtos";
import type {
  ContactFieldDefinition,
  ContactListItem,
  CursorPage,
} from "@ccp/shared/types";

import { clampTake, normalizeCustomFields } from "./_shared";
import { encodeContactCursor, parseContactCursor } from "./_cursors";

export const CONTACTS_PAGE = 50;

// Options shape lives in @ccp/shared/dtos.
export type { ListContactsOpts };

/**
 * Page of contacts for /contacts.
 *
 * Sort is by `lastMessageAt DESC, id DESC` — keyset cursor so realtime
 * inbound that bumps a contact to the top doesn't make us skip rows on the
 * next page. Contacts with no messages yet sort to the bottom (they have
 * createdAt as the fallback).
 *
 * customFields filter is a JSONB containment expression in raw SQL because
 * Prisma's typed where doesn't expose the JSON `?`/`@>` operators with case
 * folding. We cast to text and use ILIKE so partial matches work.
 */
export async function listContacts(
  teamId: string,
  opts: ListContactsOpts = {},
): Promise<CursorPage<ContactListItem>> {
  const take = clampTake(opts.take, CONTACTS_PAGE);
  const cursor = parseContactCursor(opts.cursor ?? null);
  const search = opts.search?.trim() ?? "";
  const fieldFilter = opts.fieldFilter;
  const source = opts.source;
  const windowFilter = opts.window;
  const stageFilter = opts.stageId;
  const tagIds = (opts.tagIds ?? []).filter((t) => t.length > 0);

  // The filter predicates (everything except the keyset cursor + sort + limit)
  // are factored out so the COUNT(*) below shares the EXACT same WHERE as the
  // page query — the authoritative total can never drift from what the list
  // would return. The cursor clause is intentionally NOT in here: the total
  // is page-position-independent.
  const filterWhere = Prisma.sql`
    c."teamId" = ${teamId}
    AND c."deletedAt" IS NULL
    ${
      search
        ? Prisma.sql`AND (
            c.name ILIKE ${"%" + search + "%"}
            OR c."phoneNumber" ILIKE ${"%" + search + "%"}
            OR COALESCE(c.email, '') ILIKE ${"%" + search + "%"}
            -- KNOWN INDEX-MISS (acceptable at pilot scale): a
            -- 'customFields::text ILIKE' substring match has NO index that
            -- can serve it — no JSONB GIN serves substring (a jsonb_path_ops
            -- GIN only serves @>/@?/@@ containment, which is why the old
            -- Contact_customFields_gin_idx was dropped as dead write
            -- overhead, migration 20260611130200). This branch seq-scans, but
            -- ONLY over this team's LIVE rows (the teamId + deletedAt IS NULL
            -- predicates above narrow first via Contact_teamId_active_idx), so
            -- it's bounded by one tenant's contact count. Dropping the arm
            -- would lose "find a contact by any custom-field value" from
            -- quick-search — a real UX regression — so we keep it. TRIGGER to
            -- revisit: a team crosses ~50k contacts AND EXPLAIN shows this as
            -- the hot cost. Fix then: a generated tsvector/trgm column over
            -- the flattened customFields values, or push custom-field search
            -- to the explicit fieldKey+fieldValue filter only.
            OR c."customFields"::text ILIKE ${"%" + search + "%"}
          )`
        : Prisma.empty
    }
    ${
      fieldFilter
        ? Prisma.sql`AND COALESCE(c."customFields" ->> ${fieldFilter.key}, '') ILIKE ${
            "%" + fieldFilter.value + "%"
          }`
        : Prisma.empty
    }
    ${source ? Prisma.sql`AND c.source = ${source}::"ContactSource"` : Prisma.empty}
    ${
      windowFilter === "open"
        ? Prisma.sql`AND c."lastInboundAt" >= now() - interval '24 hours'`
        : windowFilter === "closed"
          ? Prisma.sql`AND (c."lastInboundAt" IS NULL OR c."lastInboundAt" < now() - interval '24 hours')`
          : Prisma.empty
    }
    ${
      tagIds.length > 0
        ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM "_ContactToTag" cttag
            WHERE cttag."A" = c.id
              AND cttag."B" = ANY(${tagIds}::text[])
          )`
        : Prisma.empty
    }
    ${
      stageFilter === "none"
        ? Prisma.sql`AND c."stageId" IS NULL`
        : stageFilter
          ? Prisma.sql`AND c."stageId" = ${stageFilter}`
          : Prisma.empty
    }
  `;

  // Tag filter is now pushed down as `EXISTS (... _ContactToTag ...)` in
  // the raw query below. The previous approach pre-resolved every matching
  // contact id with a separate findMany and spliced it as `c.id IN (...)`,
  // which returned megabytes of ids at 50k+ tagged contacts and defeated
  // cursor pruning. Prisma's implicit M2M table for `Contact.tags Tag[]`
  // is `_ContactToTag(A=Contact.id, B=Tag.id)`.

  // Pull contacts with one aggregate join: latest message timestamp + the
  // latest non-closed conversation id. We do this in a single SQL query
  // because Prisma's group-by + selecting a related row is awkward; raw is
  // shorter and the shape is stable.
  //
  // The cursor compares `(COALESCE(lastMessageAt, createdAt), id)` so the
  // order is total — two contacts with no messages still sort by id.
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      teamId: string;
      phoneNumber: string | null;
      identityChannel: "whatsapp" | null;
      externalContactId: string | null;
      name: string;
      avatarUrl: string | null;
      email: string | null;
      location: string | null;
      customFields: unknown;
      source: "inbound" | "manual";
      stageId: string | null;
      createdAt: Date;
      lastMessageAt: Date | null;
      activeConversationId: string | null;
      lastInboundAt: Date | null;
    }>
  >`
    SELECT
      c.id,
      c."teamId",
      c."phoneNumber",
      c."identityChannel",
      c."externalContactId",
      c.name,
      c."avatarUrl",
      c.email,
      c.location,
      c."customFields",
      c.source,
      c."stageId",
      c."createdAt",
      conv."lastMessageAt"          AS "lastMessageAt",
      conv.id                       AS "activeConversationId",
      c."lastInboundAt"             AS "lastInboundAt"
    FROM "Contact" c
    LEFT JOIN LATERAL (
      SELECT id, "lastMessageAt"
      FROM "Conversation" co
      -- Match on (teamId, contactId) so the LEFT JOIN LATERAL seeks the
      -- Conversation_teamId_contactId_key unique index. Filtering on
      -- contactId alone could not use it (contactId is not the leading column),
      -- degrading to a scan per contact row on the list. Contacts are
      -- team-siloed, so co.teamId always equals c.teamId.
      WHERE co."teamId" = c."teamId"
        AND co."contactId" = c.id
        AND co.status <> 'closed'
      ORDER BY co."lastMessageAt" DESC, co.id DESC
      LIMIT 1
    ) conv ON TRUE
    -- Latest inbound (24h-window basis) read from the denormalized
    -- Contact.lastInboundAt column maintained by the ingest path. The
    -- previous LEFT JOIN LATERAL scanned the contact's full message
    -- history once per row — fine in dev, ugly at scale.
    WHERE ${filterWhere}
      ${
        cursor
          ? Prisma.sql`AND (
              COALESCE(conv."lastMessageAt", c."createdAt") < ${cursor.sortAt}
              OR (
                COALESCE(conv."lastMessageAt", c."createdAt") = ${cursor.sortAt}
                AND c.id < ${cursor.id}
              )
            )`
          : Prisma.empty
      }
    -- KNOWN INDEX-MISS on the SORT (acceptable at pilot scale; same ~50k
    -- trigger as the customFields quick-search miss above): the sort key
    -- COALESCE(conv."lastMessageAt", c."createdAt") is an expression spanning
    -- the LEFT JOIN LATERAL, so NO index can serve this ORDER BY — and the
    -- keyset cursor predicate above references the same expression. So EVERY
    -- page (incl. scroll pages 2,3,…) re-runs the lateral probe (one
    -- Conversation_teamId_contactId_key seek per contact passing teamId +
    -- deletedAt IS NULL), materializes N sort keys, top-N sorts, then LIMIT.
    -- Bounded by one tenant's live-contact count — single-digit ms at a few
    -- thousand. WHEN it trips (50k contacts AND EXPLAIN shows this hot):
    -- denormalize the sort key onto Contact (e.g. lastActivityAt, bumped by the
    -- same ingest/send paths that maintain lastInboundAt + the conversation
    -- summary), add @@index([teamId, lastActivityAt DESC, id DESC]), and key
    -- BOTH this ORDER BY and the cursor off that column — turning every page
    -- into a pure keyset index walk.
    ORDER BY COALESCE(conv."lastMessageAt", c."createdAt") DESC, c.id DESC
    LIMIT ${take + 1}
  `;

  const hasMore = rows.length > take;
  const sliced = hasMore ? rows.slice(0, take) : rows;
  const last = sliced.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeContactCursor({
          sortAt: last.lastMessageAt ?? last.createdAt,
          id: last.id,
        })
      : null;

  // Authoritative total matching the CURRENT filter set — the #1 CRM question
  // ("how many contacts match this?"). Shares `filterWhere` verbatim with the
  // page query above, so it can never drift from what the list returns. Only
  // computed on page 1 (no cursor): scroll-pages reuse the client's first
  // value, and a fresh COUNT per page would be wasted work. The COUNT skips
  // the LEFT JOIN LATERAL entirely (it's only needed for the sort), so it's a
  // cheaper plan than the page query — a single index-narrowed aggregate.
  let totalCount: number | undefined;
  if (!cursor) {
    const countRows = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "Contact" c
      WHERE ${filterWhere}
    `;
    totalCount = Number(countRows[0]?.count ?? 0);
  }

  // Fetch tag links for this page in one go. We don't need the tag rows
  // themselves here — the UI passes the catalog separately — so this is a
  // single Prisma query over the implicit join table. Empty page → no query.
  const tagIdsByContact = new Map<string, string[]>();
  if (sliced.length > 0) {
    const ids = sliced.map((r) => r.id);
    const links = await db.contact.findMany({
      where: { teamId, id: { in: ids } },
      select: { id: true, tags: { select: { id: true } } },
    });
    for (const c of links) {
      tagIdsByContact.set(c.id, c.tags.map((t) => t.id));
    }
  }

  const items: ContactListItem[] = sliced.map((r) => ({
    contact: {
      id: r.id,
      teamId: r.teamId,
      phoneNumber: r.phoneNumber,
      identityChannel: r.identityChannel,
      externalContactId: r.externalContactId,
      name: r.name,
      avatarUrl: r.avatarUrl ?? undefined,
      email: r.email ?? undefined,
      location: r.location ?? undefined,
      customFields: normalizeCustomFields(r.customFields),
      source: r.source,
      stageId: r.stageId,
      tagIds: tagIdsByContact.get(r.id) ?? [],
    },
    activeConversationId: r.activeConversationId,
    lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
    lastInboundAt: r.lastInboundAt ? r.lastInboundAt.toISOString() : null,
  }));

  return { items, nextCursor, totalCount };
}

/**
 * Team-wide contact field definitions. Returned in render order so the panel
 * can iterate without re-sorting.
 */
export async function listContactFieldDefinitions(
  teamId: string,
): Promise<ContactFieldDefinition[]> {
  const rows = await db.contactFieldDefinition.findMany({
    where: { teamId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    key: r.key,
    label: r.label,
    order: r.order,
    isVisible: r.isVisible,
  }));
}

/** Total number of (non-deleted) contacts in a team. */
export async function countContacts(teamId: string): Promise<number> {
  return db.contact.count({ where: { teamId, deletedAt: null } });
}

/**
 * Light id → display-label lookup for rendering selection chips. Team-scoped
 * and capped so a hostile caller can't ask us to hydrate the whole table.
 * Returns only the fields a chip needs — never the full Contact row.
 */
export async function lookupContacts(
  teamId: string,
  ids: string[],
): Promise<Array<{ id: string; name: string; phoneNumber: string | null }>> {
  const clean = Array.from(
    new Set(ids.map((s) => s.trim()).filter((s) => s.length > 0)),
  ).slice(0, 1000);
  if (clean.length === 0) return [];
  return db.contact.findMany({
    // deletedAt:null so a tombstoned contact can't flash back into picker chips
    // / the contacts:bulk_updated refetch — matches every other read surface
    // (countContacts, list, remove, update, bulk, setTags all filter it).
    where: { teamId, deletedAt: null, id: { in: clean } },
    select: { id: true, name: true, phoneNumber: true },
  });
}
