"use client";

import { memo } from "react";
import { Trash2 } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LocalTime } from "@/components/local-time";
import { initials } from "@ccp/shared/utils";
import type { InternalNote as InternalNoteType, User } from "@ccp/shared/types";

function InternalNoteImpl({
  note,
  author,
  onDelete,
}: {
  note: InternalNoteType;
  author: User;
  /** Optional hover-action: pass to expose a delete button on the note. */
  onDelete?: (noteId: string) => void;
}) {
  return (
    <div className="group my-1 flex w-full justify-center">
      {/* Content-sized (not full-width) so a short note is a small, neat box;
          grows up to max-w-2xl for longer notes. */}
      <div className="flex items-start gap-1.5">
        <div className="w-fit min-w-[220px] max-w-2xl rounded-lg border border-note-border bg-note-bg px-3 py-2 text-note-fg">
          {/* No "Internal note" label — the beige color is enough to read it as
              a note. Author + time sit at the top-RIGHT, signature-style. */}
          <div className="mb-0.5 flex items-center justify-end gap-1.5 text-[11px] opacity-80">
            <Avatar className="size-4">
              <AvatarFallback seed={author.id} className="text-[8px]">{initials(author.name)}</AvatarFallback>
            </Avatar>
            <span className="font-medium">{author.name}</span>
            <span className="opacity-60">·</span>
            <LocalTime iso={note.timestamp} format="messageTime" />
          </div>
          <p dir="auto" className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed">{note.body}</p>
        </div>
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(note.id)}
            title="Delete this note"
            className="mt-0.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus:opacity-100"
            aria-label="Delete note"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// Same pattern as MessageBubble — the parent re-renders on every message:new
// but note rows preserve identity unless the note itself was touched, so memo
// makes that work for free.
export const InternalNote = memo(InternalNoteImpl);
