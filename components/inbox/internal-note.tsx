"use client";

import { StickyNote } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { formatMessageTime, initials } from "@/lib/utils";
import type { InternalNote, User } from "@/lib/types";

export function InternalNote({ note, author }: { note: InternalNote; author: User }) {
  return (
    <div className="my-1 flex w-full justify-center">
      <div className="w-full max-w-2xl rounded-lg border border-note-border bg-note-bg px-3.5 py-2.5 text-note-fg">
        <div className="mb-1 flex items-center gap-2">
          <StickyNote className="size-3.5" />
          <span className="text-[11px] font-semibold uppercase tracking-wider">Internal note</span>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] opacity-80">
            <Avatar className="size-4">
              <AvatarFallback className="text-[8px]">{initials(author.name)}</AvatarFallback>
            </Avatar>
            <span>{author.name}</span>
            <span className="opacity-60">·</span>
            <span suppressHydrationWarning>{formatMessageTime(note.timestamp)}</span>
          </span>
        </div>
        <p className="text-sm leading-relaxed">{note.body}</p>
      </div>
    </div>
  );
}
