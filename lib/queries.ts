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

type PrismaMessageWithReply = PrismaMessage & {
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
    rawPayload: (m.rawPayload as Record<string, unknown>) ?? {},
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
      contact: true,
      assignedUser: true,
      // +1 to detect "more older exists" without a count query.
      messages: {
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        take: limit + 1,
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
      contact: mapContact(row.contact),
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
