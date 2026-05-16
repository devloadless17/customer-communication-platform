"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Pin } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { stripMentionMarkup } from "@/lib/team-chat/mentions";
import { cn, initials } from "@/lib/utils";
import type { TeamChannelMessageDto } from "@/lib/team-chat/types";

interface PinnedItem {
  messageId: string;
  pinnedAt: string;
  pinnedByName: string | null;
  message: TeamChannelMessageDto;
}

/**
 * Collapsible "Pinned" bar above the message thread. Collapsed by default
 * once a channel has more than 1 pin so it doesn't eat half the viewport
 * on long-pinned channels.
 */
export function PinnedBar({ pins }: { pins: PinnedItem[] }) {
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
                  "flex items-start gap-2 rounded-md border border-amber-200/60 bg-background/80 px-2 py-1.5 text-xs",
                  "dark:border-amber-900/40",
                )}
              >
                <Avatar className="size-5 shrink-0">
                  <AvatarFallback className="text-[9px]">{initials(author)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{author}</div>
                  <div className="truncate text-muted-foreground">{preview}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
