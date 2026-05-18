import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { stripMentionMarkup } from "@ccp/shared/team-chat/mentions";
import type {
  ChannelMessagesAroundPage,
  ChannelMessagesPage,
  ChannelPinDto,
  TeamChannelDto,
  TeamChannelListItemDto,
  TeamChannelMessageDto,
  WorkspaceSearchPage,
} from "@ccp/shared/team-chat/types";

/**
 * Server-side reads for team chat. Keeps the route handlers thin: they call
 * one of these and serialize the result. Mapping from Prisma rows → DTO
 * happens here so SSR and socket emits go through the same code path.
 */

const PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

// Shape we always pull for messages — keeps the include cost predictable.
// Cast `as const` so Prisma keeps the literal types and the mapper below
// stays strictly typed.
const MESSAGE_INCLUDE = {
  author: {
    select: { id: true, name: true, avatarUrl: true },
  },
  mentions: { select: { mentionedUserId: true } },
  reactions: { select: { emoji: true, userId: true } },
  pin: { select: { id: true } },
} as const satisfies Prisma.TeamChannelMessageInclude;

type MessageRow = Prisma.TeamChannelMessageGetPayload<{ include: typeof MESSAGE_INCLUDE }>;

// ===========================================================================
// Mapping
// ===========================================================================

export function mapChannel(row: {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  lastMessagePreview: string;
}): TeamChannelDto {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    description: row.description,
    isDefault: row.isDefault,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessagePreview: row.lastMessagePreview,
  };
}

export function mapMessage(row: MessageRow): TeamChannelMessageDto {
  // Fold reactions into per-emoji buckets. Emit emojis in insertion order
  // (first-reactor first) — gives a deterministic chip layout per render.
  const reactionMap = new Map<string, string[]>();
  for (const r of row.reactions) {
    const bucket = reactionMap.get(r.emoji);
    if (bucket) bucket.push(r.userId);
    else reactionMap.set(r.emoji, [r.userId]);
  }
  const reactions = [...reactionMap.entries()].map(([emoji, userIds]) => ({
    emoji,
    userIds,
  }));

  const media =
    row.mediaKind && row.mediaUrl && row.mediaMimeType
      ? {
          kind: row.mediaKind,
          url: row.mediaUrl,
          mimeType: row.mediaMimeType,
          sizeBytes: row.mediaSizeBytes ?? 0,
          ...(row.mediaCaption ? { caption: row.mediaCaption } : {}),
          ...(row.mediaFilename ? { filename: row.mediaFilename } : {}),
          ...(row.mediaDurationMs !== null && row.mediaDurationMs !== undefined
            ? { durationMs: row.mediaDurationMs }
            : {}),
        }
      : undefined;

  return {
    id: row.id,
    channelId: row.channelId,
    teamId: row.teamId,
    authorUserId: row.authorUserId,
    authorName: row.author?.name ?? null,
    authorAvatarUrl: row.author?.avatarUrl ?? null,
    body: row.body,
    ...(media ? { media } : {}),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    threadRootId: row.threadRootId,
    threadReplyCount: row.threadReplyCount,
    threadLastReplyAt: row.threadLastReplyAt
      ? row.threadLastReplyAt.toISOString()
      : null,
    mentionedUserIds: row.mentions.map((m) => m.mentionedUserId),
    reactions,
    pinned: row.pin !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Load a message by id with the full include surface. Used by the socket
 * emit code path after a mutation so the wire payload is the same shape
 * the SSR pages return. Returns null when the row doesn't exist or doesn't
 * belong to the team.
 */
export async function loadMessageForEmit(
  messageId: string,
  teamId: string,
): Promise<TeamChannelMessageDto | null> {
  const row = await db.teamChannelMessage.findFirst({
    where: { id: messageId, teamId },
    include: MESSAGE_INCLUDE,
  });
  return row ? mapMessage(row) : null;
}

// ===========================================================================
// Channel list
// ===========================================================================

/**
 * Sidebar list of channels with per-user unread state. One round-trip:
 * fetch channels + the viewer's read receipts in parallel. Mention counts
 * use a separate aggregated query so the cost is one indexed scan per
 * call, not N+1.
 *
 * Returns channels sorted by `name ASC` so #announcements / #general are
 * predictable in the sidebar — last-activity sort confuses muscle memory.
 */
export async function listChannelsForUser(
  teamId: string,
  userId: string,
): Promise<TeamChannelListItemDto[]> {
  const [channels, receipts, mentionAgg] = await Promise.all([
    db.teamChannel.findMany({
      where: { teamId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
    db.teamChannelReadReceipt.findMany({
      where: { userId, channel: { teamId } },
      select: { channelId: true, lastReadAt: true },
    }),
    // Count of (mention, message) pairs newer than the viewer's last-read
    // on each channel. SQL because the predicate joins three tables (mention
    // → message → channel + receipt for THIS user). Cheap because the
    // mention index on mentionedUserId is the leading column.
    db.$queryRaw<{ channelId: string; count: bigint }[]>`
      SELECT m."channelId" AS "channelId", COUNT(*) AS "count"
      FROM "TeamChannelMention" mn
      INNER JOIN "TeamChannelMessage" m ON m."id" = mn."messageId"
      LEFT JOIN "TeamChannelReadReceipt" r
        ON r."channelId" = m."channelId" AND r."userId" = ${userId}
      WHERE mn."mentionedUserId" = ${userId}
        AND m."teamId" = ${teamId}
        AND (r."lastReadAt" IS NULL OR m."createdAt" > r."lastReadAt")
      GROUP BY m."channelId"
    `,
  ]);

  const receiptByChannel = new Map(receipts.map((r) => [r.channelId, r.lastReadAt]));
  const mentionsByChannel = new Map(
    mentionAgg.map((row) => [row.channelId, Number(row.count)]),
  );

  return channels.map((ch) => {
    const lastRead = receiptByChannel.get(ch.id);
    // No receipt yet = the user has never opened this channel. Treat as
    // unread iff the channel has had any message activity at all. Brand-new
    // channels with no messages should NOT badge — there's nothing to read.
    // We approximate "has activity" by comparing lastMessageAt to createdAt:
    // a channel with zero messages has lastMessageAt === createdAt (the
    // schema default). Imperfect (a single message landing on createdAt
    // millisecond loses), but cheap and self-correcting on the next message.
    const unreadForMe = lastRead
      ? ch.lastMessageAt > lastRead
      : ch.lastMessageAt.getTime() > ch.createdAt.getTime();
    return {
      ...mapChannel(ch),
      unreadForMe,
      unreadMentionCount: mentionsByChannel.get(ch.id) ?? 0,
    };
  });
}

export async function getChannelById(
  channelId: string,
  teamId: string,
): Promise<TeamChannelDto | null> {
  const row = await db.teamChannel.findFirst({
    where: { id: channelId, teamId },
  });
  return row ? mapChannel(row) : null;
}

/** Resolve a channel by URL slug (name). Returns null when not found. */
export async function getChannelByName(
  name: string,
  teamId: string,
): Promise<TeamChannelDto | null> {
  const row = await db.teamChannel.findFirst({
    where: { teamId, name },
  });
  return row ? mapChannel(row) : null;
}

/** Default channel for a team — the one /team redirects to. */
export async function getDefaultChannel(teamId: string): Promise<TeamChannelDto | null> {
  const row = await db.teamChannel.findFirst({
    where: { teamId, isDefault: true },
    orderBy: { createdAt: "asc" },
  });
  if (row) return mapChannel(row);
  // Fallback: alphabetically-first channel. Happens if the default was
  // somehow demoted without another being promoted — defensive only.
  const fallback = await db.teamChannel.findFirst({
    where: { teamId },
    orderBy: { name: "asc" },
  });
  return fallback ? mapChannel(fallback) : null;
}

// ===========================================================================
// Messages — channel feed + thread panel
// ===========================================================================

/**
 * Keyset-paginated channel feed (top-level messages only — replies live in
 * threads). Cursor is the oldest createdAt+id we already have; we ask for
 * "older than this". Returns oldest-first to match how it'll be rendered
 * after sort. Page size capped server-side.
 *
 * When `before` is null, we return the most recent page.
 */
export async function listChannelMessages(
  channelId: string,
  teamId: string,
  opts: { take?: number; before?: { createdAt: string; id: string } | null } = {},
): Promise<ChannelMessagesPage> {
  const take = Math.min(opts.take ?? PAGE_SIZE, MAX_PAGE_SIZE);

  // We always pull `take + 1` so we can tell whether there's another page
  // without a second count() query.
  const rows = await db.teamChannelMessage.findMany({
    where: {
      channelId,
      teamId,
      threadRootId: null,
      ...(opts.before
        ? {
            OR: [
              { createdAt: { lt: new Date(opts.before.createdAt) } },
              {
                createdAt: new Date(opts.before.createdAt),
                id: { lt: opts.before.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: MESSAGE_INCLUDE,
  });

  const hasMore = rows.length > take;
  const slice = hasMore ? rows.slice(0, take) : rows;
  const items = slice.map(mapMessage).reverse(); // oldest-first for the UI
  const nextCursor =
    hasMore && slice.length > 0
      ? encodeCursor(slice[slice.length - 1]!.createdAt, slice[slice.length - 1]!.id)
      : null;
  return { items, nextCursor };
}

/**
 * Context-window fetch around an anchor message. Used by jump-to-message
 * from search results when the anchor isn't in the caller's loaded slice.
 * Returns up to `take/2` messages strictly older + the anchor + up to
 * `take/2` messages strictly newer, all oldest-first.
 *
 * Three queries in parallel (anchor + older + newer) because they're
 * independent — sequential awaits would triple the latency on a "Jump to"
 * click. Anchor is fetched separately (not derivable from a single keyset
 * scan in either direction).
 */
export async function listChannelMessagesAround(
  channelId: string,
  teamId: string,
  anchorMessageId: string,
  take = PAGE_SIZE,
): Promise<ChannelMessagesAroundPage | null> {
  const capped = Math.min(take, MAX_PAGE_SIZE);
  const half = Math.floor(capped / 2);

  // Tenant guard + cursor anchor — refuse foreign-team ids or replies (they
  // aren't on the channel feed, jump-to wouldn't land on a visible row).
  const anchor = await db.teamChannelMessage.findFirst({
    where: { id: anchorMessageId, channelId, teamId, threadRootId: null },
    select: { id: true, createdAt: true },
  });
  if (!anchor) return null;

  const [olderRows, anchorRow, newerRows] = await Promise.all([
    db.teamChannelMessage.findMany({
      where: {
        channelId,
        teamId,
        threadRootId: null,
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: half + 1, // +1 lookahead for hasMoreBefore
      include: MESSAGE_INCLUDE,
    }),
    db.teamChannelMessage.findUnique({
      where: { id: anchor.id },
      include: MESSAGE_INCLUDE,
    }),
    db.teamChannelMessage.findMany({
      where: {
        channelId,
        teamId,
        threadRootId: null,
        OR: [
          { createdAt: { gt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { gt: anchor.id } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: half + 1,
      include: MESSAGE_INCLUDE,
    }),
  ]);
  if (!anchorRow) return null;

  const hasMoreBefore = olderRows.length > half;
  const hasMoreAfter = newerRows.length > half;
  const olderSlice = hasMoreBefore ? olderRows.slice(0, half) : olderRows;
  const newerSlice = hasMoreAfter ? newerRows.slice(0, half) : newerRows;

  // Reverse older (was DESC for keyset) so the final array is asc.
  const items = [
    ...olderSlice.map(mapMessage).reverse(),
    mapMessage(anchorRow),
    ...newerSlice.map(mapMessage),
  ];

  // Cursors are AT the boundary of the loaded slice so the next paginate
  // call will exclude what we already have.
  const oldestLoaded = items[0]!;
  const newestLoaded = items[items.length - 1]!;
  return {
    items,
    hasMoreBefore,
    hasMoreAfter,
    beforeCursor: hasMoreBefore ? encodeCursor(oldestLoaded.createdAt, oldestLoaded.id) : null,
    afterCursor: hasMoreAfter ? encodeCursor(newestLoaded.createdAt, newestLoaded.id) : null,
  };
}

/**
 * Fetch new messages strictly after `after`. Used by reconnect-backfill +
 * the anchored-mode "load newer" path. Returns the same `{ items, nextCursor }`
 * envelope as `listChannelMessages` so callers don't have to guess at the
 * page boundary from `items.length`. `nextCursor` is the timestamp of the
 * newest row in the slice when more remains, else null.
 */
export async function listChannelMessagesAfter(
  channelId: string,
  teamId: string,
  after: string,
  take = PAGE_SIZE,
): Promise<{ items: TeamChannelMessageDto[]; nextCursor: string | null }> {
  const limit = Math.min(take, MAX_PAGE_SIZE);
  // +1 lookahead matches the keyset pattern in `listChannelMessages`.
  const rows = await db.teamChannelMessage.findMany({
    where: {
      channelId,
      teamId,
      threadRootId: null,
      createdAt: { gt: new Date(after) },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    include: MESSAGE_INCLUDE,
  });
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const items = slice.map(mapMessage);
  const nextCursor =
    hasMore && slice.length > 0
      ? slice[slice.length - 1]!.createdAt.toISOString()
      : null;
  return { items, nextCursor };
}

/**
 * Thread replies for a root message. Keyset-paginated ascending — when an
 * `after` cursor is supplied, we return replies strictly newer than it. The
 * full thread covered by the `(threadRootId, createdAt)` index is cheap up to
 * a few hundred rows; pagination kicks in at 500+ replies so a 5k-reply mega-
 * thread doesn't ship 5k DTOs to the panel on open.
 *
 * No `before` cursor — threads are ascending and replies are read forward.
 * "Load older" doesn't apply.
 */
export async function listThreadReplies(
  rootMessageId: string,
  teamId: string,
  opts: { take?: number; after?: { createdAt: string; id: string } | null } = {},
): Promise<{ items: TeamChannelMessageDto[]; nextCursor: string | null }> {
  const take = Math.min(opts.take ?? PAGE_SIZE, MAX_PAGE_SIZE);
  const rows = await db.teamChannelMessage.findMany({
    where: {
      threadRootId: rootMessageId,
      teamId,
      ...(opts.after
        ? {
            OR: [
              { createdAt: { gt: new Date(opts.after.createdAt) } },
              {
                createdAt: new Date(opts.after.createdAt),
                id: { gt: opts.after.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: take + 1,
    include: MESSAGE_INCLUDE,
  });
  const hasMore = rows.length > take;
  const slice = hasMore ? rows.slice(0, take) : rows;
  const items = slice.map(mapMessage);
  const nextCursor =
    hasMore && slice.length > 0
      ? encodeCursor(slice[slice.length - 1]!.createdAt, slice[slice.length - 1]!.id)
      : null;
  return { items, nextCursor };
}

/**
 * Substring/case-insensitive search inside a single channel's top-level
 * messages. Backed by the `pg_trgm` GIN index on `body` — see the migration
 * `20260518000000_team_chat_search_and_partial_index`. ILIKE patterns shorter
 * than 3 chars hit the index only for prefix matches; the controller refuses
 * those upstream so we never sequential-scan from a 1-char query.
 *
 * Keyset-paginated by `(createdAt DESC, id DESC)` — the same shape as the
 * main feed, so the UI can paginate results with familiar semantics.
 * Thread replies are excluded because the search surfaces "messages I can
 * jump to in this channel"; replies are accessed via their thread panel.
 */
export async function searchChannelMessages(
  channelId: string,
  teamId: string,
  q: string,
  opts: { take?: number; before?: { createdAt: string; id: string } | null } = {},
): Promise<ChannelMessagesPage> {
  const take = Math.min(opts.take ?? PAGE_SIZE, MAX_PAGE_SIZE);
  const rows = await db.teamChannelMessage.findMany({
    where: {
      channelId,
      teamId,
      threadRootId: null,
      body: { contains: q, mode: "insensitive" },
      ...(opts.before
        ? {
            OR: [
              { createdAt: { lt: new Date(opts.before.createdAt) } },
              {
                createdAt: new Date(opts.before.createdAt),
                id: { lt: opts.before.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: MESSAGE_INCLUDE,
  });
  const hasMore = rows.length > take;
  const slice = hasMore ? rows.slice(0, take) : rows;
  // Keep search results newest-first — different from the main feed (which
  // reverses to oldest-first for ascending render). Search UX surfaces the
  // most-recent match at the top of the list.
  const items = slice.map(mapMessage);
  const nextCursor =
    hasMore && slice.length > 0
      ? encodeCursor(slice[slice.length - 1]!.createdAt, slice[slice.length - 1]!.id)
      : null;
  return { items, nextCursor };
}

export async function getMessageById(
  messageId: string,
  teamId: string,
): Promise<TeamChannelMessageDto | null> {
  return loadMessageForEmit(messageId, teamId);
}

/**
 * Workspace-wide search across every channel in the team. Same trigram index
 * powers it; the WHERE drops the per-channel filter and joins the channel row
 * to expose `channelName` on each hit so the result row can show context.
 *
 * Cursor shape is identical to `searchChannelMessages` so the frontend reuses
 * the same encode/decode helpers. The pg_trgm index dominates the predicate;
 * the planner bitmap-ANDs with the team filter on the channel side via the
 * `teamId` column denormalized on TeamChannelMessage.
 */
export async function searchAllChannels(
  teamId: string,
  q: string,
  opts: { take?: number; before?: { createdAt: string; id: string } | null } = {},
): Promise<WorkspaceSearchPage> {
  const take = Math.min(opts.take ?? PAGE_SIZE, MAX_PAGE_SIZE);
  const rows = await db.teamChannelMessage.findMany({
    where: {
      teamId,
      threadRootId: null,
      body: { contains: q, mode: "insensitive" },
      ...(opts.before
        ? {
            OR: [
              { createdAt: { lt: new Date(opts.before.createdAt) } },
              {
                createdAt: new Date(opts.before.createdAt),
                id: { lt: opts.before.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: {
      ...MESSAGE_INCLUDE,
      channel: { select: { name: true } },
    },
  });
  const hasMore = rows.length > take;
  const slice = hasMore ? rows.slice(0, take) : rows;
  const items = slice.map((row) => ({
    message: mapMessage(row),
    channelName: row.channel.name,
  }));
  const nextCursor =
    hasMore && slice.length > 0
      ? encodeCursor(slice[slice.length - 1]!.createdAt, slice[slice.length - 1]!.id)
      : null;
  return { items, nextCursor };
}

// ===========================================================================
// Pinned messages
// ===========================================================================

export async function listChannelPins(
  channelId: string,
  teamId: string,
): Promise<ChannelPinDto[]> {
  const rows = await db.teamChannelPin.findMany({
    where: { channelId, channel: { teamId } },
    orderBy: { pinnedAt: "desc" },
    include: {
      pinnedBy: { select: { name: true } },
      message: { include: MESSAGE_INCLUDE },
    },
  });
  return rows.map((p) => ({
    messageId: p.messageId,
    pinnedAt: p.pinnedAt.toISOString(),
    pinnedById: p.pinnedById,
    pinnedByName: p.pinnedBy?.name ?? null,
    message: mapMessage(p.message),
  }));
}

// ===========================================================================
// Helpers
// ===========================================================================

/** Cheap preview shown in the channel list. Strips mention markup. */
export function buildMessagePreview(body: string, hasMedia: boolean): string {
  const text = stripMentionMarkup(body).trim();
  if (text) return text.slice(0, 200);
  if (hasMedia) return "📎 Attachment";
  return "";
}

// Cursor encoding — opaque to the client. Format: base64url(`<iso>|<id>`).
// Same shape as the conversation messages cursor; staying consistent avoids
// surprises if a future cross-surface helper ever shares cursor logic.

export function encodeCursor(createdAt: string | Date, id: string): string {
  const iso = typeof createdAt === "string" ? createdAt : createdAt.toISOString();
  return Buffer.from(`${iso}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [createdAt, id] = decoded.split("|", 2);
    if (!createdAt || !id) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
