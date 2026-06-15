"use client";

import { memo } from "react";
import { Loader2 } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LocalTime } from "@/components/local-time";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn, initials } from "@ccp/shared/utils";
import type { Contact, Conversation, Tag, User } from "@ccp/shared/types";

/**
 * One row in the inbox conversation list.
 *
 * Memoized — every `message:new` in the team room re-renders the parent list,
 * but only the touched row's `conversation` reference actually changes. Without
 * memo, every visible row's React tree rebuilds; with memo, only the moved /
 * mutated row re-renders. On a busy team this drops re-renders per inbound
 * message from ~30 (visible rows) to ~1.
 *
 * The comparator checks every prop that affects the visual output:
 * - identity refs for `assignedUser` and `contact` (they change as objects on
 *   teammate edits)
 * - scalar fields on `conversation` (timestamp / preview / unread / status)
 * - the boolean flags
 *
 * Anything not listed here is intentionally NOT compared: it doesn't drive
 * the render.
 */
function ConversationListItemImpl({
  conversation,
  contact,
  assignedUser,
  active,
  pending,
  tags,
  currentUserId,
}: {
  conversation: Conversation;
  contact: Contact;
  assignedUser: User | null;
  /** Team tag catalog — resolves the contact's tagIds to name + color chips
   *  on row 3. Stable reference (passed straight through from the shell). */
  tags: Tag[];
  /** The viewing agent's id — drives the "You" assignee emphasis. */
  currentUserId: string;
  /** This conversation is currently rendered in the workspace pane. */
  active: boolean;
  /** This conversation was just clicked but its data is still fetching.
   *  Adds a subtle visual cue so the click doesn't feel ignored. */
  pending: boolean;
}) {
  // Unread is TEAM-WIDE by design (collab inbox): the bold styling AND the
  // badge both read Conversation.unreadCount. When ANY member opens the thread,
  // markAsRead zeroes that counter and it clears for EVERYONE. There is no
  // per-agent read state for the inbox — "read" means read for all.
  const unread = conversation.unreadCount > 0;

  // Row 3 (status chip + assignment) only carries signal when there's a
  // pending/closed chip OR an assignee. The common open + unassigned case had
  // it spending a full line on the italic word "unassigned" — but the missing
  // assignee avatar already conveys "unassigned", so we drop the row entirely
  // there. The row's outer height stays a fixed h-20 (the virtualizer depends
  // on it); the text column just vertically-centres its 2 rows instead of 3.
  const hasStatusChip =
    conversation.status === "pending" || conversation.status === "closed";

  // Up to 2 contact tags surface on row 3 as a fast triage signal (VIP /
  // billing / bug). Resolved against the team catalog for name + color;
  // tagIds with no catalog match (a just-deleted tag) are dropped. Stays on
  // the EXISTING third row — no new line — so the fixed h-20 row height (which
  // the virtualizer depends on) is unchanged.
  const resolvedTags =
    contact.tagIds && contact.tagIds.length > 0 && tags.length > 0
      ? contact.tagIds
          .map((id) => tags.find((t) => t.id === id))
          .filter((t): t is Tag => Boolean(t))
      : [];
  const shownTags = resolvedTags.slice(0, 2);
  const extraTags = resolvedTags.length - shownTags.length;
  const hasTags = shownTags.length > 0;
  const assignedToMe = assignedUser?.id === currentUserId;

  const showMeta = hasStatusChip || assignedUser !== null || hasTags;

  return (
    <div
      className={cn(
        // FIXED height (h-20 = 80px) — must equal ROW_HEIGHT in
        // conversation-list.tsx. The list is virtualized; if the row's real
        // height differs from the virtualizer's estimate, every row repositions
        // on hydration (the visible "bounce/settle" on hard refresh). The three
        // stacked rows all single-line-truncate, so 80px fits them with a couple
        // px to spare and the height never varies → estimate === measured →
        // zero reposition. overflow-hidden guards a future taller variant.
        "group relative flex h-20 cursor-pointer gap-3 overflow-hidden rounded-lg px-2.5 py-2.5 transition-colors",
        active
          ? "bg-primary/10"
          : pending
            ? "bg-accent/50"
            : "hover:bg-accent/50",
      )}
    >
      {/* Left rail. Two distinct cues share the same 2px gutter:
          - ACTIVE (selected) → `bg-primary` (the app green) — the existing
            "this row is open in the workspace" accent.
          - UNREAD but not active → `bg-info-fg` (saturated blue, a different
            hue from the green active bar so the two never read as the same
            state) — makes unread detectable in a fast peripheral scan without
            relying on the badge/bold-text alone.
          Active wins when a row is both: a row you're looking at is, by
          definition, about to be read, so the "open" cue is the useful one. */}
      {active ? (
        <span className="absolute left-0 top-1/2 h-7 w-0.5 -translate-y-1/2 rounded-r-full bg-primary" />
      ) : unread ? (
        <span className="absolute left-0 top-1/2 h-7 w-0.5 -translate-y-1/2 rounded-r-full bg-info-fg" />
      ) : null}

      {/* Avatar */}
      <Avatar className="mt-0.5 size-9 shrink-0">
        <AvatarFallback
          className="text-xs font-semibold text-white"
          style={{ backgroundImage: avatarGradient(contact.id) }}
        >
          {initials(contact.name)}
        </AvatarFallback>
      </Avatar>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        {/* Row 1: name + timestamp */}
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "flex-1 truncate text-sm leading-snug",
              unread
                ? "font-semibold text-foreground"
                : "font-medium text-foreground/90",
            )}
          >
            {contact.name}
          </span>
          <LocalTime
            iso={conversation.lastMessageAt}
            format="listTime"
            className={cn(
              "shrink-0 text-2xs tabular-nums",
              unread ? "text-primary font-medium" : "text-muted-foreground",
            )}
          />
        </div>

        {/* Row 2: message preview + unread badge */}
        <div className="flex items-center gap-1.5">
          <p
            // dir="auto" so an Arabic/Hebrew preview reads right-aligned with
            // correct base direction (matches the thread bubble + WhatsApp Web).
            dir="auto"
            className={cn(
              "min-w-0 flex-1 truncate text-xs leading-snug",
              unread ? "text-foreground/80" : "text-muted-foreground",
            )}
          >
            {conversation.lastMessagePreview}
          </p>
          {pending && !active ? (
            <Loader2
              className="size-3 shrink-0 animate-spin text-muted-foreground"
              aria-label="Loading conversation"
            />
          ) : unread ? (
            /* key changes only when badge transitions 0→N, triggering the
               mount animation. Subsequent count increases don't re-mount. */
            <span
              key="badge-visible"
              className="animate-badge-pop flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-3xs font-bold tabular-nums text-primary-foreground"
            >
              {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
            </span>
          ) : null}
        </div>

        {/* Row 3: status chip + assignment — rendered ONLY when it carries
            signal (a pending/closed chip or an assignee). For the common
            open + unassigned chat it's omitted entirely: the missing assignee
            avatar already says "unassigned", so the line was pure noise. */}
        {showMeta && (
          <div className="flex items-center gap-1.5">
            {conversation.status === "pending" && (
              <span className="inline-flex h-4.5 shrink-0 items-center rounded-sm bg-warning-bg px-1.5 text-3xs font-semibold tracking-wide text-warning-fg">
                pending
              </span>
            )}
            {conversation.status === "closed" && (
              <span className="inline-flex h-4.5 shrink-0 items-center rounded-sm bg-muted px-1.5 text-3xs font-medium text-muted-foreground">
                closed
              </span>
            )}
            {/* Tag lane doubles as the flex spacer so the assignee pins to the
                right edge — a stable column the eye can scan down. */}
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {shownTags.map((t) => (
                <span
                  key={t.id}
                  className={cn(
                    "inline-flex h-4 max-w-24 shrink-0 items-center truncate rounded-sm border px-1 text-3xs font-medium",
                    tagColorClasses(t.color).chip,
                  )}
                >
                  {t.name}
                </span>
              ))}
              {extraTags > 0 && (
                <span className="shrink-0 text-3xs text-muted-foreground">
                  +{extraTags}
                </span>
              )}
            </div>
            {assignedUser && (
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 text-2xs",
                  assignedToMe
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <Avatar className="size-3.5">
                  <AvatarFallback
                    seed={assignedUser.id}
                    className="text-[7px] font-semibold"
                  >
                    {initials(assignedUser.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate">
                  {assignedToMe ? "You" : assignedUser.name.split(" ")[0]}
                </span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const ConversationListItem = memo(
  ConversationListItemImpl,
  (prev, next) =>
    prev.active === next.active &&
    prev.pending === next.pending &&
    prev.tags === next.tags &&
    prev.currentUserId === next.currentUserId &&
    prev.assignedUser === next.assignedUser &&
    prev.contact === next.contact &&
    prev.conversation.id === next.conversation.id &&
    prev.conversation.lastMessageAt === next.conversation.lastMessageAt &&
    prev.conversation.lastMessagePreview === next.conversation.lastMessagePreview &&
    prev.conversation.unreadCount === next.conversation.unreadCount &&
    prev.conversation.status === next.conversation.status &&
    prev.conversation.assignedUserId === next.conversation.assignedUserId,
);
