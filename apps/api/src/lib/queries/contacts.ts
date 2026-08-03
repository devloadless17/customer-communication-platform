import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { ListContactsOpts } from "@ccp/shared/dtos";
import type {
  Channel,
  ContactFieldDefinition,
  ContactListItem,
  CursorPage,
  TagColor,
} from "@ccp/shared/types";

import {
  EPHEMERAL_CONTACT_CHANNELS,
  isEphemeralChannel,
} from "@ccp/shared/providers/capabilities";

import { clampTake, normalizeCustomFields, siblingChannelsByCustomer } from "./_shared";
import { encodeContactCursor, parseContactCursor } from "./_cursors";

export const CONTACTS_PAGE = 50;

/** Ephemeral channels as a SQL-castable array — derived, never a literal. */
const EPHEMERAL_CHANNEL_LIST: Channel[] = [...EPHEMERAL_CONTACT_CHANNELS];

/**
 * Directory membership over an aliased `Contact c`: an ephemeral-channel contact
 * (a website-widget visitor — see `EPHEMERAL_CONTACT_CHANNELS`) only belongs in the
 * directory once it carries a durable address it can be reached at again.
 *
 * Exported so the surfaces that DON'T go through `buildContactFilterWhere` — CSV
 * export, the directory count, audience counts, global search — apply the exact
 * same rule instead of re-deriving it.
 */
export const DIRECTORY_CONTACT_SQL = Prisma.sql`(
  NOT (c."identityChannel" = ANY(${EPHEMERAL_CHANNEL_LIST}::"Channel"[]))
  OR c."phoneNumber" IS NOT NULL
  OR c.email IS NOT NULL
)`;

/**
 * Prisma-typed twin of `DIRECTORY_CONTACT_SQL`, for non-raw `where` clauses.
 *
 * ⚠️ It is an `OR` node. Spreading it into a where that ALREADY has a top-level
 * `OR` (global search's match arm, the audience tags∪ids union) silently
 * CLOBBERS that disjunction and widens the result set. Compose it via `AND: [...]`
 * whenever another `OR` is in play; a bare spread is only safe on a where with no
 * `OR` of its own.
 */
export const directoryContactWhere: Prisma.ContactWhereInput = {
  OR: [
    { identityChannel: { notIn: EPHEMERAL_CHANNEL_LIST } },
    { phoneNumber: { not: null } },
    { email: { not: null } },
  ],
};

// Options shape lives in @ccp/shared/dtos.
export type { ListContactsOpts };

/**
 * The filter predicates (everything except the keyset cursor + sort + limit)
 * for a contacts list query, as a `Prisma.sql` fragment over an aliased
 * `Contact c`. Factored out so the page query, the COUNT(*), AND the
 * "select-all-matching" bulk path (contacts.service.ts) all share the EXACT
 * same WHERE — a filter-mode bulk op can never target a different set than the
 * list the user is looking at.
 *
 * The caller supplies the alias (always `c` today) and the same normalized
 * `opts` the list query uses. The cursor clause is intentionally NOT here: the
 * filter set is page-position-independent.
 *
 * Anonymous ephemeral contacts (website-widget visitors with no phone/email) are
 * excluded by default — see `DIRECTORY_CONTACT_SQL`. Selecting that channel
 * EXPLICITLY in the filter opts back in, so the "Website widget" view still works;
 * because the opt-in lives here, the bulk path expands to exactly the same set the
 * user is looking at either way.
 */
export function buildContactFilterWhere(
  workspaceId: string,
  opts: ListContactsOpts = {},
): Prisma.Sql {
  const search = opts.search?.trim() ?? "";
  const fieldFilter = opts.fieldFilter;
  const source = opts.source;
  const channel = opts.channel;
  const accountId = opts.accountId;
  const windowFilter = opts.window;
  const stageFilter = opts.stageId;
  const tagIds = (opts.tagIds ?? []).filter((t) => t.length > 0);

  return Prisma.sql`
    c."workspaceId" = ${workspaceId}
    AND c."deletedAt" IS NULL
    ${
      channel && isEphemeralChannel(channel)
        ? Prisma.empty // explicit opt-in view: show anonymous visitors too
        : Prisma.sql`AND ${DIRECTORY_CONTACT_SQL}`
    }
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
      /* `equals` = exact match on the stored value — the UI sends it with an
         option ID for select-type fields. Default `contains` keeps the text
         fields' substring semantics byte-for-byte. */
      fieldFilter
        ? fieldFilter.mode === "equals"
          ? Prisma.sql`AND c."customFields" ->> ${fieldFilter.key} = ${fieldFilter.value}`
          : Prisma.sql`AND COALESCE(c."customFields" ->> ${fieldFilter.key}, '') ILIKE ${
              "%" + fieldFilter.value + "%"
            }`
        : Prisma.empty
    }
    ${source ? Prisma.sql`AND c.source = ${source}::"ContactSource"` : Prisma.empty}
    ${channel ? Prisma.sql`AND c."identityChannel" = ${channel}::"Channel"` : Prisma.empty}
    ${
      /* WHICH of our accounts on the channel this contact talks to. A workspace
         can hold several numbers/Pages/handles, and "who writes to the Sales
         number" was unanswerable from this page even though the inbox has had
         the same filter for a while. The account lives on the CONVERSATION (the
         single owner of that fact), so this is an EXISTS through the thread —
         served by the `Conversation(channelConnectionId)` index. */
      accountId
        ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM "Conversation" cv
            WHERE cv."contactId" = c.id
              AND cv."workspaceId" = ${workspaceId}
              AND cv."channelConnectionId" = ${accountId}
          )`
        : Prisma.empty
    }
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
}

/**
 * Resolve EVERY contact id matching `opts` (same filter set as the list),
 * capped at `cap`. Drives the "select all N matching" bulk path: the client
 * sends the active filter instead of an id array and the server expands it
 * here. Team-scoped + `deletedAt IS NULL` via the shared where-builder, so the
 * returned ids can be fed straight into a tenant-bounded bulk write.
 *
 * Returns `{ ids, capped }` — `capped` is true when the match count exceeded
 * `cap` (the caller decides whether to proceed with the truncated set or
 * reject). One flat query, no LATERAL join (the sort key isn't needed here).
 */
export async function resolveContactIdsByFilter(
  workspaceId: string,
  opts: ListContactsOpts,
  cap: number,
): Promise<{ ids: string[]; capped: boolean }> {
  const where = buildContactFilterWhere(workspaceId, opts);
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT c.id
    FROM "Contact" c
    WHERE ${where}
    ORDER BY c.id
    LIMIT ${cap + 1}
  `;
  const capped = rows.length > cap;
  const ids = (capped ? rows.slice(0, cap) : rows).map((r) => r.id);
  return { ids, capped };
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
  workspaceId: string,
  opts: ListContactsOpts = {},
): Promise<CursorPage<ContactListItem>> {
  const take = clampTake(opts.take, CONTACTS_PAGE);
  // Numbered (offset) pagination: when `page` is set the UI drives discrete
  // pages, so we ignore the keyset cursor and OFFSET into the ordered set
  // instead. `totalCount` (computed below whenever there's no cursor) gives the
  // page count. Keyset stays the default for infinite-scroll callers.
  const pageMode = opts.page != null && opts.page >= 1;
  const offset = pageMode ? (opts.page! - 1) * take : 0;
  const cursor = pageMode ? null : parseContactCursor(opts.cursor ?? null);

  // The filter predicates (everything except the keyset cursor + sort + limit)
  // are factored out into `buildContactFilterWhere` so the COUNT(*) below AND
  // the "select-all-matching" bulk path share the EXACT same WHERE as the page
  // query — neither the authoritative total nor a filter-mode bulk op can ever
  // drift from what the list would return. The cursor clause is intentionally
  // NOT in there: the filter set is page-position-independent.
  //
  // NOTE on the `customFields::text ILIKE` arm inside that builder: it's a
  // KNOWN INDEX-MISS (acceptable at pilot scale). No JSONB GIN serves substring
  // (jsonb_path_ops only serves @>/@?/@@ containment, which is why the old
  // Contact_customFields_gin_idx was dropped as dead write overhead, migration
  // 20260611130200). It seq-scans, but ONLY over this team's LIVE rows (workspaceId
  // + deletedAt IS NULL narrow first via Contact_workspaceId_deletedAt_idx), so it's
  // bounded by one tenant's contact count. Dropping the arm would lose "find a
  // contact by any custom-field value" from quick-search. TRIGGER to revisit: a
  // team crosses ~50k contacts AND EXPLAIN shows this as the hot cost.
  const filterWhere = buildContactFilterWhere(workspaceId, opts);

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
      workspaceId: string;
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
      channelConnectionId: string | null;
      lastInboundAt: Date | null;
    }>
  >`
    SELECT
      c.id,
      c."workspaceId",
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
      -- WHICH of our accounts that thread is on. Free: the LATERAL is already
      -- selecting from the row. Lets the list say "this person talks to Sales"
      -- instead of only "this person is on WhatsApp".
      conv."channelConnectionId"    AS "channelConnectionId",
      c."lastInboundAt"             AS "lastInboundAt"
    FROM "Contact" c
    LEFT JOIN LATERAL (
      SELECT id, "lastMessageAt", "channelConnectionId"
      FROM "Conversation" co
      -- Match on (workspaceId, contactId) so the LEFT JOIN LATERAL seeks the
      -- Conversation_workspaceId_contactId_key unique index. Filtering on
      -- contactId alone could not use it (contactId is not the leading column),
      -- degrading to a scan per contact row on the list. Contacts are
      -- team-siloed, so co.workspaceId always equals c.workspaceId.
      WHERE co."workspaceId" = c."workspaceId"
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
    -- Conversation_workspaceId_contactId_key seek per contact passing workspaceId +
    -- deletedAt IS NULL), materializes N sort keys, top-N sorts, then LIMIT.
    -- Bounded by one tenant's live-contact count — single-digit ms at a few
    -- thousand. WHEN it trips (50k contacts AND EXPLAIN shows this hot):
    -- denormalize the sort key onto Contact (e.g. lastActivityAt, bumped by the
    -- same ingest/send paths that maintain lastInboundAt + the conversation
    -- summary), add @@index([workspaceId, lastActivityAt DESC, id DESC]), and key
    -- BOTH this ORDER BY and the cursor off that column — turning every page
    -- into a pure keyset index walk.
    ORDER BY COALESCE(conv."lastMessageAt", c."createdAt") DESC, c.id DESC
    -- Offset mode fetches exactly one page at the offset; keyset mode fetches
    -- one extra row to detect whether more remain.
    LIMIT ${pageMode ? take : take + 1}
    ${pageMode ? Prisma.sql`OFFSET ${offset}` : Prisma.empty}
  `;

  const hasMore = pageMode ? false : rows.length > take;
  const sliced = hasMore ? rows.slice(0, take) : rows;
  const last = sliced.at(-1);
  // Offset mode uses page numbers (from totalCount), not a cursor.
  const nextCursor =
    !pageMode && hasMore && last
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
      where: { workspaceId, id: { in: ids } },
      select: { id: true, tags: { select: { id: true } } },
    });
    for (const c of links) {
      tagIdsByContact.set(c.id, c.tags.map((t) => t.id));
    }
  }

  const items: ContactListItem[] = sliced.map((r) => ({
    contact: {
      id: r.id,
      workspaceId: r.workspaceId,
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
    channelConnectionId: r.channelConnectionId ?? null,
    lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
    lastInboundAt: r.lastInboundAt ? r.lastInboundAt.toISOString() : null,
  }));

  return { items, nextCursor, totalCount };
}

/**
 * "Group by person" page for /contacts: ONE row per unified PERSON instead of
 * per channel-contact. A person is `COALESCE(customerId, id)` — a linked
 * `Customer`, or a solo contact as its own person. The representative row is
 * the person's most-recently-active contact; `personChannels` lists every
 * channel that person is reachable on (for the row's badge cluster).
 *
 * Offset/page mode only — a DISTINCT-ON rollup doesn't keyset cleanly, and the
 * contacts page already drives numbered pages. Reuses `buildContactFilterWhere`
 * so every filter (search / source / window / stage / tag / customField)
 * matches the flat list exactly; the CHANNEL filter is dropped (a person spans
 * channels). `totalCount` counts distinct persons.
 *
 * SCALING — known, measured, deliberately NOT worked around (2026-07-18).
 *
 * The inner query has no LIMIT and cannot have one: to order PERSONS by most
 * recent activity you must know every matching person's activity, so the
 * DISTINCT-ON must see every matching contact before the outer LIMIT/OFFSET
 * can pick a page. Cost is therefore O(matching contacts) per page load, on
 * page 1 as much as page 500 — deep paging does not compound it; only the
 * discarded OFFSET rows grow.
 *
 * It is NOT as bad as the shape suggests. `Conversation` carries
 * `@@unique([workspaceId, contactId])`, so the LEFT JOIN LATERAL resolves to ONE
 * unique-index lookup per contact rather than a scan. At 200k contacts that
 * is 200k index probes plus a sort — real, but a filtered directory page the
 * user explicitly opened, not a hot path.
 *
 * The only real fix is denormalization: a per-person `lastActivityAt`
 * maintained on `Customer` (plus the solo-contact case), which would make this
 * an indexed ORDER BY with a genuine LIMIT. That needs a column, ingest
 * maintenance, a backfill and a drift sweeper — the pattern CLAUDE.md §7
 * requires for any denormalized field — so it is a scoped piece of work, not a
 * tweak to slip into a hardening pass. TRIGGER: a tenant past ~100k contacts
 * reporting a slow /contacts page in "group by person" mode. Until then the
 * flat list (keyset, indexed) is the fast path and is the default.
 */
export async function listPeople(
  workspaceId: string,
  opts: ListContactsOpts = {},
): Promise<CursorPage<ContactListItem>> {
  const take = clampTake(opts.take, CONTACTS_PAGE);
  const page = opts.page != null && opts.page >= 1 ? opts.page : 1;
  const offset = (page - 1) * take;
  // Person mode rolls a Customer up ACROSS their channel-contacts, so both the
  // channel and the ACCOUNT filters are dropped here: scoping to one would
  // return a subset of the very persons the page is showing, and the counts
  // would disagree with the rows. (`accountId` was missed when it was added —
  // the UI already suppressed it in this mode, but the API is the contract and
  // /v1 or a hand-built call would have hit the inconsistency.)
  const filterWhere = buildContactFilterWhere(workspaceId, {
    ...opts,
    channel: undefined,
    accountId: undefined,
  });

  // DISTINCT ON must lead ORDER BY with the person key, so pick the
  // representative contact per person in the inner query, then order the OUTER
  // result by recency for the page.
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      workspaceId: string;
      phoneNumber: string | null;
      identityChannel: Channel;
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
      channelConnectionId: string | null;
      lastInboundAt: Date | null;
      customerId: string | null;
    }>
  >`
    SELECT sub.* FROM (
      SELECT DISTINCT ON (COALESCE(c."customerId", c.id))
        c.id,
        c."workspaceId",
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
        -- Person mode rolls a customer up across channels; this names the
        -- account of the REPRESENTATIVE contact's thread. Selected here too —
        -- the type alone would have compiled while the SQL returned undefined.
        conv."channelConnectionId"    AS "channelConnectionId",
        c."lastInboundAt"             AS "lastInboundAt",
        c."customerId"                AS "customerId"
      FROM "Contact" c
      LEFT JOIN LATERAL (
        SELECT id, "lastMessageAt", "channelConnectionId"
        FROM "Conversation" co
        WHERE co."workspaceId" = c."workspaceId"
          AND co."contactId" = c.id
          AND co.status <> 'closed'
        ORDER BY co."lastMessageAt" DESC, co.id DESC
        LIMIT 1
      ) conv ON TRUE
      WHERE ${filterWhere}
      ORDER BY COALESCE(c."customerId", c.id),
               COALESCE(conv."lastMessageAt", c."createdAt") DESC,
               c.id DESC
    ) sub
    ORDER BY COALESCE(sub."lastMessageAt", sub."createdAt") DESC, sub.id DESC
    LIMIT ${take} OFFSET ${offset}
  `;

  const countRows = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT COALESCE(c."customerId", c.id))::bigint AS count
    FROM "Contact" c
    WHERE ${filterWhere}
  `;
  const totalCount = Number(countRows[0]?.count ?? 0);

  // Channel cluster per person: for the page's LINKED persons, gather every
  // channel their contacts span. Solo persons (no customerId) have just their
  // own channel.
  const customerIds = [
    ...new Set(rows.map((r) => r.customerId).filter((v): v is string => !!v)),
  ];
  // Dedup each person's sibling contacts down to the distinct channels they span
  // (the list row only needs the channel set, not the per-channel conversation).
  const siblingsByCustomer = await siblingChannelsByCustomer(workspaceId, customerIds);
  const channelsByCustomer = new Map<string, Channel[]>();
  for (const [customerId, siblings] of siblingsByCustomer) {
    const channels: Channel[] = [];
    for (const s of siblings) {
      if (!channels.includes(s.channel)) channels.push(s.channel);
    }
    channelsByCustomer.set(customerId, channels);
  }

  const tagIdsByContact = new Map<string, string[]>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const links = await db.contact.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, tags: { select: { id: true } } },
    });
    for (const c of links) {
      tagIdsByContact.set(c.id, c.tags.map((t) => t.id));
    }
  }

  const items: ContactListItem[] = rows.map((r) => ({
    contact: {
      id: r.id,
      workspaceId: r.workspaceId,
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
    channelConnectionId: r.channelConnectionId ?? null,
    lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
    lastInboundAt: r.lastInboundAt ? r.lastInboundAt.toISOString() : null,
    personChannels: r.customerId
      ? channelsByCustomer.get(r.customerId) ?? [r.identityChannel]
      : [r.identityChannel],
  }));

  // Offset mode → page numbers from totalCount, no cursor.
  return { items, nextCursor: null, totalCount };
}

/**
 * Team-wide contact field definitions. Returned in render order so the panel
 * can iterate without re-sorting.
 */
export async function listContactFieldDefinitions(
  workspaceId: string,
): Promise<ContactFieldDefinition[]> {
  const rows = await db.contactFieldDefinition.findMany({
    where: { workspaceId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    include: {
      options: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    key: r.key,
    label: r.label,
    order: r.order,
    isVisible: r.isVisible,
    type: r.type,
    ...(r.type === "select"
      ? {
          options: r.options.map((o) => ({
            id: o.id,
            fieldId: o.fieldId,
            name: o.name,
            color: o.color as TagColor,
            position: o.position,
          })),
        }
      : {}),
  }));
}

/** Total number of (non-deleted) contacts in a team. */
export async function countContacts(workspaceId: string): Promise<number> {
  return db.contact.count({ where: { workspaceId, deletedAt: null } });
}

/**
 * Light id → display-label lookup for rendering selection chips. Team-scoped
 * and capped so a hostile caller can't ask us to hydrate the whole table.
 * Returns only the fields a chip needs — never the full Contact row.
 */
export async function lookupContacts(
  workspaceId: string,
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
    where: { workspaceId, deletedAt: null, id: { in: clean } },
    select: { id: true, name: true, phoneNumber: true },
  });
}
