import type { TeamChannelMessageDto } from "../socket/events";

/**
 * Public DTOs for the team-chat surface. Mirrors the socket event payloads
 * so the SSR responses (initial server-rendered slice) and the live socket
 * stream agree on the shape — no client-side normalization layer needed.
 */

export interface TeamChannelDto {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  lastMessagePreview: string;
}

export interface TeamChannelListItemDto extends TeamChannelDto {
  /** Cheap "is there anything new for me" via lastReadAt vs lastMessageAt. */
  unreadForMe: boolean;
  /** Count of messages newer than my receipt that mention me. ≥ 0. */
  unreadMentionCount: number;
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
 * The 6 curated reaction emojis offered in the picker's quick row. The full
 * picker is deferred — agents who want anything beyond these in v0 can
 * paste it as message text. Shared between client and server (the POST
 * route rejects emoji not in this set ONLY if we ever decide to gate; for
 * now any single-codepoint string is accepted so manual paste still works).
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
// `search` and `default` are reserved so a channel named "search" can't
// shadow the static route segments (`GET /api/team/channels/search`,
// `GET /api/team/channels/default`).
const RESERVED_NAMES = new Set([
  "new",
  "settings",
  "create",
  "edit",
  "search",
  "default",
]);

export function isValidChannelName(name: string): boolean {
  if (!CHANNEL_NAME_PATTERN.test(name)) return false;
  if (RESERVED_NAMES.has(name)) return false;
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
