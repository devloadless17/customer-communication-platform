"use client";

import { useMemo } from "react";
import { StickyNote } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import type { InternalNote, User } from "@ccp/shared/types";

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
      <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
        <StickyNote className="size-6 opacity-40" />
        <div>No internal notes in this conversation yet.</div>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {sorted.map((n) => {
        const author = n.authorUserId ? memberById.get(n.authorUserId) : null;
        return (
          <li
            key={n.id}
            className="rounded-md border border-note-border bg-note-bg p-3 text-note-fg"
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium opacity-80">
                {author?.name ?? "Removed user"}
              </span>
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("ccp:jump-to-note", {
                      detail: { conversationId, noteId: n.id },
                    }),
                  )
                }
                className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10"
                title="Jump to this note in the chat"
              >
                Jump
              </button>
            </div>
            <p className="whitespace-pre-wrap wrap-break-word text-sm">
              {n.body}
            </p>
            <div className="mt-1.5 text-2xs opacity-70">
              <LocalTime iso={n.timestamp} format="listTime" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
