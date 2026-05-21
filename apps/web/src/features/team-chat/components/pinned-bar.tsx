"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Pin, X } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { stripMentionMarkup } from "@ccp/shared/team-chat/mentions";
import { cn, initials } from "@ccp/shared/utils";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";

interface PinnedItem {
  messageId: string;
  pinnedAt: string;
  pinnedByName: string | null;
  message: TeamChannelMessageDto;
}

/**
 * Collapsible "Pinned" bar above the message thread. Collapsed by default
 * once a channel has more than 1 pin so it doesn't eat half the viewport
 * on long-pinned channels. Admins/owners get an inline X on each row to
 * unpin without having to scroll back to the original message.
 */
export function PinnedBar({
  pins,
  canPin = false,
  onUnpin,
}: {
  pins: PinnedItem[];
  /** Gate the row-level X button. Same `canPinMessage` check used by the
   *  bubble's 3-dot menu. */
  canPin?: boolean;
  /** Invoked when the row-level X is clicked. The workspace owns the
   *  optimistic-remove + DELETE + error reconciliation. */
  onUnpin?: (messageId: string) => void;
}) {
  const [open, setOpen] = useState(pins.length <= 1);
  if (pins.length === 0) return null;

  return (
    <div className="border-b border-border bg-amber-50/60 dark:bg-amber-950/10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2 text-xs font-medium transition-colors hover:bg-amber-100/50 dark:hover:bg-amber-900/10"
      >
        <Pin className="size-3.5 text-amber-600" />
        <span>
          {pins.length} pinned {pins.length === 1 ? "message" : "messages"}
        </span>
        <span className="ml-auto text-muted-foreground">
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 px-4 pb-2">
          {pins.map((p) => {
            const author = p.message.authorName ?? "Removed user";
            const preview = stripMentionMarkup(p.message.body) || (p.message.media ? "📎 Attachment" : "");
            return (
              <div
                key={p.messageId}
                className={cn(
                  "group flex items-start gap-2 rounded-md border border-amber-200/60 bg-background/80 px-2 py-1.5 text-xs",
                  "dark:border-amber-900/40",
                )}
              >
                <Avatar className="size-5 shrink-0">
                  <AvatarFallback seed={author} className="text-[9px]">{initials(author)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{author}</div>
                  <div className="truncate text-muted-foreground">{preview}</div>
                </div>
                {canPin && onUnpin && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnpin(p.messageId);
                    }}
                    className={cn(
                      "shrink-0 self-center rounded p-1 text-muted-foreground opacity-0 transition-opacity",
                      "hover:bg-amber-100 hover:text-foreground group-hover:opacity-100",
                      "focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40",
                      "dark:hover:bg-amber-900/30",
                    )}
                    aria-label="Unpin message"
                    title="Unpin"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
