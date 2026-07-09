"use client";

import { X } from "lucide-react";

import { TagChip } from "@/features/tags/components/tag-chip";
import { CHANNEL_LABEL, ChannelBadge } from "@/features/inbox/components/channel-badge";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn } from "@ccp/shared/utils";
import type { ContactFieldDefinition, ContactStage, Tag } from "@ccp/shared/types";

import type {
  ChannelFilter,
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
    <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full border border-border bg-card pl-2 pr-1 text-2xs text-foreground">
      {leading}
      <span className="max-w-40 truncate font-medium">{children}</span>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
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
  channelFilter = "any",
  onChannelChange,
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
  channelFilter?: ChannelFilter;
  onChannelChange?: (v: ChannelFilter) => void;
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
    channelFilter !== "any" ||
    windowFilter !== "any" ||
    stageFilter !== "any" ||
    tagIds.length > 0 ||
    fieldFilter !== null;

  if (!hasAny) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/40 pt-3">
      {sourceFilter !== "all" && (
        <FilterChip onRemove={() => onSourceChange("all")}>
          {SOURCE_LABEL[sourceFilter]}
        </FilterChip>
      )}

      {channelFilter !== "any" && onChannelChange && (
        <FilterChip
          onRemove={() => onChannelChange("any")}
          leading={<ChannelBadge channel={channelFilter} className="size-3 shrink-0" />}
        >
          {CHANNEL_LABEL[channelFilter]}
        </FilterChip>
      )}

      {windowFilter !== "any" && onWindowChange && (
        <FilterChip
          onRemove={() => onWindowChange("any")}
          leading={
            <span
              className={cn(
                "size-1.5 rounded-full",
                windowFilter === "open" ? "bg-success-fg" : "bg-destructive",
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
        className="ml-0.5 text-2xs text-muted-foreground hover:text-foreground hover:underline"
      >
        Clear all
      </button>
    </div>
  );
}
