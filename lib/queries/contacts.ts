import "server-only";

import { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";

import { db } from "@/lib/db";
import type {
  ContactFieldDefinition,
  ContactListItem,
  CursorPage,
} from "@/lib/types";

import { clampTake, normalizeCustomFields } from "./_shared";
import { encodeContactCursor, parseContactCursor } from "./_cursors";

export const CONTACTS_PAGE = 50;

export interface ListContactsOpts {
  /** Free-text search across name, phone, email, and customField values. */
  search?: string;
  /** Filter rows where customFields[key] matches value (case-insensitive contains). */
  fieldFilter?: { key: string; value: string };
  /** Filter by how the contact got into the DB. */
  source?: "inbound" | "manual";
  /** Keep only contacts carrying ANY of these tag ids (union, like audience groups). */
  tagIds?: string[];
  /** Filter by 24h customer-service window: "open" = messaged us in the last
   *  24h; "closed" = no inbound, or last inbound > 24h ago. */
  window?: "open" | "closed";
  /** Filter to contacts currently parked in this stage. `"none"` matches
   *  contacts with no stage at all (orphaned after a stage delete). */
  stageId?: string | "none";
  cursor?: string | null;
  take?: number;
}

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

  // Tag filter: resolve "has ANY of these tags" to a concrete id set up front
  // (Prisma's typed M2M is clearer than guessing the implicit join table name
  // in the raw query below). No matches → short-circuit to an empty page.
  let tagFilteredIds: string[] | null = null;
  if (tagIds.length > 0) {
    const matches = await db.contact.findMany({
      where: { teamId, tags: { some: { id: { in: tagIds } } } },
      select: { id: true },
    });
    tagFilteredIds = matches.map((m) => m.id);
    if (tagFilteredIds.length === 0) {
      return { items: [], nextCursor: null };
    }
  }

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
      identityProvider: "meta_cloud" | null;
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
      c."identityProvider",
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
      inbound."timestamp"           AS "lastInboundAt"
    FROM "Contact" c
    LEFT JOIN LATERAL (
      SELECT id, "lastMessageAt"
      FROM "Conversation" co
      WHERE co."contactId" = c.id
        AND co.status <> 'closed'
      ORDER BY co."lastMessageAt" DESC, co.id DESC
      LIMIT 1
    ) conv ON TRUE
    -- Latest inbound across ALL conversations (including closed) — the 24h
    -- window is a contact-level WhatsApp constraint, not a thread-level one.
    LEFT JOIN LATERAL (
      SELECT m."timestamp"
      FROM "Message" m
      JOIN "Conversation" co2 ON co2.id = m."conversationId"
      WHERE co2."contactId" = c.id
        AND m.direction = 'in'
      ORDER BY m."timestamp" DESC, m.id DESC
      LIMIT 1
    ) inbound ON TRUE
    WHERE c."teamId" = ${teamId}
      ${
        search
          ? Prisma.sql`AND (
              c.name ILIKE ${"%" + search + "%"}
              OR c."phoneNumber" ILIKE ${"%" + search + "%"}
              OR COALESCE(c.email, '') ILIKE ${"%" + search + "%"}
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
          ? Prisma.sql`AND inbound."timestamp" >= now() - interval '24 hours'`
          : windowFilter === "closed"
            ? Prisma.sql`AND (inbound."timestamp" IS NULL OR inbound."timestamp" < now() - interval '24 hours')`
            : Prisma.empty
      }
      ${
        tagFilteredIds
          ? Prisma.sql`AND c.id IN (${Prisma.join(tagFilteredIds)})`
          : Prisma.empty
      }
      ${
        stageFilter === "none"
          ? Prisma.sql`AND c."stageId" IS NULL`
          : stageFilter
            ? Prisma.sql`AND c."stageId" = ${stageFilter}`
            : Prisma.empty
      }
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
      identityProvider: r.identityProvider,
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

  return { items, nextCursor };
}

/**
 * Team-wide contact field definitions. Returned in render order so the panel
 * can iterate without re-sorting.
 *
 * Cached: see the rationale on `listTeamMembers`. Field schemas change rarely
 * (an admin editing the contact form), so the 60s revalidation is fine.
 */
export const listContactFieldDefinitions = unstable_cache(
  async (teamId: string): Promise<ContactFieldDefinition[]> => {
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
    }));
  },
  ["listContactFieldDefinitions"],
  { revalidate: 60, tags: ["contact-field-definitions"] },
);

/** Total number of contacts in a team. */
export async function countContacts(teamId: string): Promise<number> {
  return db.contact.count({ where: { teamId } });
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
    where: { teamId, id: { in: clean } },
    select: { id: true, name: true, phoneNumber: true },
  });
}
