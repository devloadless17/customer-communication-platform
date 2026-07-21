"use client";

import { TAG_COLORS, type TagColor } from "@ccp/shared/types";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn } from "@ccp/shared/utils";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./dropdown-menu";

/**
 * Colour picker collapsed to a single swatch.
 *
 * Every settings list that owns a colour — tags, message flags, stages —
 * rendered the whole nine-swatch palette inline on EVERY row, permanently. One
 * row looks fine; twenty rows is 180 coloured dots competing with the names
 * they belong to, and the row stops reading as "● Complaint — the customer is
 * unhappy" and starts reading as a paint chart.
 *
 * Collapsing to the current colour keeps the row scannable and puts the
 * palette one click away, which is the right trade for something changed once
 * and then left alone for months.
 *
 * Keyboard + screen-reader parity comes from the underlying menu: the trigger
 * is a real button with an accessible name, and each swatch announces its
 * colour rather than relying on the colour alone (the "colour is not the only
 * indicator" rule — the selected one also carries a ring and its name is in
 * the accessible label).
 */
export function ColorSwatchPicker({
  selected,
  onChange,
  disabled = false,
  label = "colour",
}: {
  selected: TagColor;
  onChange: (color: TagColor) => void;
  disabled?: boolean;
  /** Names the thing being coloured, e.g. `colour for "Complaint"`. */
  label?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Change ${label} — currently ${selected}`}
          title={`Change ${label}`}
          className={cn(
            // 32px hit area around a 16px dot: the dot alone was well under the
            // 44px touch-target guidance and impossible to hit on mobile.
            "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md",
            "transition-colors hover:bg-accent",
            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-foreground/20",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <span
            className={cn(
              "size-4 rounded-full ring-1 ring-border",
              tagColorClasses(selected).solid,
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-5 gap-1.5">
          {TAG_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              aria-label={c}
              aria-pressed={selected === c}
              title={c}
              className={cn(
                "size-7 cursor-pointer rounded-md transition-colors hover:bg-accent",
                "flex items-center justify-center",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-foreground/20",
              )}
            >
              <span
                className={cn(
                  "size-4 rounded-full ring-1 ring-border",
                  tagColorClasses(c).solid,
                  selected === c &&
                    "ring-2 ring-foreground/60 ring-offset-1 ring-offset-popover",
                )}
              />
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
