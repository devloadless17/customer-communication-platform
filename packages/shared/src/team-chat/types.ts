import type { TeamChannelMessageDto } from "../socket/events";

/**
 * Public DTOs for the team-chat surface. Mirrors the socket event payloads
 * so the SSR responses (initial server-rendered slice) and the live socket
 * stream agree on the shape — no client-side normalization layer needed.
 */

/** What a channel row IS. Mirrors the `TeamChannelKind` Prisma enum. */
export type TeamChannelKind = "channel" | "dm";

/**
 * Who may JOIN a channel. Mirrors `TeamChannelVisibility`. Governs joining,
 * not reading-after-join: public channels are join-to-read, so reads still
 * go through the single `requireChannelMembership` gate.
 */
export type TeamChannelVisibility = "public" | "private";

export interface TeamChannelDto {
  id: string;
  teamId: string;
  /** NULL for DMs — they render from the peer's identity, not a name. */
  name: string | null;
  description: string | null;
  isDefault: boolean;
  kind: TeamChannelKind;
  visibility: TeamChannelVisibility;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  /**
   * Total members in the channel. Populated by list + getById endpoints.
   * Cheap aggregated COUNT(*) on the membership table; no per-user join.
   */
  memberCount: number;
  /**
   * The viewer's read receipt at the moment this DTO was built, or null if
   * they've never read the channel. Drives the "New messages" divider.
   *
   * The client must FREEZE this on open — the workspace fires markRead() on
   * mount, so a live-updating value would erase the divider before it paints.
   */
  lastReadAt: string | null;
  /**
   * The other participant, present only on a DM fetched by id (`getChannelById`).
   * Server-resolved so the DM header renders correctly on the FIRST paint.
   * Without it the header could only read the client-side DM list, which is a
   * layout-level snapshot — a DM opened seconds ago wasn't in it yet, so a
   * brand-new conversation painted a blank avatar and the literal title
   * "Direct message" until a refresh landed.
   *
   * Absent on list endpoints (they already carry `peer` on the DM list item)
   * and on non-DM channels.
   */
  peer?: DirectMessagePeerDto | null;
}

export interface TeamChannelListItemDto extends TeamChannelDto {
  /** Cheap "is there anything new for me" via lastReadAt vs lastMessageAt. */
  unreadForMe: boolean;
  /** Count of messages newer than my receipt that mention me. ≥ 0. */
  unreadMentionCount: number;
}

/**
 * The other person in a 1:1 DM, resolved server-side from the membership
 * rows. Deliberately carries NO presence/online field: presence is owned by
 * the socket layer (`usePresence`), and duplicating it into an HTTP DTO
 * would give the same state two owners and guarantee it goes stale.
 */
export interface DirectMessagePeerDto {
  /** null when the peer's User row was hard-deleted. */
  userId: string | null;
  /** Display name, or "Removed user" when the account is gone. */
  name: string;
  avatarUrl: string | null;
  /** Soft-deactivated account: history stays readable, composer disabled. */
  deactivated: boolean;
  /** True for the notes-to-self DM, which renders as "You". */
  isSelf: boolean;
}

export interface TeamDmListItemDto extends TeamChannelListItemDto {
  peer: DirectMessagePeerDto;
}

/**
 * A public channel as seen in the browser by someone who may not be in it.
 * METADATA ONLY — this shape must never carry `lastMessagePreview` or any
 * other message-derived field, because it's served to non-members.
 */
export interface TeamChannelBrowseItemDto {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  lastMessageAt: string;
  /** Whether the viewer is already a member (renders "Open" vs "Join"). */
  joined: boolean;
}

export interface TeamChannelBrowsePage {
  items: TeamChannelBrowseItemDto[];
  nextCursor: string | null;
}

export interface ChannelMessagesPage {
  items: TeamChannelMessageDto[];
  nextCursor: string | null;
}

/**
 * A slice of messages centered on an anchor message. Returned by the
 * `/messages/around` endpoint when a search result points at a message that
 * isn't in the user's currently-loaded set. `hasMoreBefore` / `hasMoreAfter`
 * drive subsequent paginate-up / paginate-down behavior in anchored mode.
 */
export interface ChannelMessagesAroundPage {
  items: TeamChannelMessageDto[];
  /** Whether more older messages exist before `items[0]`. */
  hasMoreBefore: boolean;
  /** Whether more newer messages exist after `items[items.length - 1]`. */
  hasMoreAfter: boolean;
  /** Cursor for the next paginate-up call (encoded `{createdAt, id}`). */
  beforeCursor: string | null;
  /** Cursor for the next paginate-down call (encoded `{createdAt, id}`). */
  afterCursor: string | null;
}

/**
 * Workspace-wide search hit. Like `TeamChannelMessageDto` but enriched with
 * `channelName` so the result row can render the channel context without a
 * separate channel lookup. `channelId` is already on the base DTO.
 */
export interface WorkspaceSearchHit {
  message: TeamChannelMessageDto;
  channelName: string;
}

export interface WorkspaceSearchPage {
  items: WorkspaceSearchHit[];
  nextCursor: string | null;
}

export interface ChannelPinDto {
  messageId: string;
  pinnedAt: string;
  pinnedById: string | null;
  pinnedByName: string | null;
  message: TeamChannelMessageDto;
}

/**
 * The 6 curated reaction emojis offered in the picker's QUICK ROW. The full
 * Unicode picker sits behind the "More reactions" button next to them (it
 * reuses the inbox's EmojiPopover), so this set is a shortcut, not a limit.
 * Shared between client and server (the POST route rejects emoji not in this
 * set ONLY if we ever decide to gate; for now any single-codepoint string is
 * accepted so manual paste still works).
 */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"] as const;
export type QuickReaction = (typeof QUICK_REACTIONS)[number];

export type { TeamChannelMessageDto, TeamChannelMediaDto } from "../socket/events";

/**
 * Channel name rules — lowercase, kebab-case, 1–32 chars, no leading-dash.
 * Same shape as a typical Slack channel slug so muscle memory transfers.
 * Trailing/leading whitespace is trimmed by the caller before calling this.
 */
const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
// `search`, `default`, `dms` and `browse` are reserved so a channel named
// e.g. "search" can't shadow the static route segments (`GET
// /api/team/channels/search`, `.../default`, `.../dms`, `.../browse`).
// Keep this in sync with the static segments in channels.controller.ts.
export const RESERVED_CHANNEL_NAMES: ReadonlySet<string> = new Set([
  "new",
  "settings",
  "create",
  "edit",
  "search",
  "default",
  "dm",
  "dms",
  "browse",
  "unread-count",
]);

export function isValidChannelName(name: string): boolean {
  if (!CHANNEL_NAME_PATTERN.test(name)) return false;
  if (RESERVED_CHANNEL_NAMES.has(name)) return false;
  // No double-dashes — keeps slugs scannable.
  if (name.includes("--")) return false;
  return true;
}

/** Soft-normalize a user-supplied name to the slug shape. */
export function normalizeChannelName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export const DEFAULT_CHANNEL_NAME = "general";
