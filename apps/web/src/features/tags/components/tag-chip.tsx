"use client";

import { Tag as TagIcon, X } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import type { Tag } from "@ccp/shared/types";

/**
 * Colored tag chip. The dot-icon left of the label uses the tag's color
 * directly; the chip background is a tinted version of the same color.
 *
 * Three sizes (xs/sm/md) so the same chip lives nicely in dense table rows,
 * popovers, and detail panels.
 */
export function TagChip({
  tag,
  size = "sm",
  onRemove,
  onClick,
  className,
  selected,
}: {
  tag: Tag;
  size?: "xs" | "sm" | "md";
  onRemove?: () => void;
  onClick?: () => void;
  className?: string;
  /** Adds a subtle outline + slightly darker tint when used in pickers. */
  selected?: boolean;
}) {
  const colors = tagColorClasses(tag.color);
  const sizing =
    size === "xs"
      ? "h-5 px-1.5 text-[10px] gap-1"
      : size === "md"
        ? "h-7 px-2.5 text-xs gap-1.5"
        : "h-6 px-2 text-[11px] gap-1.5";
  return (
    <span
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-full border font-medium transition-colors",
        sizing,
        colors.chip,
        onClick && "cursor-pointer hover:brightness-110",
        selected && "ring-2 ring-offset-1 ring-offset-background",
        selected && colors.solid.replace("bg-", "ring-"),
        className,
      )}
    >
      <span className={cn("size-2 rounded-full", colors.solid)} />
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-1 inline-flex size-3.5 items-center justify-center rounded-full text-current/60 hover:bg-foreground/10 hover:text-current"
          aria-label={`Remove ${tag.name}`}
        >
          <X className="size-2.5" />
        </button>
      )}
    </span>
  );
}

/**
 * Placeholder chip for the contact row — clickable, opens the tag picker.
 * Visually subtle so untagged contacts don't shout.
 */
export function TagAddButton({
  onClick,
  size = "sm",
  className,
}: {
  onClick: () => void;
  size?: "xs" | "sm";
  className?: string;
}) {
  const sizing =
    size === "xs" ? "h-5 px-1.5 text-[10px]" : "h-6 px-2 text-[11px]";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-border bg-transparent font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground",
        sizing,
        className,
      )}
    >
      <TagIcon className="size-2.5" />
      Add tag
    </button>
  );
}
