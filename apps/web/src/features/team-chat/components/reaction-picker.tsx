"use client";

import { SmilePlus } from "lucide-react";

import { QUICK_REACTIONS } from "@ccp/shared/team-chat/types";
import { cn } from "@ccp/shared/utils";

/**
 * Curated quick-row reaction picker. We intentionally don't ship a full
 * Unicode picker in v0 — six emoji cover the dominant cases (ack / agree
 * / lol / huh / sad / celebrate), and the "Add reaction" button gives us
 * a slot to drop a fuller picker in later without changing the bubble
 * hover UI.
 */
export function ReactionPicker({
  onPick,
  align = "left",
}: {
  onPick: (emoji: string) => void;
  align?: "left" | "right";
}) {
  return (
    <div
      className={cn(
        "absolute z-10 flex items-center gap-0.5 rounded-full border border-border bg-popover px-1 py-1 shadow-lg",
        align === "left" ? "left-0" : "right-0",
      )}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="flex size-7 items-center justify-center rounded-full text-base transition-colors hover:bg-accent pointer-coarse:size-9"
          onClick={() => onPick(emoji)}
          aria-label={`React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9"
        aria-label="More reactions"
        title="More reactions — full picker coming soon"
        onClick={(e) => {
          e.preventDefault();
        }}
      >
        <SmilePlus className="size-4" />
      </button>
    </div>
  );
}
