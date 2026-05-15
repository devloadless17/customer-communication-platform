import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type {
  ConversationWithRefs,
  CursorPage,
  Message,
} from "@/lib/types";

import {
  clampTake,
  mapContact,
  mapConversation,
  mapMessage,
  mapNote,
  mapUser,
  REPLY_TO_INCLUDE,
} from "./_shared";
import {
  encodeConvoCursor,
  encodeMessageCursor,
  parseConvoCursor,
  parseMessageCursor,
} from "./_cursors";

/** Max page size, server-side cap so a hostile client can't ask for 100k rows. */
export const CONVERSATIONS_PAGE = 25;
export const MESSAGES_PAGE = 30;

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
  // Run in parallel with the true-count queries — none of these depend on
  // each other and they all hit different indices.
  const [lastInboundRow, messageCount, noteCount] = await Promise.all([
    db.message.findFirst({
      where: { direction: "in", conversation: { contactId: row.contactId } },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      select: { timestamp: true },
    }),
    db.message.count({ where: { conversationId } }),
    db.internalNote.count({ where: { conversationId } }),
  ]);

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
      messageCount,
      noteCount,
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
