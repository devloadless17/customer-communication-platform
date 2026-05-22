"use client";

import { memo } from "react";
import { Loader2 } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LocalTime } from "@/components/local-time";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { cn, initials } from "@ccp/shared/utils";
import type { Contact, Conversation, User } from "@ccp/shared/types";

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
}: {
  conversation: Conversation;
  contact: Contact;
  assignedUser: User | null;
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

  return (
    <div
      className={cn(
        "group relative flex cursor-pointer gap-3 rounded-lg px-2.5 py-2.5 transition-colors",
        active
          ? "bg-primary/10"
          : pending
            ? "bg-accent/50"
            : "hover:bg-accent/50",
      )}
    >
      {/* Selected-row left accent bar */}
      {active && (
        <span className="absolute left-0 top-1/2 h-7 w-0.5 -translate-y-1/2 rounded-r-full bg-primary" />
      )}

      {/* Avatar */}
      <Avatar className="mt-0.5 size-9 shrink-0">
        <AvatarFallback
          className="text-xs font-semibold text-white"
          style={{ backgroundImage: avatarGradient(contact.id) }}
        >
          {initials(contact.name)}
        </AvatarFallback>
      </Avatar>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* Row 1: name + timestamp */}
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "flex-1 truncate text-[13px] leading-snug",
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
              "shrink-0 text-[11px] tabular-nums",
              unread ? "text-primary font-medium" : "text-muted-foreground",
            )}
          />
        </div>

        {/* Row 2: message preview + unread badge */}
        <div className="flex items-center gap-1.5">
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-[12px] leading-snug",
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
              className="animate-badge-pop flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold tabular-nums text-primary-foreground"
            >
              {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
            </span>
          ) : null}
        </div>

        {/* Row 3: status chip + assignment */}
        <div className="flex items-center gap-1.5">
          {conversation.status === "pending" && (
            <span className="inline-flex h-[18px] items-center rounded-sm bg-amber-500/12 px-1.5 text-[10px] font-semibold tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
              pending
            </span>
          )}
          {conversation.status === "closed" && (
            <span className="inline-flex h-[18px] items-center rounded-sm bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              closed
            </span>
          )}
          {assignedUser ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Avatar className="size-3.5">
                <AvatarFallback
                  seed={assignedUser.id}
                  className="text-[7px] font-semibold"
                >
                  {initials(assignedUser.name)}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">{assignedUser.name.split(" ")[0]}</span>
            </span>
          ) : (
            <span className="text-[11px] italic text-muted-foreground/60">
              unassigned
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export const ConversationListItem = memo(
  ConversationListItemImpl,
  (prev, next) =>
    prev.active === next.active &&
    prev.pending === next.pending &&
    prev.assignedUser === next.assignedUser &&
    prev.contact === next.contact &&
    prev.conversation.id === next.conversation.id &&
    prev.conversation.lastMessageAt === next.conversation.lastMessageAt &&
    prev.conversation.lastMessagePreview === next.conversation.lastMessagePreview &&
    prev.conversation.unreadCount === next.conversation.unreadCount &&
    prev.conversation.status === next.conversation.status &&
    prev.conversation.assignedUserId === next.conversation.assignedUserId,
);
