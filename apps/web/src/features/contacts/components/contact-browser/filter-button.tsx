"use client";

import { ChevronDown } from "lucide-react";

import { cn } from "@ccp/shared/utils";

/**
 * Compact toolbar trigger for one filter dimension (Stage / Tags / More).
 * Lights up when its dimension is active and shows an optional count badge
 * (e.g. number of selected tags). Pair with {@link Popover} for the menu.
 */
export function FilterButton({
  label,
  active,
  open,
  count,
  onClick,
}: {
  label: string;
  active?: boolean;
  open?: boolean;
  /** Shown as a small badge when > 0. */
  count?: number;
  onClick: () => void;
}) {
  const lit = active || open;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors",
        lit
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
      {count ? (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground">
          {count}
        </span>
      ) : null}
      <ChevronDown
        className={cn("size-3.5 opacity-50 transition-transform", open && "rotate-180")}
      />
    </button>
  );
}
