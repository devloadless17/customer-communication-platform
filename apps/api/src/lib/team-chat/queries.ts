import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { stripMentionMarkup } from "@ccp/shared/team-chat/mentions";
import type {
  ChannelMessagesPage,
  ChannelPinDto,
  TeamChannelDto,
  TeamChannelListItemDto,
  TeamChannelMessageDto,
} from "@ccp/shared/team-chat/types";

/**
 * Server-side reads for team chat. Keeps the route handlers thin: they call
 * one of these and serialize the result. Mapping from Prisma rows → DTO
 * happens here so SSR and socket emits go through the same code path.
 */

const PAGE_SIZE = 50;
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

/** Fetch new messages strictly after `after`. Used by reconnect-backfill. */
export async function listChannelMessagesAfter(
  channelId: string,
  teamId: string,
  after: string,
  take = PAGE_SIZE,
): Promise<TeamChannelMessageDto[]> {
  const rows = await db.teamChannelMessage.findMany({
    where: {
      channelId,
      teamId,
      threadRootId: null,
      createdAt: { gt: new Date(after) },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(take, MAX_PAGE_SIZE),
    include: MESSAGE_INCLUDE,
  });
  return rows.map(mapMessage);
}

/**
 * Thread replies for a root message. Chronological ascending — threads are
 * short enough in practice that we always render the whole list. Add
 * pagination if a thread ever crosses ~500 replies (defer).
 */
export async function listThreadReplies(
  rootMessageId: string,
  teamId: string,
): Promise<TeamChannelMessageDto[]> {
  const rows = await db.teamChannelMessage.findMany({
    where: { threadRootId: rootMessageId, teamId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: MESSAGE_INCLUDE,
  });
  return rows.map(mapMessage);
}

export async function getMessageById(
  messageId: string,
  teamId: string,
): Promise<TeamChannelMessageDto | null> {
  return loadMessageForEmit(messageId, teamId);
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
