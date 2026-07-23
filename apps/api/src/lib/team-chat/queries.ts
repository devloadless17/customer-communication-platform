import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { stripMentionMarkup } from "@ccp/shared/team-chat/mentions";
import type {
  ChannelMessagesAroundPage,
  ChannelMessagesPage,
  ChannelPinDto,
  DirectMessagePeerDto,
  TeamChannelBrowseItemDto,
  TeamChannelBrowsePage,
  TeamChannelDto,
  TeamChannelKind,
  TeamChannelListItemDto,
  TeamChannelMessageDto,
  TeamChannelVisibility,
  TeamDmListItemDto,
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

export function mapChannel(
  row: {
    id: string;
    workspaceId: string;
    name: string | null;
    description: string | null;
    isDefault: boolean;
    kind: TeamChannelKind;
    visibility: TeamChannelVisibility;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
    lastMessageAt: Date;
    lastMessagePreview: string;
  },
  memberCount = 0,
  lastReadAt: Date | null = null,
): TeamChannelDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    isDefault: row.isDefault,
    kind: row.kind,
    visibility: row.visibility,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessagePreview: row.lastMessagePreview,
    memberCount,
    lastReadAt: lastReadAt ? lastReadAt.toISOString() : null,
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
          // RELATIVE auth-gated proxy path — NOT the raw CDN URL. The
          // ChannelsController route redirects to the `isOwnUrl`-validated CDN
          // URL only after a team + channel-membership check, so internal
          // attachments are protected by auth, not just key unguessability
          // (M4). Resolves the same way WhatsApp media's `/api/media/:id` does.
          url: `/api/workspace/channels/${row.channelId}/messages/${row.id}/media`,
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
    workspaceId: row.workspaceId,
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
  workspaceId: string,
): Promise<TeamChannelMessageDto | null> {
  const row = await db.teamChannelMessage.findFirst({
    where: { id: messageId, workspaceId },
    include: MESSAGE_INCLUDE,
  });
  return row ? mapMessage(row) : null;
}

// ===========================================================================
// Channel list
// ===========================================================================

/**
 * Shared engine behind BOTH the channel sidebar and the DM list: loads the
 * viewer's rows plus their unread/mention state in one round-trip.
 *
 * Extracted rather than duplicated so the two surfaces cannot drift on what
 * "unread" means — a DM badging by different rules than a channel would be a
 * subtle, permanent source of confusion.
 *
 * `where` narrows to the surface (kind: "channel" vs kind: "dm"); `orderBy`
 * differs because channels sort by name (muscle memory) and DMs by recency.
 */
async function listChannelRowsForUser<T extends Prisma.TeamChannelInclude | undefined>(
  workspaceId: string,
  userId: string,
  where: Prisma.TeamChannelWhereInput,
  orderBy: Prisma.TeamChannelOrderByWithRelationInput[],
  include?: T,
) {
  const [channels, receipts, mentionAgg] = await Promise.all([
    // Only rows the viewer is a member of. The default channel auto-includes
    // every team member (enforced at create/team-join time), so users who haven't
    // been explicitly added to anything still see #general.
    //
    // Member counts ride along as a per-row `_count` rather than a parallel
    // groupBy. The groupBy had to be scoped by the same `where` as this query
    // (the viewer's ids aren't known until this resolves), which for DMs meant
    // aggregating membership rows for EVERY DM in the tenant — O(users²) —
    // and discarding all but a dozen. This counts only the rows we return.
    db.teamChannel.findMany({
      where: { workspaceId, members: { some: { userId } }, ...where },
      orderBy,
      include: {
        ...(include ?? {}),
        _count: { select: { members: true } },
      } as Prisma.TeamChannelInclude,
    }),
    db.teamChannelReadReceipt.findMany({
      where: { userId, channel: { workspaceId } },
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
        AND m."workspaceId" = ${workspaceId}
        -- COALESCE(editedAt, createdAt) — see the matching comment on
        -- ChannelsService.unreadMentionCount. An edit can ADD a mention, and by
        -- then the message's createdAt is older than the reader's receipt, so
        -- comparing createdAt alone dropped it silently and forever.
        AND (
          r."lastReadAt" IS NULL
          OR COALESCE(m."editedAt", m."createdAt") > r."lastReadAt"
        )
      GROUP BY m."channelId"
    `,
  ]);

  const receiptByChannel = new Map(receipts.map((r) => [r.channelId, r.lastReadAt]));
  const mentionsByChannel = new Map(
    mentionAgg.map((row) => [row.channelId, Number(row.count)]),
  );

  return channels.map((ch) => {
    const lastRead = receiptByChannel.get(ch.id) ?? null;
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
      row: ch,
      item: {
        ...mapChannel(
          ch,
          (ch as typeof ch & { _count?: { members: number } })._count?.members ?? 0,
          lastRead,
        ),
        unreadForMe,
        unreadMentionCount: mentionsByChannel.get(ch.id) ?? 0,
      } satisfies TeamChannelListItemDto,
    };
  });
}

/**
 * Sidebar list of channels with per-user unread state.
 *
 * Returns channels sorted by `name ASC` so #announcements / #general are
 * predictable in the sidebar — last-activity sort confuses muscle memory.
 *
 * The `kind: "channel"` filter is load-bearing: without it every DM the
 * viewer is in would appear in the channel sidebar with a null name.
 */
export async function listChannelsForUser(
  workspaceId: string,
  userId: string,
): Promise<TeamChannelListItemDto[]> {
  const rows = await listChannelRowsForUser(
    workspaceId,
    userId,
    { kind: "channel" },
    [{ isDefault: "desc" }, { name: "asc" }],
  );
  return rows.map((r) => r.item);
}

/**
 * Sidebar list of the viewer's 1:1 DMs, most-recently-active first (unlike
 * channels, which sort by name — a DM list is a recency list).
 *
 * The peer is resolved from the membership rows: the member who isn't the
 * viewer, falling back to the viewer themselves for the notes-to-self DM,
 * falling back to a "Removed user" tombstone when the peer's User row was
 * hard-deleted (the membership cascade removes the row, but the DM and its
 * history survive — deleting it would destroy the survivor's messages).
 */
export async function listDirectMessagesForUser(
  workspaceId: string,
  userId: string,
): Promise<TeamDmListItemDto[]> {
  const rows = await listChannelRowsForUser(
    workspaceId,
    userId,
    { kind: "dm" },
    [{ lastMessageAt: "desc" }],
    {
      members: {
        select: DM_MEMBER_SELECT,
      },
    },
  );

  return rows.map(({ row, item }) => {
    const members = (row as unknown as { members: DmMemberRow[] }).members;
    return { ...item, peer: mapDmPeer(members, userId) };
  });
}

/**
 * Membership rows as the DM queries select them. The shared row loader types
 * its `include` loosely (it merges the caller's include with a `_count`), so
 * the shape we actually asked for is named here.
 */
type DmMemberRow = {
  userId: string;
  user: {
    id: string;
    name: string | null;
    avatarUrl: string | null;
    deactivatedAt: Date | null;
  } | null;
};

/** Select clause that produces a `DmMemberRow`. Shared so the list query and
 *  the by-id query can't drift apart. */
const DM_MEMBER_SELECT = {
  userId: true,
  user: { select: { id: true, name: true, avatarUrl: true, deactivatedAt: true } },
} as const;

/**
 * The other participant in a DM, from its membership rows.
 *
 * The peer is the non-viewer member. A self-DM ("notes to self") has exactly
 * one member row — the viewer — so fall back to it and flag `isSelf`. A peer
 * whose User row was HARD-deleted leaves no membership row at all (the cascade
 * removes it) while the DM and its history survive, because deleting those
 * would destroy the survivor's own messages; that case renders as a tombstone.
 */
function mapDmPeer(members: DmMemberRow[], userId: string): DirectMessagePeerDto {
  const other = members.find((m) => m.userId !== userId) ?? null;
  const isSelf = other === null;
  const source = other ?? members.find((m) => m.userId === userId) ?? null;

  return source?.user
    ? {
        userId: source.user.id,
        name: source.user.name ?? "Unnamed",
        avatarUrl: source.user.avatarUrl,
        deactivated: source.user.deactivatedAt !== null,
        isSelf,
      }
    : {
        userId: null,
        name: "Removed user",
        avatarUrl: null,
        deactivated: true,
        isSelf,
      };
}

/**
 * Single channel by id. Takes `userId` so it can project the viewer's read
 * receipt onto the DTO — that timestamp is what the "New messages" divider
 * anchors to, and it has to come from the same read that loads the channel
 * (the workspace fires markRead() on mount, so fetching it later is racy).
 */
export async function getChannelById(
  channelId: string,
  workspaceId: string,
  userId: string,
): Promise<TeamChannelDto | null> {
  const row = await db.teamChannel.findFirst({
    where: { id: channelId, workspaceId },
    include: {
      _count: { select: { members: true } },
      receipts: { where: { userId }, select: { lastReadAt: true } },
    },
  });
  if (!row) return null;
  const dto = mapChannel(row, row._count.members, row.receipts[0]?.lastReadAt ?? null);
  if (row.kind !== "dm") return dto;
  // DM only, and as a second query rather than a blanket `include`: a DM has at
  // most two membership rows, while a busy channel can have hundreds that this
  // DTO has no use for. Resolving the peer HERE is what lets the channel page
  // server-render the right name and avatar on first paint instead of waiting
  // for the layout's client-side DM list to catch up.
  const members = await db.teamChannelMember.findMany({
    where: { channelId },
    select: DM_MEMBER_SELECT,
  });
  return { ...dto, peer: mapDmPeer(members, userId) };
}

/**
 * Default channel for a team — the one /team redirects to.
 *
 * Both branches filter `kind: "channel"`. The fallback especially: it orders
 * by name, and a team whose channels were all deleted but which has DMs would
 * otherwise redirect the user straight into a DM as their "default channel".
 */
export async function getDefaultChannel(
  workspaceId: string,
  userId: string,
): Promise<TeamChannelDto | null> {
  const row = await db.teamChannel.findFirst({
    where: { workspaceId, kind: "channel", isDefault: true },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { members: true } } },
  });
  if (row) return mapChannel(row, row._count.members);
  // Fallback: alphabetically-first channel the VIEWER IS A MEMBER OF.
  // Happens if the default was demoted without another being promoted.
  //
  // The membership filter is load-bearing, not defensive tidiness: this DTO
  // carries `lastMessagePreview`, and the route that serves it does no
  // membership check of its own. Without the filter, a demoted default would
  // hand every agent on the team the name, description and LAST MESSAGE BODY
  // of whichever private channel happens to sort first — the same leak class
  // the `OR isDefault: true` removal in searchAllChannels closed.
  const fallback = await db.teamChannel.findFirst({
    where: { workspaceId, kind: "channel", members: { some: { userId } } },
    orderBy: { name: "asc" },
    include: { _count: { select: { members: true } } },
  });
  return fallback ? mapChannel(fallback, fallback._count.members) : null;
}

// ===========================================================================
// Channel browser (public channels the viewer may not be in)
// ===========================================================================

/**
 * Public channels in the team, for the "Browse channels" dialog.
 *
 * METADATA ONLY — this query must never touch TeamChannelMessage or project
 * `lastMessagePreview`, because it is served to people who are NOT members.
 * Browsing tells you a public channel exists and how busy it is; reading it
 * still requires joining (see requireChannelMembership, deliberately
 * unbranched on visibility).
 */
export async function browsePublicChannels(
  workspaceId: string,
  viewerUserId: string,
  q: string | null,
  opts: { before?: string | null; take?: number } = {},
): Promise<TeamChannelBrowsePage> {
  const take = Math.min(Math.max(opts.take ?? PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = opts.before ? decodeCursor(opts.before) : null;

  const rows = await db.teamChannel.findMany({
    where: {
      workspaceId,
      kind: "channel",
      visibility: "public",
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      ...(cursor
        ? {
            OR: [
              { lastMessageAt: { lt: new Date(cursor.createdAt) } },
              { lastMessageAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      name: true,
      description: true,
      lastMessageAt: true,
      _count: { select: { members: true } },
    },
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  // One extra indexed lookup rather than a per-row membership subquery.
  const joined = await db.teamChannelMember.findMany({
    where: { userId: viewerUserId, channelId: { in: page.map((r) => r.id) } },
    select: { channelId: true },
  });
  const joinedIds = new Set(joined.map((j) => j.channelId));

  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      // A public channel always has a name; DMs (the only nameless rows) are
      // excluded by the kind filter above.
      name: r.name ?? "",
      description: r.description,
      memberCount: r._count.members,
      lastMessageAt: r.lastMessageAt.toISOString(),
      joined: joinedIds.has(r.id),
    })),
    nextCursor: hasMore && last ? encodeCursor(last.lastMessageAt, last.id) : null,
  };
}

/**
 * Metadata for one public channel, for the "join to see this channel" card
 * shown when someone lands on a public channel's URL without being a member.
 * Returns null for private channels and DMs — indistinguishable from "does
 * not exist", which is the point.
 */
export async function getPublicChannelPreview(
  workspaceId: string,
  channelId: string,
): Promise<TeamChannelBrowseItemDto | null> {
  const row = await db.teamChannel.findFirst({
    where: { id: channelId, workspaceId, kind: "channel", visibility: "public" },
    select: {
      id: true,
      name: true,
      description: true,
      lastMessageAt: true,
      _count: { select: { members: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    name: row.name ?? "",
    description: row.description,
    memberCount: row._count.members,
    lastMessageAt: row.lastMessageAt.toISOString(),
    joined: false,
  };
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
  workspaceId: string,
  opts: { take?: number; before?: { createdAt: string; id: string } | null } = {},
): Promise<ChannelMessagesPage> {
  const take = Math.min(opts.take ?? PAGE_SIZE, MAX_PAGE_SIZE);

  // We always pull `take + 1` so we can tell whether there's another page
  // without a second count() query.
  const rows = await db.teamChannelMessage.findMany({
    where: {
      channelId,
      workspaceId,
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
  workspaceId: string,
  anchorMessageId: string,
  take = PAGE_SIZE,
): Promise<ChannelMessagesAroundPage | null> {
  const capped = Math.min(take, MAX_PAGE_SIZE);
  const half = Math.floor(capped / 2);

  // Tenant guard + cursor anchor — refuse foreign-team ids or replies (they
  // aren't on the channel feed, jump-to wouldn't land on a visible row).
  const anchor = await db.teamChannelMessage.findFirst({
    where: { id: anchorMessageId, channelId, workspaceId, threadRootId: null },
    select: { id: true, createdAt: true },
  });
  if (!anchor) return null;

  const [olderRows, anchorRow, newerRows] = await Promise.all([
    db.teamChannelMessage.findMany({
      where: {
        channelId,
        workspaceId,
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
        workspaceId,
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
 * page boundary from `items.length`. `nextCursor` is the OPAQUE encoded cursor
 * of the newest row in the slice when more remains, else null — symmetric with
 * the `?before=` path + `listChannelMessagesAround`'s `afterCursor`, so a
 * forward-paginating client can feed it straight back into `?after=`.
 *
 * `after` accepts EITHER the `{ createdAt, id }` keyset (decoded from an
 * opaque cursor) OR a bare timestamp with `id: null` (the reconnect-backfill
 * path passes the newest known message's `createdAt`, which has no id). When
 * an id is present we use the full keyset `(createdAt, id)` so a same-
 * millisecond sibling — committed in the same ms as a row the client already
 * has — isn't skipped by a strict `createdAt >` filter. The id-less path uses
 * `createdAt >=` (relying on the client's id-dedupe) for the same reason:
 * `>` would drop a same-ms sibling the client missed.
 */
export async function listChannelMessagesAfter(
  channelId: string,
  workspaceId: string,
  after: { createdAt: string; id: string | null },
  take = PAGE_SIZE,
): Promise<{ items: TeamChannelMessageDto[]; nextCursor: string | null }> {
  const limit = Math.min(take, MAX_PAGE_SIZE);
  const afterDate = new Date(after.createdAt);
  // +1 lookahead matches the keyset pattern in `listChannelMessages`.
  const rows = await db.teamChannelMessage.findMany({
    where: {
      channelId,
      workspaceId,
      threadRootId: null,
      ...(after.id
        ? {
            // Full keyset: rows strictly after (createdAt, id). Excludes the
            // cursor row itself but keeps same-ms siblings with a higher id.
            OR: [
              { createdAt: { gt: afterDate } },
              { createdAt: afterDate, id: { gt: after.id } },
            ],
          }
        : // id-less (timestamp-only) cursor: include the cursor ms so a
          // same-ms sibling the client missed still arrives; the client
          // dedupes by id.
          { createdAt: { gte: afterDate } }),
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
      ? encodeCursor(slice[slice.length - 1]!.createdAt, slice[slice.length - 1]!.id)
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
  workspaceId: string,
  opts: { take?: number; after?: { createdAt: string; id: string } | null } = {},
): Promise<{ items: TeamChannelMessageDto[]; nextCursor: string | null }> {
  const take = Math.min(opts.take ?? PAGE_SIZE, MAX_PAGE_SIZE);
  const rows = await db.teamChannelMessage.findMany({
    where: {
      threadRootId: rootMessageId,
      workspaceId,
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
 * messages. Backed by the `pg_trgm` GIN index on `body`
 * (`TeamChannelMessage_body_trgm_idx`). ILIKE patterns shorter than 3 chars
 * hit the index only for prefix matches; the controller refuses those
 * upstream so we never sequential-scan from a 1-char query.
 *
 * Keyset-paginated by `(createdAt DESC, id DESC)` — the same shape as the
 * main feed, so the UI can paginate results with familiar semantics.
 * Thread replies are excluded because the search surfaces "messages I can
 * jump to in this channel"; replies are accessed via their thread panel.
 */
export async function searchChannelMessages(
  channelId: string,
  workspaceId: string,
  q: string,
  opts: { take?: number; before?: { createdAt: string; id: string } | null } = {},
): Promise<ChannelMessagesPage> {
  const take = Math.min(opts.take ?? PAGE_SIZE, MAX_PAGE_SIZE);
  const rows = await db.teamChannelMessage.findMany({
    where: {
      channelId,
      workspaceId,
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

/**
 * Workspace-wide search across every channel in the team. Same trigram index
 * powers it; the WHERE drops the per-channel filter and joins the channel row
 * to expose `channelName` on each hit so the result row can show context.
 *
 * Cursor shape is identical to `searchChannelMessages` so the frontend reuses
 * the same encode/decode helpers. The pg_trgm index dominates the predicate;
 * the planner bitmap-ANDs with the team filter on the channel side via the
 * `workspaceId` column denormalized on TeamChannelMessage.
 */
export async function searchAllChannels(
  workspaceId: string,
  viewerUserId: string,
  q: string,
  opts: { take?: number; before?: { createdAt: string; id: string } | null } = {},
): Promise<WorkspaceSearchPage> {
  const take = Math.min(opts.take ?? PAGE_SIZE, MAX_PAGE_SIZE);
  // CRITICAL: filter hits to channels the viewer is an ACTUAL member of.
  // Without this intersection, a member of only `#general` could search the
  // workspace for "salaries" and pull body+channel-name from a private
  // leadership channel they were never invited to — the same data-leak class
  // the per-channel membership gate closes for direct reads.
  //
  // The old `OR isDefault: true` branch is gone on purpose: it granted search
  // over the default channel regardless of membership, which was harmless
  // while "default" implied "everyone" but becomes a leak now that a channel
  // can be demoted or have its visibility changed. The
  // 20260719120000_team_chat_dm_and_visibility migration backfills an explicit
  // membership row for every user on their default channel, so nobody loses
  // their #general search results.
  //
  // `kind: "channel"` excludes DMs. Workspace search is a CHANNEL search —
  // users don't expect Cmd-K to surface private 1:1 conversations, and
  // WorkspaceSearchHit.channelName has nothing meaningful to show for one.
  // A `?scope=` param can add them later; the trgm index already serves both.
  const rows = await db.teamChannelMessage.findMany({
    where: {
      workspaceId,
      threadRootId: null,
      body: { contains: q, mode: "insensitive" },
      channel: {
        kind: "channel",
        members: { some: { userId: viewerUserId } },
      },
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
    // Non-null in practice: the `kind: "channel"` filter above excludes DMs,
    // which are the only rows with a null name.
    channelName: row.channel.name ?? "",
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
  workspaceId: string,
): Promise<ChannelPinDto[]> {
  const rows = await db.teamChannelPin.findMany({
    where: { channelId, channel: { workspaceId } },
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
