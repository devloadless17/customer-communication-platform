"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { SmilePlus } from "lucide-react";

import { QUICK_REACTIONS } from "@ccp/shared/team-chat/types";
import { cn } from "@ccp/shared/utils";

// The full Unicode picker is ~400 lines plus its emoji tables — load it only
// when someone actually opens it, exactly as the inbox reply box does.
const EmojiPopover = dynamic(
  () =>
    import("@/features/inbox/components/reply-box/emoji-popover").then(
      (m) => m.EmojiPopover,
    ),
  { ssr: false },
);

/**
 * Reaction picker: a curated quick row (ack / agree / lol / huh / sad /
 * celebrate) plus the full Unicode picker behind "More reactions".
 *
 * The quick row stays because six one-click targets beat a search box for the
 * overwhelmingly common cases — it's a shortcut, not a limit.
 *
 * The full picker is the inbox's `EmojiPopover`, reused rather than rebuilt,
 * so search / categories / keyboard nav / recents behave identically on both
 * surfaces (recents are shared between them, which is desirable).
 */
export function ReactionPicker({
  onPick,
  align = "left",
}: {
  onPick: (emoji: string) => void;
  align?: "left" | "right";
}) {
  const [showFull, setShowFull] = useState(false);

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

      <div className="relative">
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9"
          aria-label="More reactions"
          title="More reactions"
          aria-expanded={showFull}
          onClick={() => setShowFull((v) => !v)}
        >
          <SmilePlus className="size-4" />
        </button>
        <EmojiPopover
          open={showFull}
          onClose={() => setShowFull(false)}
          onPick={(emoji) => {
            onPick(emoji);
            // Unlike the composer — where staying open for multi-insert is
            // the point — a reaction is a single act, so close after picking.
            setShowFull(false);
          }}
          // `left-auto` matters: left-0 and right-0 land in different
          // tailwind-merge groups, so right-0 alone loses to the base class.
          className={align === "left" ? "left-0" : "left-auto right-0"}
        />
      </div>
    </div>
  );
}
