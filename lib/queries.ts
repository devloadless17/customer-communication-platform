import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type {
  Contact,
  ContactFieldDefinition,
  ContactListItem,
  Conversation,
  ConversationStatus,
  ConversationWithRefs,
  CursorPage,
  InternalNote,
  MediaAttachment,
  MediaKind,
  Message,
  MessageDirection,
  MessageStatus,
  ProviderName,
  ReplySnapshot,
  Role,
  User,
} from "@/lib/types";

/** Max page size, server-side cap so a hostile client can't ask for 100k rows. */
export const CONVERSATIONS_PAGE = 25;
export const MESSAGES_PAGE = 30;
const MAX_TAKE = 100;

function clampTake(requested: number | undefined, fallback: number): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(Math.floor(requested), MAX_TAKE);
}

/**
 * Read-side queries for the inbox.
 *
 * Output shapes match `lib/types.ts` exactly so the UI doesn't move when we
 * switch from fake data to Prisma. Dates are ISO strings (Prisma returns Date
 * objects; we serialize at this boundary so passing values to client
 * components is a no-op).
 */

// ---------------------------------------------------------------------------
// Mappers — Prisma row → domain type. Centralized so any drift is one fix.
// ---------------------------------------------------------------------------

type PrismaConversation = Awaited<
  ReturnType<typeof db.conversation.findUniqueOrThrow>
>;
type PrismaContact = Awaited<ReturnType<typeof db.contact.findUniqueOrThrow>>;
type PrismaUser = Awaited<ReturnType<typeof db.user.findUniqueOrThrow>>;
type PrismaMessage = Awaited<ReturnType<typeof db.message.findUniqueOrThrow>>;
type PrismaNote = Awaited<ReturnType<typeof db.internalNote.findUniqueOrThrow>>;

/**
 * Selector snippet used wherever we render a quoted-reply preview. Centralised
 * so message-list, single-thread, and ingest all pull the same fields.
 */
const REPLY_TO_INCLUDE = {
  select: {
    id: true,
    body: true,
    direction: true,
    mediaKind: true,
    sender: { select: { name: true } },
  },
} as const;

type ReplyToRow = {
  id: string;
  body: string;
  direction: string;
  mediaKind: string | null;
  sender: { name: string } | null;
};

function mapReplySnapshot(row: ReplyToRow | null | undefined): ReplySnapshot | null {
  if (!row) return null;
  return {
    id: row.id,
    body: row.body.slice(0, 200),
    direction: row.direction as MessageDirection,
    senderName: row.sender?.name ?? null,
    ...(row.mediaKind ? { mediaKind: row.mediaKind as MediaKind } : {}),
  };
}

function mapUser(u: PrismaUser): User {
  return {
    id: u.id,
    teamId: u.teamId,
    role: u.role as Role,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl ?? undefined,
  };
}

function mapContact(c: PrismaContact): Contact {
  return {
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    name: c.name,
    avatarUrl: c.avatarUrl ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: normalizeCustomFields(c.customFields),
    source: c.source,
  };
}

/**
 * The customFields column is `Json` so Prisma types it as `JsonValue`.
 * Coerce to a flat string-map at this boundary so the rest of the app can
 * just do `contact.customFields[key]` without runtime checks. Anything
 * non-string is dropped (defensive — should never happen since the API
 * validates writes, but keeps the UI from crashing on legacy data).
 */
function normalizeCustomFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function mapConversation(c: PrismaConversation): Conversation {
  return {
    id: c.id,
    teamId: c.teamId,
    contactId: c.contactId,
    assignedUserId: c.assignedUserId,
    status: c.status as ConversationStatus,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastMessagePreview: c.lastMessagePreview,
  };
}

// Read paths never need `raw_payload` — it's the verbatim Meta webhook body,
// kept in the DB for debugging only (CLAUDE.md rule #4). Pulling it would
// drag a full JSONB blob per row through Postgres → Node → the browser on
// every thread open, so we `omit` it from every message read and the domain
// type doesn't carry it.
type PrismaMessageWithReply = Omit<PrismaMessage, "rawPayload"> & {
  replyTo?: ReplyToRow | null;
};

function mapMessage(m: PrismaMessageWithReply): Message {
  return {
    id: m.id,
    teamId: m.teamId,
    conversationId: m.conversationId,
    externalId: m.externalId,
    senderUserId: m.senderUserId,
    body: m.body,
    direction: m.direction as MessageDirection,
    provider: m.provider as ProviderName,
    status: m.status as MessageStatus,
    timestamp: m.timestamp.toISOString(),
    ...(m.replyToMessageId
      ? {
          replyToMessageId: m.replyToMessageId,
          replyTo: mapReplySnapshot(m.replyTo) ?? undefined,
        }
      : {}),
    ...(m.mediaKind && m.mediaMimeType
      ? {
          media: {
            kind: m.mediaKind as MediaAttachment["kind"],
            // Authenticated stream — never leaks the on-disk path.
            url: `/api/media/${m.id}`,
            mimeType: m.mediaMimeType,
            sizeBytes: m.mediaSizeBytes ?? 0,
            ...(m.mediaCaption ? { caption: m.mediaCaption } : {}),
            ...(m.mediaFilename ? { filename: m.mediaFilename } : {}),
            ...(m.mediaDurationMs != null ? { durationMs: m.mediaDurationMs } : {}),
          },
        }
      : {}),
  };
}

function mapNote(n: PrismaNote): InternalNote {
  return {
    id: n.id,
    conversationId: n.conversationId,
    authorUserId: n.authorUserId,
    body: n.body,
    timestamp: n.timestamp.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API — used by server components.
// ---------------------------------------------------------------------------

/**
 * Page of conversations for a team, sorted by recency.
 *
 * Keyset cursor on `(lastMessageAt, id)` instead of offset because realtime
 * events constantly bump conversations to the top — an offset cursor would
 * silently skip rows after a bump. Cursor is the *last item shown* so the
 * caller can pass it back to ask "give me the next page after this."
 *
 * Includes contact + assigned user; does NOT pull messages/notes (the
 * thread page hydrates those separately to keep the list query lean).
 */
export async function listConversations(
  teamId: string,
  opts: { take?: number; cursor?: string | null } = {},
): Promise<CursorPage<ConversationWithRefs>> {
  const take = clampTake(opts.take, CONVERSATIONS_PAGE);
  const cursor = parseConvoCursor(opts.cursor ?? null);

  const where = cursor
    ? {
        teamId,
        OR: [
          { lastMessageAt: { lt: cursor.lastMessageAt } },
          { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
        ],
      }
    : { teamId };

  const rows = await db.conversation.findMany({
    where,
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: { contact: true, assignedUser: true },
  });

  const hasMore = rows.length > take;
  const sliced = hasMore ? rows.slice(0, take) : rows;
  const last = sliced.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeConvoCursor({ lastMessageAt: last.lastMessageAt, id: last.id })
      : null;

  // Pull lastInboundAt for every contact in this page in one round trip.
  // Drives the 24h-window chip on the inbox conversation list. The contact
  // ids are bounded by `take`, so this is at most `take` lateral lookups.
  const contactIds = sliced.map((r) => r.contact.id);
  const inboundMap = await fetchLastInboundMap(contactIds);

  const items = sliced.map((row) => ({
    conversation: mapConversation(row),
    contact: mapContact(row.contact),
    assignedUser: row.assignedUser ? mapUser(row.assignedUser) : null,
    messages: [],
    notes: [],
    lastInboundAt: inboundMap.get(row.contact.id) ?? null,
  }));

  return { items, nextCursor };
}

/**
 * Latest inbound timestamp per contact. Pulled in a single grouped query so
 * the conversation-list page doesn't N+1 on its way to rendering window
 * chips. Returns ISO strings so callers can pass them straight through.
 */
async function fetchLastInboundMap(
  contactIds: string[],
): Promise<Map<string, string>> {
  if (contactIds.length === 0) return new Map();
  const rows = await db.$queryRaw<
    Array<{ contactId: string; lastInboundAt: Date }>
  >`
    SELECT co."contactId" AS "contactId",
           MAX(m."timestamp") AS "lastInboundAt"
    FROM "Message" m
    JOIN "Conversation" co ON co.id = m."conversationId"
    WHERE m.direction = 'in'
      AND co."contactId" IN (${Prisma.join(contactIds)})
    GROUP BY co."contactId"
  `;
  return new Map(rows.map((r) => [r.contactId, r.lastInboundAt.toISOString()]));
}

/**
 * Hydrate a conversation with its most recent `messageLimit` messages
 * (default 50) and the full notes list. Returns `nextOlderCursor` so the
 * thread can fetch older pages on scroll.
 *
 * Notes aren't paginated for now — there are typically <10 per thread.
 */
export async function getConversationWithRefs(
  teamId: string,
  conversationId: string,
  opts: { messageLimit?: number } = {},
): Promise<{ data: ConversationWithRefs; nextOlderCursor: string | null } | null> {
  const limit = clampTake(opts.messageLimit, MESSAGES_PAGE);

  const row = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    include: {
      contact: { include: { tags: { select: { id: true } } } },
      assignedUser: true,
      // +1 to detect "more older exists" without a count query.
      messages: {
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        take: limit + 1,
        omit: { rawPayload: true },
        include: { replyTo: REPLY_TO_INCLUDE },
      },
      notes: { orderBy: { timestamp: "asc" } },
    },
  });
  if (!row) return null;

  const hasMore = row.messages.length > limit;
  const recent = hasMore ? row.messages.slice(0, limit) : row.messages;
  // Reverse to chronological order for the UI; keeps timeline rendering simple.
  const messagesAsc = [...recent].reverse();
  const oldest = messagesAsc[0];
  const nextOlderCursor =
    hasMore && oldest ? encodeMessageCursor({ timestamp: oldest.timestamp, id: oldest.id }) : null;

  // Latest inbound across ALL of this contact's conversations (not just the
  // current thread), since the 24h window is contact-level on Meta's side.
  const lastInboundRow = await db.message.findFirst({
    where: {
      direction: "in",
      conversation: { contactId: row.contactId },
    },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    select: { timestamp: true },
  });

  return {
    data: {
      conversation: mapConversation(row),
      contact: {
        ...mapContact(row.contact),
        tagIds: row.contact.tags.map((t) => t.id),
      },
      assignedUser: row.assignedUser ? mapUser(row.assignedUser) : null,
      messages: messagesAsc.map(mapMessage),
      notes: row.notes.map(mapNote),
      lastInboundAt: lastInboundRow ? lastInboundRow.timestamp.toISOString() : null,
    },
    nextOlderCursor,
  };
}

/**
 * Page of messages older than the given cursor. Returns chronological
 * (oldest-first) within the page so the UI can prepend.
 */
export async function listOlderMessages(
  teamId: string,
  conversationId: string,
  opts: { take?: number; before: string },
): Promise<CursorPage<Message>> {
  const take = clampTake(opts.take, MESSAGES_PAGE);
  const cursor = parseMessageCursor(opts.before);
  if (!cursor) return { items: [], nextCursor: null };

  // Confirm the conversation belongs to the team — a malicious client
  // shouldn't be able to enumerate other tenants' messages by guessing IDs.
  const owns = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: { id: true },
  });
  if (!owns) return { items: [], nextCursor: null };

  const rows = await db.message.findMany({
    omit: { rawPayload: true },
    include: { replyTo: REPLY_TO_INCLUDE },
    where: {
      conversationId,
      OR: [
        { timestamp: { lt: cursor.timestamp } },
        { timestamp: cursor.timestamp, id: { lt: cursor.id } },
      ],
    },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: take + 1,
  });

  const hasMore = rows.length > take;
  const slicedDesc = hasMore ? rows.slice(0, take) : rows;
  const itemsAsc = [...slicedDesc].reverse();
  const oldest = itemsAsc[0];
  const nextCursor =
    hasMore && oldest ? encodeMessageCursor({ timestamp: oldest.timestamp, id: oldest.id }) : null;

  return { items: itemsAsc.map(mapMessage), nextCursor };
}

// ---------------------------------------------------------------------------
// Cursor codecs. Cursors are base64-url JSON — opaque to clients but easy to
// debug, no extra dependency, and the size is fine for two fields.
// ---------------------------------------------------------------------------

interface ConvoCursor {
  lastMessageAt: Date;
  id: string;
}

function encodeConvoCursor(c: ConvoCursor): string {
  return base64url(JSON.stringify({ t: c.lastMessageAt.toISOString(), i: c.id }));
}

function parseConvoCursor(raw: string | null): ConvoCursor | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(base64urlDecode(raw)) as { t?: string; i?: string };
    if (typeof obj.t !== "string" || typeof obj.i !== "string") return null;
    const d = new Date(obj.t);
    if (Number.isNaN(d.getTime())) return null;
    return { lastMessageAt: d, id: obj.i };
  } catch {
    return null;
  }
}

interface MessageCursor {
  timestamp: Date;
  id: string;
}

function encodeMessageCursor(c: MessageCursor): string {
  return base64url(JSON.stringify({ t: c.timestamp.toISOString(), i: c.id }));
}

function parseMessageCursor(raw: string | null): MessageCursor | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(base64urlDecode(raw)) as { t?: string; i?: string };
    if (typeof obj.t !== "string" || typeof obj.i !== "string") return null;
    const d = new Date(obj.t);
    if (Number.isNaN(d.getTime())) return null;
    return { timestamp: d, id: obj.i };
  } catch {
    return null;
  }
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

/** All teammates — used by the assignment dropdown and sidebar list. */
export async function listTeamMembers(teamId: string): Promise<User[]> {
  const rows = await db.user.findMany({ where: { teamId }, orderBy: { name: "asc" } });
  return rows.map(mapUser);
}

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
      phoneNumber: string;
      name: string;
      avatarUrl: string | null;
      email: string | null;
      location: string | null;
      customFields: unknown;
      source: "inbound" | "manual";
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
      c.name,
      c."avatarUrl",
      c.email,
      c.location,
      c."customFields",
      c.source,
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
  // single GROUP BY on the implicit join table. Empty page → no query.
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
      name: r.name,
      avatarUrl: r.avatarUrl ?? undefined,
      email: r.email ?? undefined,
      location: r.location ?? undefined,
      customFields: normalizeCustomFields(r.customFields),
      source: r.source,
      tagIds: tagIdsByContact.get(r.id) ?? [],
    },
    activeConversationId: r.activeConversationId,
    lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
    lastInboundAt: r.lastInboundAt ? r.lastInboundAt.toISOString() : null,
  }));

  return { items, nextCursor };
}

interface ContactCursor {
  sortAt: Date;
  id: string;
}

function encodeContactCursor(c: ContactCursor): string {
  return base64url(JSON.stringify({ t: c.sortAt.toISOString(), i: c.id }));
}

function parseContactCursor(raw: string | null): ContactCursor | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(base64urlDecode(raw)) as { t?: string; i?: string };
    if (typeof obj.t !== "string" || typeof obj.i !== "string") return null;
    const d = new Date(obj.t);
    if (Number.isNaN(d.getTime())) return null;
    return { sortAt: d, id: obj.i };
  } catch {
    return null;
  }
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
  }));
}

// ---------------------------------------------------------------------------
// superAdmin: cross-team browsing. These queries are the ONLY ones that
// legitimately ignore the team scope — all callers must be gated through
// requireSuperAdmin in auth-helpers.
// ---------------------------------------------------------------------------

export interface SuperAdminTeamRow {
  id: string;
  name: string;
  createdAt: string;
  whatsappConnected: boolean;
  whatsappDisplayNumber: string | null;
  userCount: number;
  contactCount: number;
  conversationCount: number;
  messageCount: number;
  broadcastCount: number;
}

/**
 * Every team on the platform with aggregate counts. Built from one query
 * per aggregate — fine at low team-count (single-VPS pilot). At >100 teams
 * we'd swap to a single SQL query with LATERAL joins; not worth it yet.
 */
export async function listAllTeamsForSuperAdmin(): Promise<SuperAdminTeamRow[]> {
  const teams = await db.team.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      metaPhoneNumberId: true,
      metaDisplayPhoneNumber: true,
      _count: {
        select: {
          users: true,
          contacts: true,
          conversations: true,
          messages: true,
          broadcasts: true,
        },
      },
    },
  });
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    whatsappConnected: Boolean(t.metaPhoneNumberId),
    whatsappDisplayNumber: t.metaDisplayPhoneNumber ?? null,
    userCount: t._count.users,
    contactCount: t._count.contacts,
    conversationCount: t._count.conversations,
    messageCount: t._count.messages,
    broadcastCount: t._count.broadcasts,
  }));
}

export interface SuperAdminTeamDetail {
  team: SuperAdminTeamRow;
  members: Array<{
    id: string;
    name: string;
    email: string;
    role: import("@/lib/types").Role;
    deactivatedAt: string | null;
    createdAt: string;
  }>;
}

export async function getTeamDetailForSuperAdmin(
  teamId: string,
): Promise<SuperAdminTeamDetail | null> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      name: true,
      createdAt: true,
      metaPhoneNumberId: true,
      metaDisplayPhoneNumber: true,
      _count: {
        select: {
          users: true,
          contacts: true,
          conversations: true,
          messages: true,
          broadcasts: true,
        },
      },
    },
  });
  if (!team) return null;

  // Members only. Conversations are intentionally NOT fetched here —
  // superAdmin's visibility ends at aggregate counts + the member roster,
  // never at message bodies or contact names. Customer chats stay private
  // to each team.
  const members = await db.user.findMany({
    where: { teamId },
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      deactivatedAt: true,
      createdAt: true,
    },
  });

  return {
    team: {
      id: team.id,
      name: team.name,
      createdAt: team.createdAt.toISOString(),
      whatsappConnected: Boolean(team.metaPhoneNumberId),
      whatsappDisplayNumber: team.metaDisplayPhoneNumber ?? null,
      userCount: team._count.users,
      contactCount: team._count.contacts,
      conversationCount: team._count.conversations,
      messageCount: team._count.messages,
      broadcastCount: team._count.broadcasts,
    },
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      deactivatedAt: m.deactivatedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Audience groups: saved named lists of contacts. Hybrid composition —
// manual contact ids PLUS any contact carrying one of the group's tags.
// The resolver below is the single source of truth for "who's in this
// group right now"; both the audience-groups API and the broadcast runner
// call it.
// ---------------------------------------------------------------------------

export interface AudienceGroupDto {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  tagIds: string[];
  contactIds: string[];
  /** Computed member count at read time. */
  memberCount: number;
  createdById: string;
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
    createdByName: g.createdBy.name,
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
    createdByName: g.createdBy.name,
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
  const where: import("@prisma/client").Prisma.ContactWhereInput =
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
  const where: import("@prisma/client").Prisma.ContactWhereInput =
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
): Promise<Array<{ id: string; name: string; phoneNumber: string }>> {
  const clean = Array.from(
    new Set(ids.map((s) => s.trim()).filter((s) => s.length > 0)),
  ).slice(0, 1000);
  if (clean.length === 0) return [];
  return db.contact.findMany({
    where: { teamId, id: { in: clean } },
    select: { id: true, name: true, phoneNumber: true },
  });
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
): Promise<{ total: number; sample: Array<{ id: string; name: string; phoneNumber: string }> }> {
  const tags = tagIds.filter((s) => s.length > 0);
  const ids = contactIds.filter((s) => s.length > 0);
  if (tags.length === 0 && ids.length === 0) return { total: 0, sample: [] };
  const where: import("@prisma/client").Prisma.ContactWhereInput =
    tags.length > 0 && ids.length > 0
      ? { teamId, OR: [{ id: { in: ids } }, { tags: { some: { id: { in: tags } } } }] }
      : tags.length > 0
        ? { teamId, tags: { some: { id: { in: tags } } } }
        : { teamId, id: { in: ids } };
  const [total, sample] = await Promise.all([
    db.contact.count({ where }),
    db.contact.findMany({
      where,
      select: { id: true, name: true, phoneNumber: true },
      orderBy: [{ name: "asc" }],
      take: Math.max(1, Math.min(sampleLimit, 500)),
    }),
  ]);
  return { total, sample };
}

export async function listTags(teamId: string): Promise<import("@/lib/types").Tag[]> {
  const rows = await db.tag.findMany({
    where: { teamId },
    orderBy: [{ name: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    color: r.color as import("@/lib/types").TagColor,
  }));
}
