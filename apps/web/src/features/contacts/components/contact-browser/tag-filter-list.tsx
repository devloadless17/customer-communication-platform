"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { TagChip } from "@/features/tags/components/tag-chip";
import { cn } from "@ccp/shared/utils";
import type { Tag } from "@ccp/shared/types";

/**
 * Search-as-you-type, multi-select tag list — the body shared by the contact
 * filter bar's "Tags" popover and the standalone {@link TagFilterControl}
 * (audience groups + broadcasts). No tag creation here — filtering only.
 */
export function TagFilterList({
  tags,
  selectedTagIds,
  onChange,
  autoFocus = true,
}: {
  tags: Tag[];
  selectedTagIds: string[];
  onChange: (next: string[]) => void;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const q = query.trim().toLowerCase();
  const suggestions = q
    ? tags.filter((t) => t.name.toLowerCase().includes(q))
    : tags;

  function toggle(id: string) {
    onChange(
      selectedTagIds.includes(id)
        ? selectedTagIds.filter((x) => x !== id)
        : [...selectedTagIds, id],
    );
  }

  return (
    <div className="flex max-h-75 w-64 flex-col overflow-hidden">
      <div className="border-b border-border px-2.5 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tags…"
            aria-label="Search tags"
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {suggestions.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            {q ? `No tags match “${query}”.` : "No tags yet."}
          </div>
        ) : (
          <ul>
            {suggestions.map((t) => {
              const isSelected = selectedTagIds.includes(t.id);
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => toggle(t.id)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/60",
                      isSelected && "bg-accent/30",
                    )}
                  >
                    <TagChip tag={t} size="xs" />
                    <span className="flex-1" />
                    {isSelected ? (
                      <Check className="size-3.5 text-primary" />
                    ) : (
                      <span className="size-3.5" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
