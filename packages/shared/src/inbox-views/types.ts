/**
 * Saved inbox views — a named, reusable filter over the conversation list.
 *
 * The six built-in presets (Active / All / Mine / Unassigned / Closed /
 * Flagged) answer "what is the state of this thread". A view answers "which
 * slice of work is MINE to look at" — "Support · unassigned · WhatsApp",
 * "VIP escalations", "Arabic-speaking leads in Qualified". Respond.io calls
 * these Team Inbox / Custom Inbox.
 *
 * Framework-agnostic wire shapes only. The DB model lives in
 * prisma/schema.prisma; the WHERE builder in
 * apps/api/src/lib/inbox-views/where.ts; the CRUD in
 * apps/api/src/inbox-views.
 *
 * DESIGN NOTE — why a JSON filter document and not columns:
 * every field here is optional and orthogonal, and the set will grow (ticket
 * status, SLA breach, custom fields). As columns that is a migration per
 * filter and a sparse table; as a validated JSON document it is one Zod schema
 * and one where-builder. The tradeoff accepted: the DB cannot enforce that a
 * referenced tag/stage/user still exists, so the builder RESOLVES dangling ids
 * at read time (see `INBOX_VIEW_DANGLING_POLICY` below) rather than trusting
 * the document.
 */

import type { Channel, ContactFieldFilter, ConversationStatus } from "../types";

/**
 * Who can see a view.
 *  - `personal` — only its creator. The default: an experiment shouldn't
 *                 clutter everyone's sidebar.
 *  - `shared`   — every member of the workspace. Creating/editing one is
 *                 gated by the `inboxViews:manage` capability, because it
 *                 changes what the whole team sees.
 *
 * There is deliberately no "specific teammates" visibility. That is a third
 * membership model to keep in sync with `Team` members and
 * `WorkspaceMember`, and the same result is reached by a shared view whose
 * assignee filter names those people.
 */
export type InboxViewVisibility = "personal" | "shared";

export const INBOX_VIEW_VISIBILITIES: readonly InboxViewVisibility[] = [
  "personal",
  "shared",
] as const;

/**
 * How a view selects on assignment.
 *
 * `me` is resolved against the VIEWER, not the author — that is the whole
 * point of a shared "My open work" view: it means something different, and
 * correct, for each teammate. It also means such a view's counts can never be
 * memoized across agents (see `inboxViewIsViewerScoped`).
 */
export type InboxViewAssignee =
  | { kind: "anyone" }
  | { kind: "me" }
  | { kind: "unassigned" }
  /** Named teammates. Empty array is treated as "anyone" by the builder. */
  | { kind: "users"; userIds: string[] };

/** `any` = at least one of the tags; `all` = every one of them. */
export type InboxViewTagMatch = "any" | "all";

/**
 * The filter document. Every present field is ANDed; an absent (or empty)
 * field is "no opinion". `{}` therefore means "every conversation in the
 * workspace", which is a legitimate view (it is what "All" is).
 */
export interface InboxViewFilters {
  /** Conversation status. Absent/empty = any status, closed included. */
  statuses?: ConversationStatus[];
  assignee?: InboxViewAssignee;
  /** Channel the thread arrived on. Absent/empty = any channel. */
  channels?: Channel[];
  /**
   * The channel ACCOUNT the thread is on — which WhatsApp number, Facebook Page
   * or Instagram handle. `ChannelConnection.id`s. Absent/empty = any account.
   *
   * Distinct from `channels`, and both are useful: "WhatsApp" is the medium,
   * "the Sales number" is one of possibly several inboxes inside it. A workspace
   * running Sales and Support on two numbers wants a saved view per number far
   * more than it wants one per channel.
   *
   * A conversation with no account (legacy rows, or an account since
   * disconnected) can never satisfy this filter — the same exclude-on-absent
   * rule `channels` uses, and for the same reason: admitting it would show a
   * thread under a number it demonstrably is not on.
   */
  channelAccountIds?: string[];
  /** Contact lifecycle stage. Absent/empty = any stage. */
  stageIds?: string[];
  /** Contact tags. */
  tagIds?: string[];
  tagMatch?: InboxViewTagMatch;
  /**
   * Select-type custom-field predicates — the stage-like dimensions
   * (`ContactFieldDefinition.type === "select"`). Within one entry the
   * optionIds are OR'd ("Source is Ad or Referral"); entries are ANDed with
   * each other and with every other filter. Deliberately select-only: text
   * fields have no enumerable options to chip, and a substring predicate is a
   * different (unindexed) query shape — a discriminated variant can be added
   * later if asked for. Dangling keys/option ids follow
   * `INBOX_VIEW_DANGLING_POLICY` like stages/tags.
   */
  fields?: ContactFieldFilter[];
  /** Only threads carrying at least one UNRESOLVED message flag. */
  hasOpenFlags?: boolean;
  /** Only threads with unread inbound messages. */
  unreadOnly?: boolean;
}

/**
 * A saved view as it crosses the wire.
 *
 * `isEditable` is computed per-viewer by the service rather than derived on
 * the client: the rule ("mine, or shared-and-I-can-manage") depends on
 * capabilities the client would otherwise have to re-derive, and getting it
 * wrong renders an edit button that 403s.
 */
export interface InboxView {
  id: string;
  workspaceId: string;
  name: string;
  /** Named color slot from TAG_COLORS — never a hex, so no dynamic classes. */
  color: string;
  /** Key from `INBOX_VIEW_ICONS`. Validated server-side against that list. */
  icon: string;
  visibility: InboxViewVisibility;
  createdById: string;
  createdByName?: string | null;
  /** What the author SAVED — the document the builder edits. */
  filters: InboxViewFilters;
  /**
   * The same document with dangling ids dropped (`INBOX_VIEW_DANGLING_POLICY`)
   * — what anything EVALUATING the view must read, including
   * `matchesInboxViewFilters`. Present on the LIST endpoints only, where the
   * server resolves the whole visible set in one batch; absent on the
   * single-view create/update/get responses, whose callers are editing rather
   * than matching. Read it as `resolvedFilters ?? filters`.
   *
   * Two documents rather than one because they answer different questions: a
   * builder that edited the resolved one would silently discard the author's
   * criteria the moment a tag was deleted, while a matcher that read the stored
   * one splices rows out of a view the server's own refetch keeps them in.
   */
  resolvedFilters?: InboxViewFilters;
  position: number;
  isEditable: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Icon allowlist. A view stores a KEY, and the sidebar maps it to a lucide
 * component from a fixed table — so a stored value can never inject an
 * arbitrary import, and an unknown key degrades to the default instead of
 * crashing the sidebar.
 */
export const INBOX_VIEW_ICONS = [
  "inbox",
  "star",
  "flame",
  "zap",
  "users",
  "user",
  "filter",
  "bookmark",
  "target",
  "shield",
  "clock",
  "circle-alert",
  "message-circle",
  "shopping-cart",
  "life-buoy",
  "trending-up",
] as const;

export type InboxViewIcon = (typeof INBOX_VIEW_ICONS)[number];

export const DEFAULT_INBOX_VIEW_ICON: InboxViewIcon = "filter";

export function isInboxViewIcon(v: string): v is InboxViewIcon {
  return (INBOX_VIEW_ICONS as readonly string[]).includes(v);
}

/**
 * Per-workspace cap.
 *
 * Not an arbitrary number: the sidebar counts endpoint runs up to two COUNT
 * queries per view, so this is the real bound on that fan-out. 30 shared +
 * 30 personal is far past what any team navigates by eye, and well inside
 * what one round of counts can serve. See `apps/api/src/inbox-views`.
 */
export const MAX_INBOX_VIEWS_PER_SCOPE = 30;

export const INBOX_VIEW_NAME_MAX = 60;

/**
 * Does evaluating this view depend on WHO is looking?
 *
 * Load-bearing for counts: a view that doesn't mention `me` produces the same
 * number for every agent, so one query serves the whole team (the same insight
 * that makes `ConversationsService.teamCounts` affordable). A view that DOES
 * must be counted per viewer, and must never be served from a shared cache.
 */
export function inboxViewIsViewerScoped(filters: InboxViewFilters): boolean {
  return filters.assignee?.kind === "me";
}

/**
 * Dangling-reference policy, stated once so both the builder and the reader
 * agree: a filter referencing a deleted tag / stage / user is DROPPED from
 * that field, and if dropping empties the field the field is treated as
 * absent ("no opinion").
 *
 * The alternative — matching nothing — silently empties a view when an admin
 * deletes one tag of five, and reads as "the inbox is broken". Dropping
 * widens the view instead, which is visible and recoverable.
 */
export const INBOX_VIEW_DANGLING_POLICY = "drop" as const;

/**
 * The fields a conversation row must expose for `matchesInboxViewFilters`.
 * A structural subset of `ConversationWithRefs` rather than the type itself,
 * so this file stays free of app-shaped dependencies.
 */
export interface InboxViewMatchTarget {
  status: ConversationStatus;
  /** Absent on rows built before the column existed — see `Conversation.channel`. */
  channel?: string | null;
  /**
   * Which channel ACCOUNT the thread is on. Absent on lean construction sites
   * that don't select it, and null on a thread never bound to one — both mean
   * "cannot satisfy an account filter", same rule as `channel`.
   */
  channelConnectionId?: string | null;
  assignedUserId: string | null;
  unreadCount?: number | null;
  openFlagCount?: number | null;
  contact: {
    stageId?: string | null;
    /**
     * `Contact.tagIds` — populated only by routes that opt into the JOIN, so
     * it is legitimately `undefined` on some rows. The matcher treats that as
     * "cannot decide" and excludes; see the note there.
     */
    tagIds?: string[] | null;
    /**
     * `Contact.customFields` (key → stored value; option ID for select
     * fields). `undefined` on rows from routes that don't select it — the
     * matcher treats that as "cannot decide" and excludes, same as `tagIds`.
     */
    customFields?: Record<string, string> | null;
  };
}

/**
 * Does this already-loaded conversation belong in this view?
 *
 * MUST MIRROR `inboxViewWhereClauses` in apps/api/src/lib/inbox-views/where.ts.
 * The inbox uses it to decide, without a refetch, whether a row that just
 * changed (assigned, closed, tagged) should splice into or drop out of the
 * visible list. If the two disagree, a row appears optimistically and then
 * vanishes on the next server page — the "flickering row" class of bug.
 *
 * Kept here, next to the type it interprets, so the mirror is one scroll away
 * from the contract rather than in another package.
 */
export function matchesInboxViewFilters(
  filters: InboxViewFilters,
  viewerUserId: string,
  row: InboxViewMatchTarget,
): boolean {
  if (filters.statuses?.length && !filters.statuses.includes(row.status)) return false;

  const assignee = filters.assignee;
  if (assignee && assignee.kind !== "anyone") {
    if (assignee.kind === "unassigned" && row.assignedUserId !== null) return false;
    if (assignee.kind === "me" && row.assignedUserId !== viewerUserId) return false;
    if (
      assignee.kind === "users" &&
      assignee.userIds.length > 0 &&
      !(row.assignedUserId && assignee.userIds.includes(row.assignedUserId))
    ) {
      return false;
    }
  }

  if (filters.channels?.length) {
    // An absent channel cannot satisfy a channel filter. Excluding is the safe
    // direction: the row reappears on the next server page if it really
    // belongs, whereas admitting it shows a WhatsApp thread under an
    // Instagram-only view until something forces a refetch.
    if (!row.channel || !filters.channels.includes(row.channel as Channel)) return false;
  }

  if (filters.channelAccountIds?.length) {
    // Same exclude-on-absent rule as `channels` above.
    if (
      !row.channelConnectionId ||
      !filters.channelAccountIds.includes(row.channelConnectionId)
    ) {
      return false;
    }
  }

  if (filters.stageIds?.length) {
    if (!row.contact.stageId || !filters.stageIds.includes(row.contact.stageId)) return false;
  }

  if (filters.tagIds?.length) {
    // `tagIds` undefined = this row was built by a route that skips the tag
    // JOIN, so we genuinely don't know. Same call as the channel case above.
    const rowTags = new Set(row.contact.tagIds ?? []);
    const ok =
      filters.tagMatch === "all"
        ? filters.tagIds.every((id) => rowTags.has(id))
        : filters.tagIds.some((id) => rowTags.has(id));
    if (!ok) return false;
  }

  if (filters.fields?.length) {
    // `customFields` undefined = built by a route that skips the column —
    // "cannot decide", exclude (same rule as tagIds above).
    const cf = row.contact.customFields;
    for (const f of filters.fields) {
      if (f.optionIds.length === 0) continue;
      const stored = cf?.[f.key];
      if (!stored || !f.optionIds.includes(stored)) return false;
    }
  }

  if (filters.hasOpenFlags && !((row.openFlagCount ?? 0) > 0)) return false;
  if (filters.unreadOnly && !((row.unreadCount ?? 0) > 0)) return false;

  return true;
}

/**
 * Human summary of a filter document, e.g. "Open · Unassigned · WhatsApp".
 *
 * Lives here rather than in the web app because both the view list and the
 * inbox header render it, and a second copy would drift. Ids are resolved
 * through the optional lookup maps; an unresolved id falls back to a count
 * ("2 tags") rather than printing a cuid at the user.
 */
export function summarizeInboxViewFilters(
  filters: InboxViewFilters,
  lookup?: {
    stageNames?: Record<string, string>;
    tagNames?: Record<string, string>;
    userNames?: Record<string, string>;
    channelLabels?: Record<string, string>;
    /** ChannelConnection id → display name ("Sales line", "+961 70 …"). */
    accountNames?: Record<string, string>;
    /** ContactFieldDefinition.key → label ("source" → "Source"). */
    fieldLabels?: Record<string, string>;
    /** ContactFieldOption id → name. */
    optionNames?: Record<string, string>;
  },
): string {
  const parts: string[] = [];

  if (filters.statuses?.length) {
    parts.push(filters.statuses.map(titleCase).join(" / "));
  }

  const assignee = filters.assignee;
  if (assignee && assignee.kind !== "anyone") {
    if (assignee.kind === "me") parts.push("Assigned to me");
    else if (assignee.kind === "unassigned") parts.push("Unassigned");
    else if (assignee.userIds.length) {
      parts.push(namesOrCount(assignee.userIds, lookup?.userNames, "teammate"));
    }
  }

  if (filters.channels?.length) {
    parts.push(
      filters.channels
        .map((c) => lookup?.channelLabels?.[c] ?? titleCase(c))
        .join(", "),
    );
  }

  if (filters.channelAccountIds?.length) {
    parts.push(namesOrCount(filters.channelAccountIds, lookup?.accountNames, "account"));
  }

  if (filters.stageIds?.length) {
    parts.push(namesOrCount(filters.stageIds, lookup?.stageNames, "stage"));
  }

  if (filters.tagIds?.length) {
    const joined = namesOrCount(filters.tagIds, lookup?.tagNames, "tag");
    parts.push(filters.tagMatch === "all" ? `${joined} (all)` : joined);
  }

  if (filters.fields?.length) {
    for (const f of filters.fields) {
      if (!f.optionIds.length) continue;
      const label = lookup?.fieldLabels?.[f.key];
      const values = namesOrCount(f.optionIds, lookup?.optionNames, "option");
      parts.push(label ? `${label}: ${values}` : values);
    }
  }

  if (filters.hasOpenFlags) parts.push("Flagged");
  if (filters.unreadOnly) parts.push("Unread");

  return parts.length ? parts.join(" · ") : "All conversations";
}

function namesOrCount(
  ids: string[],
  names: Record<string, string> | undefined,
  noun: string,
): string {
  const resolved = ids.map((id) => names?.[id]).filter((n): n is string => !!n);
  // Only print names when we resolved ALL of them — a partial list reads as
  // the complete filter and quietly misrepresents what the view does.
  if (resolved.length === ids.length && resolved.length <= 3) {
    return resolved.join(", ");
  }
  return `${ids.length} ${noun}${ids.length === 1 ? "" : "s"}`;
}

function titleCase(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1);
}
