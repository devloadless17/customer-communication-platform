"use client";

import { X } from "lucide-react";

import { TagChip } from "@/features/tags/components/tag-chip";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn } from "@ccp/shared/utils";
import type { ContactFieldDefinition, ContactStage, Tag } from "@ccp/shared/types";

import type {
  FieldFilter,
  SourceFilter,
  StageFilter,
  WindowFilter,
} from "./filter-types";

/** Generic removable filter chip. */
function FilterChip({
  onRemove,
  leading,
  children,
}: {
  onRemove: () => void;
  leading?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card pl-2 pr-1 text-[11px] text-foreground">
      {leading}
      <span className="font-medium">{children}</span>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        aria-label="Remove filter"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

const SOURCE_LABEL: Record<Exclude<SourceFilter, "all">, string> = {
  inbound: "Messaged me",
  manual: "Added by me",
};

/**
 * The removable summary of every active filter. Renders nothing when no
 * filter (other than free-text search, which has its own clear-X) is set.
 * This is the canonical "what am I filtered to / undo it" surface.
 */
export function ActiveFilterChips({
  sourceFilter,
  onSourceChange,
  windowFilter,
  onWindowChange,
  stageFilter,
  onStageFilterChange,
  stages,
  tagIds,
  onTagsChange,
  tags,
  fieldFilter,
  onFieldChange,
  fieldDefinitions,
  onClearAll,
}: {
  sourceFilter: SourceFilter;
  onSourceChange: (v: SourceFilter) => void;
  windowFilter: WindowFilter;
  onWindowChange?: (v: WindowFilter) => void;
  stageFilter: StageFilter;
  onStageFilterChange: (v: StageFilter) => void;
  stages: ContactStage[];
  tagIds: string[];
  onTagsChange: (next: string[]) => void;
  tags: Tag[];
  fieldFilter: FieldFilter | null;
  onFieldChange: (v: FieldFilter | null) => void;
  fieldDefinitions: ContactFieldDefinition[];
  onClearAll: () => void;
}) {
  const stage = stageFilter !== "any" && stageFilter !== "none"
    ? stages.find((s) => s.id === stageFilter) ?? null
    : null;
  const tagById = new Map(tags.map((t) => [t.id, t] as const));
  const selectedTags = tagIds
    .map((id) => tagById.get(id))
    .filter((t): t is Tag => Boolean(t));
  const fieldDef = fieldFilter
    ? fieldDefinitions.find((d) => d.key === fieldFilter.key) ?? null
    : null;

  const hasAny =
    sourceFilter !== "all" ||
    windowFilter !== "any" ||
    stageFilter !== "any" ||
    tagIds.length > 0 ||
    fieldFilter !== null;

  if (!hasAny) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sourceFilter !== "all" && (
        <FilterChip onRemove={() => onSourceChange("all")}>
          {SOURCE_LABEL[sourceFilter]}
        </FilterChip>
      )}

      {windowFilter !== "any" && onWindowChange && (
        <FilterChip
          onRemove={() => onWindowChange("any")}
          leading={
            <span
              className={cn(
                "size-1.5 rounded-full",
                windowFilter === "open" ? "bg-emerald-500" : "bg-destructive",
              )}
            />
          }
        >
          Window: {windowFilter === "open" ? "Open" : "Closed"}
        </FilterChip>
      )}

      {stageFilter === "none" && (
        <FilterChip
          onRemove={() => onStageFilterChange("any")}
          leading={<span className="size-1.5 rounded-full border border-border" />}
        >
          No stage
        </FilterChip>
      )}
      {stage && (
        <FilterChip
          onRemove={() => onStageFilterChange("any")}
          leading={
            <span
              className={cn("size-1.5 rounded-full", tagColorClasses(stage.color).solid)}
            />
          }
        >
          {stage.name}
        </FilterChip>
      )}

      {selectedTags.map((t) => (
        <TagChip
          key={t.id}
          tag={t}
          size="xs"
          onRemove={() => onTagsChange(tagIds.filter((id) => id !== t.id))}
        />
      ))}

      {fieldFilter && (
        <FilterChip onRemove={() => onFieldChange(null)}>
          {(fieldDef?.label ?? fieldFilter.key)}: {fieldFilter.value}
        </FilterChip>
      )}

      <button
        type="button"
        onClick={onClearAll}
        className="ml-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
      >
        Clear all
      </button>
    </div>
  );
}
