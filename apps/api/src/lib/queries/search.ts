import { db } from "@/lib/db";
import type { MessageSearchHit, MessageSearchPage } from "@ccp/shared/dtos";
import type { MediaKind, Message, MessageDirection } from "@ccp/shared/types";

import { clampTake, mapMessage, REPLY_TO_INCLUDE } from "./_shared";
import { encodeMessageCursor, parseMessageCursor } from "./_cursors";

// DTO shapes live in @ccp/shared/dtos.
export type { MessageSearchHit, MessageSearchPage };

// In-conversation message search. ILIKE against `body` + `mediaCaption`,
// scoped to the conversation + team. Index on (conversationId, timestamp)
// already exists; the WHERE clause uses it for the order-by tail, and the
// ILIKE expression is the residual filter.
//
// We deliberately avoid Postgres full-text search for v1 — it would require
// a tsvector column + GIN index migration, and customers' chats are small
// enough (thousands of rows per conversation, max) that an indexed
// (conversationId, timestamp) scan with an ILIKE filter is well under 100ms.
// If we ever see a chat with >100k messages, swap this to FTS.

/**
 * Page of search hits for `query` inside `conversationId`, newest-first.
 * Cursor is the same keyset shape as the older-messages pager so the two
 * can share the codec.
 */
export async function searchConversationMessages(
  teamId: string,
  conversationId: string,
  opts: { query: string; take?: number; cursor?: string | null },
): Promise<MessageSearchPage> {
  const take = clampTake(opts.take, 25);
  const cursor = parseMessageCursor(opts.cursor ?? null);
  const query = opts.query.trim();
  if (query.length === 0) {
    return { items: [], nextCursor: null, totalMatched: 0 };
  }

  // Scope check: prevent enumeration of another tenant's conversation
  // by id-guessing.
  const owns = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: { id: true },
  });
  if (!owns) return { items: [], nextCursor: null, totalMatched: 0 };

  // Match against either the body OR the media caption. mediaCaption is a
  // dedicated column rather than re-using body, so OR is the right shape.
  const matchWhere = {
    conversationId,
    OR: [
      { body: { contains: query, mode: "insensitive" as const } },
      { mediaCaption: { contains: query, mode: "insensitive" as const } },
    ],
  };

  const totalMatched = await db.message.count({ where: matchWhere });

  const rows = await db.message.findMany({
    where: cursor
      ? {
          ...matchWhere,
          AND: [
            {
              OR: [
                { timestamp: { lt: cursor.timestamp } },
                { timestamp: cursor.timestamp, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : matchWhere,
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      body: true,
      direction: true,
      timestamp: true,
      mediaCaption: true,
      mediaKind: true,
      sender: { select: { name: true } },
    },
  });

  const hasMore = rows.length > take;
  const sliced = hasMore ? rows.slice(0, take) : rows;
  const last = sliced.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeMessageCursor({ timestamp: last.timestamp, id: last.id })
      : null;

  const items: MessageSearchHit[] = sliced.map((r) => ({
    id: r.id,
    body: r.body,
    direction: r.direction as MessageDirection,
    timestamp: r.timestamp.toISOString(),
    senderName: r.sender?.name ?? null,
    ...(r.mediaCaption ? { mediaCaption: r.mediaCaption } : {}),
    ...(r.mediaKind ? { mediaKind: r.mediaKind as MediaKind } : {}),
  }));

  return { items, nextCursor, totalMatched };
}

/**
 * Load a window of messages CENTERED on a target so the inbox can jump to
 * a search hit that lives outside the currently-loaded slice without
 * paginating through every older page.
 *
 * Returns chronological (oldest-first) plus a `nextOlderCursor` so the
 * thread can continue paginating upward from the new top. Limits are
 * generous (default 25/25) because this is a rare action — the user just
 * clicked a search result — but capped by clampTake.
 */
export async function loadMessageContextWindow(
  teamId: string,
  conversationId: string,
  opts: { targetMessageId: string; before?: number; after?: number },
): Promise<{
  messages: Message[];
  /** True when there are still older messages before this window — drives
   *  the thread's "load older" gate. */
  hasMoreOlder: boolean;
  nextOlderCursor: string | null;
} | null> {
  const before = clampTake(opts.before, 25);
  const after = clampTake(opts.after, 25);

  const target = await db.message.findFirst({
    where: { id: opts.targetMessageId, conversationId, teamId },
    select: { id: true, timestamp: true },
  });
  if (!target) return null;

  const [olderRows, anchorAndNewer] = await Promise.all([
    db.message.findMany({
      omit: { rawPayload: true },
      include: { replyTo: REPLY_TO_INCLUDE },
      where: {
        conversationId,
        OR: [
          { timestamp: { lt: target.timestamp } },
          { timestamp: target.timestamp, id: { lt: target.id } },
        ],
      },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: before + 1, // +1 to detect "more older exists"
    }),
    db.message.findMany({
      omit: { rawPayload: true },
      include: { replyTo: REPLY_TO_INCLUDE },
      where: {
        conversationId,
        OR: [
          { timestamp: { gt: target.timestamp } },
          { timestamp: target.timestamp, id: { gte: target.id } },
        ],
      },
      orderBy: [{ timestamp: "asc" }, { id: "asc" }],
      take: after + 1, // +1 so the target itself counts toward the slice
    }),
  ]);

  const hasMoreOlder = olderRows.length > before;
  const olderDesc = hasMoreOlder ? olderRows.slice(0, before) : olderRows;
  const olderAsc = [...olderDesc].reverse();
  const messages = [...olderAsc, ...anchorAndNewer].map(mapMessage);

  const oldest = olderAsc[0];
  const nextOlderCursor =
    hasMoreOlder && oldest
      ? encodeMessageCursor({ timestamp: oldest.timestamp, id: oldest.id })
      : null;

  return { messages, hasMoreOlder, nextOlderCursor };
}
