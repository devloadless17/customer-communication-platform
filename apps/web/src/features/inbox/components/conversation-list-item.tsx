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
  const unread = conversation.unreadCount > 0;

  return (
    <div
      className={cn(
        "group relative flex cursor-pointer gap-3 rounded-lg px-2.5 py-2.5 transition-colors",
        active
          ? "bg-accent"
          : pending
            ? "bg-accent/60"
            : "hover:bg-accent/60",
      )}
    >
      {unread && !active && (
        <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r-full bg-primary" />
      )}
      <Avatar className="size-10">
        <AvatarFallback
          className="text-xs text-white"
          style={{ backgroundImage: avatarGradient(contact.id) }}
        >
          {initials(contact.name)}
        </AvatarFallback>
      </Avatar>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "truncate text-sm",
              unread ? "font-semibold text-foreground" : "font-medium text-foreground",
            )}
          >
            {contact.name}
          </span>
          <LocalTime
            iso={conversation.lastMessageAt}
            format="listTime"
            className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground"
          />
        </div>

        <div className="mt-0.5 flex items-center gap-2">
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              unread ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {conversation.lastMessagePreview}
          </p>
          {pending && !active ? (
            <Loader2
              className="ml-1 size-3 shrink-0 animate-spin text-muted-foreground"
              aria-label="Loading conversation"
            />
          ) : unread ? (
            <span className="ml-1 flex size-4.5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold tabular-nums text-primary-foreground">
              {conversation.unreadCount}
            </span>
          ) : null}
        </div>

        <div className="mt-1.5 flex items-center gap-1.5">
          {conversation.status === "pending" && (
            <span className="inline-flex h-4 items-center rounded bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              pending
            </span>
          )}
          {conversation.status === "closed" && (
            <span className="inline-flex h-4 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              closed
            </span>
          )}
          {assignedUser ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-secondary text-[8px] font-medium">
                {initials(assignedUser.name)}
              </span>
              {assignedUser.name.split(" ")[0]}
            </span>
          ) : (
            <span className="text-[11px] italic text-muted-foreground">unassigned</span>
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
