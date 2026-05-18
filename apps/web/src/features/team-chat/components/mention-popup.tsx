"use client";

import { useEffect, useMemo } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn, initials } from "@ccp/shared/utils";
import type { User } from "@ccp/shared/types";

/**
 * @ autocomplete popover. The composer hands us the active query (text
 * after the @) and a position; we filter teammates and emit `onPick` when
 * the user clicks or hits Enter. Keyboard nav is wired via the composer
 * which forwards arrow keys / Enter through onKeyHandled.
 */
export function MentionPopup({
  teamMembers,
  query,
  position,
  onPick,
  onClose,
  onActiveIndexChange,
  activeIndex,
}: {
  teamMembers: User[];
  query: string;
  position: { left: number; top: number };
  onPick: (user: User) => void;
  onClose: () => void;
  onActiveIndexChange: (i: number) => void;
  activeIndex: number;
}) {
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    const candidates = teamMembers.filter((u) => u.isActive);
    if (!q) return candidates.slice(0, 8);
    return candidates
      .filter(
        (u) =>
          u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [query, teamMembers]);

  // Reset active index whenever the candidate list shrinks past the cursor.
  useEffect(() => {
    if (activeIndex >= filtered.length) onActiveIndexChange(0);
  }, [filtered.length, activeIndex, onActiveIndexChange]);

  if (filtered.length === 0) {
    return (
      <div
        className="fixed z-50 w-64 rounded-lg border border-border bg-popover p-2 text-sm shadow-xl"
        style={{ left: position.left, top: position.top }}
      >
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          No teammates match “{query}”
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed z-50 w-64 rounded-lg border border-border bg-popover p-1 shadow-xl"
      style={{ left: position.left, top: position.top }}
      onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
    >
      <div className="border-b border-border px-2 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        Mention teammate
      </div>
      <div className="max-h-72 overflow-y-auto py-1">
        {filtered.map((u, i) => (
          <button
            key={u.id}
            type="button"
            onMouseEnter={() => onActiveIndexChange(i)}
            onClick={() => onPick(u)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
              i === activeIndex && "bg-accent text-accent-foreground",
            )}
          >
            <Avatar className="size-6">
              <AvatarFallback className="text-[10px]">{initials(u.name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{u.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">{u.email}</div>
            </div>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="hidden"
        aria-hidden
      />
    </div>
  );
}

/** Exposed for the composer's keyboard handler. */
export type FilteredMembers = User[];
export function filterMembersByQuery(
  teamMembers: User[],
  query: string,
): User[] {
  const q = query.toLowerCase().trim();
  const active = teamMembers.filter((u) => u.isActive);
  if (!q) return active.slice(0, 8);
  return active
    .filter(
      (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    )
    .slice(0, 8);
}
