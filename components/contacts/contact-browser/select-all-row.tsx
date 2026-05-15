"use client";

import type { ContactListItem } from "@/lib/types";

/**
 * "Select all visible" header bar shared by the contacts page and the
 * `ContactBrowser` picker. Each caller decides what "select all" means
 * (additive across pages vs. replace) via `onToggleAll`, and supplies its
 * own right-side counter via `rightSlot`.
 */
export function SelectAllRow({
  items,
  selectedIds,
  onToggleAll,
  rightSlot,
}: {
  items: ContactListItem[];
  selectedIds: Set<string>;
  onToggleAll: (checked: boolean, visibleIds: string[]) => void;
  rightSlot?: React.ReactNode;
}) {
  const allSelected =
    items.length > 0 && items.every((i) => selectedIds.has(i.contact.id));
  const someSelected =
    !allSelected && items.some((i) => selectedIds.has(i.contact.id));

  return (
    <div className="flex items-center gap-3 border-b border-border bg-muted/20 px-4 py-2 text-[11px]">
      <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
        <input
          type="checkbox"
          className="size-4 cursor-pointer accent-primary"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected;
          }}
          onChange={(e) =>
            onToggleAll(
              e.target.checked,
              items.map((i) => i.contact.id),
            )
          }
          aria-label="Select all visible"
        />
        Select all visible
      </label>
      {rightSlot && <span className="ml-auto">{rightSlot}</span>}
    </div>
  );
}
