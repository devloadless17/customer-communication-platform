"use client";

import { useMemo } from "react";

import { tagColorClasses } from "@/lib/tag-colors";
import { cn } from "@/lib/utils";
import type { ContactStage } from "@/lib/types";

import { Chip } from "./chip";

export type StageFilter = "any" | "none" | string;

/**
 * Compact chip-row for the stage filter. Mirrors the source/window-filter
 * chip pattern — one chip per stage plus an "Any" and "No stage" option.
 * Stages cap at ~30 per team so a flat row is fine; if the list outgrows
 * the viewport the row wraps onto a new line via flex-wrap.
 */
export function StageFilterControl({
  stages,
  value,
  onChange,
}: {
  stages: ContactStage[];
  value: StageFilter;
  onChange: (next: StageFilter) => void;
}) {
  const sorted = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Stage:</span>
      <Chip active={value === "any"} onClick={() => onChange("any")} label="Any" />
      {sorted.map((s) => {
        const colors = tagColorClasses(s.color);
        const active = value === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition",
              active
                ? cn("border-transparent", colors.chip)
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", colors.solid)} />
            <span>{s.name}</span>
          </button>
        );
      })}
      <Chip
        active={value === "none"}
        onClick={() => onChange("none")}
        label="No stage"
      />
    </div>
  );
}
