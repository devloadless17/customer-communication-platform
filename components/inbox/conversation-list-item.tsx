"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { avatarGradient } from "@/lib/avatar-color";
import { cn, formatListTime, initials } from "@/lib/utils";
import type { Contact, Conversation, User } from "@/lib/types";

export function ConversationListItem({
  conversation,
  contact,
  assignedUser,
  active,
}: {
  conversation: Conversation;
  contact: Contact;
  assignedUser: User | null;
  active: boolean;
}) {
  const unread = conversation.unreadCount > 0;

  return (
    <div
      className={cn(
        "group relative flex cursor-pointer gap-3 rounded-lg px-2.5 py-2.5 transition-colors",
        active ? "bg-accent" : "hover:bg-accent/60",
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
          <span
            className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground"
            suppressHydrationWarning
          >
            {formatListTime(conversation.lastMessageAt)}
          </span>
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
          {unread && (
            <span className="ml-1 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold tabular-nums text-primary-foreground">
              {conversation.unreadCount}
            </span>
          )}
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
