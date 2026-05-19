import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type {
  ConversationWithRefs,
  CursorPage,
  Message,
} from "@ccp/shared/types";

import {
  clampTake,
  mapContact,
  mapContactListItem,
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
 * `search` filters by contact name / phone / latest-message preview using
 * case-insensitive substring match. Searches the loaded slice's haystack
 * server-side so the user can find threads buried under hundreds of others
 * without scrolling. Without a pg_trgm index this is a sequential scan —
 * fine at pilot scale (single-digit ms for a few thousand rows). Switch to
 * a trigram index past ~50k conversations.
 *
 * Includes contact + assigned user; does NOT pull messages/notes (the
 * thread page hydrates those separately to keep the list query lean).
 */
export type ListConversationsFilter =
  | { kind: "preset"; id: "all" | "mine" | "unassigned" | "closed" }
  | { kind: "stage"; stageId: string };

export async function listConversations(
  teamId: string,
  opts: {
    take?: number;
    cursor?: string | null;
    search?: string;
    /**
     * The signed-in agent. When set we populate `conversation.unreadForMe`
     * by comparing their ConversationReadReceipt against each row's
     * lastMessageAt. Omit for server-to-server reads where per-agent unread
     * is meaningless (broadcasts, automations, external API).
     *
     * Also required to evaluate the `mine` preset filter — the WHERE
     * clause narrows by `assignedUserId = viewerUserId`.
     */
    viewerUserId?: string;
    /**
     * Server-side preset / stage narrowing. Without it the list is the
     * full team-recency feed. With it, "Mine" returns only my threads
     * regardless of where they fall in the team's activity, and so on.
     * `mine` requires `viewerUserId` — handled by the filter clause below.
     */
    filter?: ListConversationsFilter;
  } = {},
): Promise<CursorPage<ConversationWithRefs>> {
  const take = clampTake(opts.take, CONVERSATIONS_PAGE);
  const cursor = parseConvoCursor(opts.cursor ?? null);
  const search = opts.search?.trim() ?? "";

  // Keyset clause (recency-paginated). Built separately so it composes
  // with the optional search clause via `AND`.
  const keysetClause: Prisma.ConversationWhereInput | null = cursor
    ? {
        OR: [
          { lastMessageAt: { lt: cursor.lastMessageAt } },
          { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
        ],
      }
    : null;

  // Search clause: name / phone / last-message preview, case-insensitive.
  // Phone numbers are stored normalised so a plain `contains` covers
  // "5551234" matching "+15551234567" — no need for digit-only stripping.
  const searchClause: Prisma.ConversationWhereInput | null = search
    ? {
        OR: [
          { contact: { name: { contains: search, mode: "insensitive" } } },
          { contact: { phoneNumber: { contains: search } } },
          { lastMessagePreview: { contains: search, mode: "insensitive" } },
        ],
      }
    : null;

  // Preset / stage narrowing. Index coverage:
  //   - status filters use `(teamId, status, lastMessageAt DESC)` index
  //   - assignedUserId filters use `(teamId, assignedUserId)` index
  //   - stage filter joins through Contact, which has `(teamId, stageId)`
  // Closed threads are excluded from every preset EXCEPT `closed`, and
  // from the stage view (matches the sub-sidebar's selected-list behavior).
  let filterClause: Prisma.ConversationWhereInput | null = null;
  if (opts.filter?.kind === "preset") {
    switch (opts.filter.id) {
      case "all":
        filterClause = { status: { not: "closed" } };
        break;
      case "mine":
        // `mine` without a viewer never matches — server-to-server callers
        // hitting this filter is a programming error; the empty result
        // surfaces it loudly without leaking other agents' threads.
        filterClause = opts.viewerUserId
          ? { status: { not: "closed" }, assignedUserId: opts.viewerUserId }
          : { id: "__no_match__" };
        break;
      case "unassigned":
        filterClause = { status: { not: "closed" }, assignedUserId: null };
        break;
      case "closed":
        filterClause = { status: "closed" };
        break;
    }
  } else if (opts.filter?.kind === "stage") {
    filterClause = {
      status: { not: "closed" },
      contact: { stageId: opts.filter.stageId },
    };
  }

  const composedClauses = [keysetClause, searchClause, filterClause].filter(
    (c): c is Prisma.ConversationWhereInput => c !== null,
  );
  const where: Prisma.ConversationWhereInput = {
    teamId,
    ...(composedClauses.length > 1
      ? { AND: composedClauses }
      : composedClauses[0] ?? {}),
  };

  const rows = await db.conversation.findMany({
    where,
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: {
      // Explicit select keeps the per-row payload lean — adding heavier
      // relations to Contact (customFields, identityProvider, etc.) doesn't
      // automatically bloat every inbox-list response. Tags come back via
      // the nested `tags` include since they live on Contact in this app
      // (one contact = one conversation, so per-thread tags would be dead
      // complexity).
      contact: {
        // `customFields` is JSONB — potentially many keys × N rows × every
        // refresh. Dropped here because the list UI never renders it (only
        // name/stage/tags). Re-fetched in full by the per-conversation
        // query when an agent opens a thread.
        select: {
          id: true,
          teamId: true,
          name: true,
          firstName: true,
          lastName: true,
          language: true,
          countryCode: true,
          assignedUserId: true,
          phoneNumber: true,
          identityProvider: true,
          externalContactId: true,
          avatarUrl: true,
          email: true,
          location: true,
          source: true,
          stageId: true,
          createdAt: true,
          // Denormalized — drives the inbox-row 24h-window chip without
          // the lateral MAX(message.timestamp) GROUP BY that the list
          // used to do per page.
          lastInboundAt: true,
          tags: { select: { id: true } },
        },
      },
      assignedUser: true,
    },
  });

  const hasMore = rows.length > take;
  const sliced = hasMore ? rows.slice(0, take) : rows;
  const last = sliced.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeConvoCursor({ lastMessageAt: last.lastMessageAt, id: last.id })
      : null;

  // Pull lastInboundAt straight from the denormalized `Contact.lastInboundAt`
  // column maintained by the ingest path — saves the per-page lateral
  // MAX(m.timestamp) GROUP BY contactId roundtrip the inbox list used to do
  // (still kept below as `fetchLastInboundMap` for any future caller that
  // needs the same value on a contact NOT yet in the SELECT).
  const inboundMap = new Map<string, string | null>(
    sliced.map((r) => [
      r.contact.id,
      r.contact.lastInboundAt ? r.contact.lastInboundAt.toISOString() : null,
    ]),
  );

  // Per-agent unread. Derived from `ConversationReadReceipt` rows: a
  // conversation is "unread for me" iff its `lastMessageAt` is newer than
  // my receipt's `lastReadAt` (or I have no receipt). One indexed read
  // scoped to this page — no N+1.
  //
  // Semantically distinct from team-wide `unreadCount`: the badge number
  // still reflects team-wide ("team has 3 unread"), while the row's
  // bold-text now reflects per-agent ("I haven't seen this"). A teammate
  // marking read zeroes the team counter but doesn't clear my per-agent
  // flag — matches WhatsApp / Slack / Front semantics.
  const sliceIds = sliced.map((r) => r.id);
  const receiptMap = new Map<string, Date>();
  if (opts.viewerUserId && sliceIds.length > 0) {
    const receipts = await db.conversationReadReceipt.findMany({
      where: { userId: opts.viewerUserId, conversationId: { in: sliceIds } },
      select: { conversationId: true, lastReadAt: true },
    });
    for (const r of receipts) receiptMap.set(r.conversationId, r.lastReadAt);
  }

  const items = sliced.map((row) => {
    const seenAt = receiptMap.get(row.id);
    const unreadForMe = opts.viewerUserId
      ? !seenAt || seenAt.getTime() < row.lastMessageAt.getTime()
      : undefined;
    return {
      conversation: {
        ...mapConversation(row),
        ...(unreadForMe !== undefined ? { unreadForMe } : {}),
      },
      contact: {
        ...mapContactListItem(row.contact),
        tagIds: row.contact.tags.map((t) => t.id),
      },
      assignedUser: row.assignedUser ? mapUser(row.assignedUser) : null,
      messages: [],
      notes: [],
      lastInboundAt: inboundMap.get(row.contact.id) ?? null,
    };
  });

  return { items, nextCursor };
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
  opts: { messageLimit?: number; viewerUserId?: string } = {},
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

  // Latest inbound across ALL of this contact's conversations (the 24h
  // window is contact-level on Meta's side). Read from the denormalized
  // `Contact.lastInboundAt` column maintained by the ingest path — the
  // previous Message scan with a join through Conversation seq-scanned
  // a heavy contact's entire history on every thread open.
  // Per-agent unread + counts fan in parallel (counts are independent;
  // receipt is one indexed read).
  const [messageCount, noteCount, receipt] = await Promise.all([
    db.message.count({ where: { conversationId } }),
    db.internalNote.count({ where: { conversationId } }),
    opts.viewerUserId
      ? db.conversationReadReceipt.findUnique({
          where: {
            userId_conversationId: { userId: opts.viewerUserId, conversationId },
          },
          select: { lastReadAt: true },
        })
      : Promise.resolve(null),
  ]);
  const lastInboundAtIso = row.contact.lastInboundAt
    ? row.contact.lastInboundAt.toISOString()
    : null;

  const unreadForMe = opts.viewerUserId
    ? !receipt || receipt.lastReadAt.getTime() < row.lastMessageAt.getTime()
    : undefined;

  return {
    data: {
      conversation: {
        ...mapConversation(row),
        ...(unreadForMe !== undefined ? { unreadForMe } : {}),
      },
      contact: {
        ...mapContact(row.contact),
        tagIds: row.contact.tags.map((t) => t.id),
      },
      assignedUser: row.assignedUser ? mapUser(row.assignedUser) : null,
      messages: messagesAsc.map(mapMessage),
      notes: row.notes.map(mapNote),
      lastInboundAt: lastInboundAtIso,
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

/**
 * Page of messages strictly NEWER than the given ISO timestamp, chronological
 * (oldest-first). Closes the SSR → socket-subscribe gap: any webhook that
 * landed between server render and the client's `subscribe:conversation` was
 * emitted into an empty room, so on (re)connect the client asks for the
 * delta and dedupes by externalId on the way in.
 *
 * `state` carries the current conversation header (status + assignedUser +
 * unreadCount) so the same backfill also re-syncs non-message events that
 * fired during the gap — without it, an assignment / status / read flip
 * during a reconnect-after-disconnect would stay stuck on the stale value
 * until the agent navigates away and back. Tracked as Finding #7 in the
 * assignment audit.
 *
 * No cursor — the delta is bounded by how long the tab was hydrating or
 * disconnected. We cap at MESSAGES_PAGE; on the rare case it's hit, the
 * client should treat it as "too far behind" and force a thread re-fetch.
 */
export async function listNewerMessages(
  teamId: string,
  conversationId: string,
  opts: { after: string; take?: number; viewerUserId?: string },
): Promise<{
  items: Message[];
  state?: {
    status: import("@ccp/shared/types").ConversationStatus;
    assignedUserId: string | null;
    assignedUser: import("@ccp/shared/types").User | null;
    unreadCount: number;
    unreadForMe?: boolean;
  };
}> {
  const afterDate = new Date(opts.after);
  if (Number.isNaN(afterDate.getTime())) return { items: [] };

  // Same tenant gate as listOlderMessages — silent empty page so we don't
  // leak which conversation IDs exist in other teams. Pull the header
  // fields the reconnect-resync needs in the same round-trip; selected
  // fields are cheap and avoid a second query. Per-agent receipt is one
  // extra indexed lookup when a viewer is set.
  const [owns, receipt] = await Promise.all([
    db.conversation.findFirst({
      where: { id: conversationId, teamId },
      include: { assignedUser: true },
    }),
    opts.viewerUserId
      ? db.conversationReadReceipt.findUnique({
          where: {
            userId_conversationId: { userId: opts.viewerUserId, conversationId },
          },
          select: { lastReadAt: true },
        })
      : Promise.resolve(null),
  ]);
  if (!owns) return { items: [] };

  const take = clampTake(opts.take, MESSAGES_PAGE);
  const rows = await db.message.findMany({
    omit: { rawPayload: true },
    include: { replyTo: REPLY_TO_INCLUDE },
    where: { conversationId, timestamp: { gt: afterDate } },
    orderBy: [{ timestamp: "asc" }, { id: "asc" }],
    take,
  });

  const unreadForMe = opts.viewerUserId
    ? !receipt || receipt.lastReadAt.getTime() < owns.lastMessageAt.getTime()
    : undefined;

  return {
    items: rows.map(mapMessage),
    state: {
      status: owns.status,
      assignedUserId: owns.assignedUserId,
      assignedUser: owns.assignedUser ? mapUser(owns.assignedUser) : null,
      unreadCount: owns.unreadCount,
      ...(unreadForMe !== undefined ? { unreadForMe } : {}),
    },
  };
}
