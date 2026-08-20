"use client";

import { useMemo } from "react";
import { CornerUpRight, StickyNote } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LocalTime } from "@/components/local-time";
import { initials } from "@ccp/shared/utils";
import type { InternalNote, User } from "@ccp/shared/types";
import { unknownAuthor } from "../message-thread/utils";

/**
 * The conversation's internal notes, newest first.
 *
 * Lives in its OWN panel tab rather than as a chip inside the attachment
 * gallery. A note is not a file — filing it under "Files" was a category
 * error that also buried it two clicks deep. The gallery's chips now mean
 * exactly one thing: what KIND of attachment.
 */
export function NotesPanel({
  notes,
  teamMembers,
  conversationId,
}: {
  notes: InternalNote[];
  teamMembers: User[];
  conversationId: string;
}) {
  const memberById = useMemo(
    () => new Map(teamMembers.map((u) => [u.id, u])),
    [teamMembers],
  );
  const sorted = useMemo(
    () => [...notes].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
    [notes],
  );
  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <StickyNote className="size-5 text-muted-foreground/50" />
        <p className="text-sm font-medium">No internal notes yet</p>
        <p className="text-xs text-muted-foreground">
          Switch the reply box to Note to leave context only your team can see.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5 p-3">
      {sorted.map((n) => {
        // Same resolution as the thread's note card. These two disagreed —
        // the thread said one thing and this panel said "Removed user" for the
        // very same note — because each had its own fallback.
        const author =
          (n.authorUserId ? memberById.get(n.authorUserId) : null) ??
          unknownAuthor(n.authorUserId ?? null);
        return (
          <li key={n.id}>
            {/* The whole card jumps — same affordance as a flag row, so the
                panel behaves one way rather than hiding the action behind a
                single word in the corner. */}
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("ccp:jump-to-note", {
                    detail: { conversationId, noteId: n.id },
                  }),
                )
              }
              title="Jump to this note in the chat"
              className="group block w-full rounded-lg border border-note-border/70 border-l-2 border-l-note-border bg-note-bg/50 px-3 py-2.5 text-left text-note-fg transition-colors hover:border-note-border hover:bg-note-bg"
            >
              {/* Author + time on ONE line, avatar-anchored — the identity of a
                  note is who wrote it and when, so they read as a single fact
                  instead of two stray fragments top and bottom. */}
              <div className="flex items-center gap-1.5 text-2xs">
                <Avatar className="size-4 shrink-0">
                  {author?.avatarUrl ? (
                    <AvatarImage src={author.avatarUrl} alt="" />
                  ) : null}
                  <AvatarFallback seed={author?.id ?? n.id} className="text-4xs">
                    {initials(author.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate font-medium">
                  {author.name}
                </span>
                <span className="opacity-50">·</span>
                <span className="shrink-0 opacity-70">
                  <LocalTime iso={n.timestamp} format="listTime" />
                </span>
                <CornerUpRight className="ml-auto size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70 pointer-coarse:opacity-50" />
              </div>
              <p
                dir="auto"
                className="mt-1 line-clamp-6 whitespace-pre-wrap wrap-break-word text-sm leading-relaxed"
              >
                {n.body}
              </p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
