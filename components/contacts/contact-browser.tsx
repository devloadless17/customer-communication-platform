"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Plus, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TagChip } from "@/components/tags/tag-chip";
import { cn } from "@/lib/utils";
import type {
  ContactFieldDefinition,
  ContactListItem,
  ContactSource,
  ContactStage,
  CursorPage,
  Tag,
} from "@/lib/types";

import { BrowserRow } from "./contact-browser/browser-row";
import { Chip } from "./contact-browser/chip";
import { FieldFilterRow, type FieldFilter } from "./contact-browser/field-filter-row";
import { StageFilterControl, type StageFilter } from "./contact-browser/stage-filter-control";

export type { FieldFilter, StageFilter };

/**
 * The one and only contact-browsing surface.
 *
 * `ContactsClient` (the /contacts page) and `ContactSelectDialog` (the picker
 * used by audience groups, broadcasts, and anything else that needs to pick
 * people) both build on the pieces here:
 *
 *   - `useContactList`  — search / source / custom-field filtering, debounced
 *                         refetch, cursor pagination, race-guarded.
 *   - `ContactFilterBar`— the search box + "Show:" source chips + per-field
 *                         filter pills. Identical UX wherever it appears.
 *   - `ContactBrowser`  — the filtered, paginated list with row checkboxes.
 *                         Pure selection; no row actions. The /contacts page
 *                         keeps its own richer rows (tags, edit, open chat),
 *                         but shares the filter bar and the hook.
 *
 * Identity note: rows key on the contact id, which is itself anchored to the
 * phone number server-side (`@@unique([teamId, phoneNumber])`). Name is just a
 * label — every row shows the phone number, and falls back to it when there's
 * no name.
 */

// ---------------------------------------------------------------------------
// Filter types + fetcher
// ---------------------------------------------------------------------------

export type SourceFilter = "all" | ContactSource;
/** 24h customer-service window filter. "any" = no filter. */
export type WindowFilter = "any" | "open" | "closed";

export interface ContactListFilters {
  search: string;
  fieldFilter: FieldFilter | null;
  sourceFilter: SourceFilter;
  windowFilter: WindowFilter;
  /** Keep contacts carrying ANY of these tag ids. Empty = no tag filter. */
  tagIds: string[];
  /** Lifecycle stage filter. "any" disables the filter. */
  stageFilter: StageFilter;
}

export async function fetchContactsPage(
  filters: ContactListFilters,
  cursor: string | null,
): Promise<CursorPage<ContactListItem>> {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.fieldFilter) {
    params.set("fieldKey", filters.fieldFilter.key);
    params.set("fieldValue", filters.fieldFilter.value);
  }
  if (filters.sourceFilter !== "all") params.set("source", filters.sourceFilter);
  if (filters.windowFilter !== "any") params.set("window", filters.windowFilter);
  if (filters.tagIds.length > 0) params.set("tagIds", filters.tagIds.join(","));
  if (filters.stageFilter !== "any") params.set("stageId", filters.stageFilter);
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`/api/contacts?${params.toString()}`);
  if (!res.ok) throw new Error("fetch failed");
  return (await res.json()) as CursorPage<ContactListItem>;
}

// ---------------------------------------------------------------------------
// useContactList — shared list state for the page and the picker
// ---------------------------------------------------------------------------

export interface UseContactListResult {
  items: ContactListItem[];
  /** Direct setter so callers can splice in optimistic edits (new contact,
   *  bulk delete, in-place tag patch) without a refetch. */
  setItems: React.Dispatch<React.SetStateAction<ContactListItem[]>>;
  nextCursor: string | null;
  search: string;
  setSearch: (v: string) => void;
  fieldFilter: FieldFilter | null;
  setFieldFilter: (v: FieldFilter | null) => void;
  sourceFilter: SourceFilter;
  setSourceFilter: (v: SourceFilter) => void;
  windowFilter: WindowFilter;
  setWindowFilter: (v: WindowFilter) => void;
  tagIds: string[];
  setTagIds: (v: string[]) => void;
  stageFilter: StageFilter;
  setStageFilter: (v: StageFilter) => void;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  setError: (v: string | null) => void;
  loadMore: () => void;
}

export function useContactList(opts?: {
  initialItems?: ContactListItem[];
  initialNextCursor?: string | null;
  initialStageFilter?: StageFilter;
}): UseContactListResult {
  const [items, setItems] = useState<ContactListItem[]>(opts?.initialItems ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(
    opts?.initialNextCursor ?? null,
  );
  const [search, setSearch] = useState("");
  const [fieldFilter, setFieldFilter] = useState<FieldFilter | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [windowFilter, setWindowFilter] = useState<WindowFilter>("any");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [stageFilter, setStageFilter] = useState<StageFilter>(
    opts?.initialStageFilter ?? "any",
  );
  const [loading, setLoading] = useState(opts?.initialItems === undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable key for the tag-id set so the effect doesn't re-run on every render
  // when the array identity changes but the contents don't.
  const tagKey = tagIds.join(",");

  // Debounce server hits so typing doesn't flood the API; bump reqId on every
  // change so a slow page-1 can't overwrite a faster later request.
  //
  // Skip the very first run when the caller seeded us with `initialItems` —
  // those came from the server-rendered page and are already current. Without
  // this, the Contacts page does a redundant fetch on mount that flashes a
  // loading state for no reason.
  const reqId = useRef(0);
  const hasSeed = opts?.initialItems !== undefined;
  const skipFirstFetch = useRef(hasSeed);
  useEffect(() => {
    if (skipFirstFetch.current) {
      skipFirstFetch.current = false;
      return;
    }
    const my = ++reqId.current;
    setLoading(true);
    setError(null);
    const t = window.setTimeout(async () => {
      try {
        const page = await fetchContactsPage(
          { search, fieldFilter, sourceFilter, windowFilter, tagIds, stageFilter },
          null,
        );
        if (reqId.current !== my) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      } catch {
        if (reqId.current === my) setError("Couldn't load contacts");
      } finally {
        if (reqId.current === my) setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, fieldFilter, sourceFilter, windowFilter, tagKey, stageFilter]);

  function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await fetchContactsPage(
          { search, fieldFilter, sourceFilter, windowFilter, tagIds, stageFilter },
          nextCursor,
        );
        setItems((prev) => [...prev, ...page.items]);
        setNextCursor(page.nextCursor);
      } catch {
        setError("Couldn't load more");
      } finally {
        setLoadingMore(false);
      }
    })();
  }

  return {
    items,
    setItems,
    nextCursor,
    search,
    setSearch,
    fieldFilter,
    setFieldFilter,
    sourceFilter,
    setSourceFilter,
    windowFilter,
    setWindowFilter,
    tagIds,
    setTagIds,
    stageFilter,
    setStageFilter,
    loading,
    loadingMore,
    error,
    setError,
    loadMore,
  };
}

// ---------------------------------------------------------------------------
// ContactFilterBar — search + source chips + field pills
// ---------------------------------------------------------------------------

export function ContactFilterBar({
  search,
  onSearchChange,
  sourceFilter,
  onSourceChange,
  windowFilter = "any",
  onWindowChange,
  fieldFilter,
  onFieldChange,
  fieldDefinitions,
  tags = [],
  selectedTagIds = [],
  onTagsChange,
  stages = [],
  stageFilter = "any",
  onStageFilterChange,
  searchPlaceholder = "Search name, phone, email, or any field…",
}: {
  search: string;
  onSearchChange: (v: string) => void;
  sourceFilter: SourceFilter;
  onSourceChange: (v: SourceFilter) => void;
  windowFilter?: WindowFilter;
  onWindowChange?: (v: WindowFilter) => void;
  fieldFilter: FieldFilter | null;
  onFieldChange: (v: FieldFilter | null) => void;
  fieldDefinitions: ContactFieldDefinition[];
  tags?: Tag[];
  selectedTagIds?: string[];
  onTagsChange?: (next: string[]) => void;
  stages?: ContactStage[];
  stageFilter?: StageFilter;
  onStageFilterChange?: (next: StageFilter) => void;
  searchPlaceholder?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Show:</span>
          <Chip active={sourceFilter === "all"} onClick={() => onSourceChange("all")} label="All" />
          <Chip
            active={sourceFilter === "inbound"}
            onClick={() => onSourceChange("inbound")}
            label="Messaged me"
          />
          <Chip
            active={sourceFilter === "manual"}
            onClick={() => onSourceChange("manual")}
            label="Added by me"
          />
        </div>
        {onWindowChange && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">24h window:</span>
            <Chip active={windowFilter === "any"} onClick={() => onWindowChange("any")} label="Any" />
            <Chip
              active={windowFilter === "open"}
              onClick={() => onWindowChange("open")}
              label="Open"
            />
            <Chip
              active={windowFilter === "closed"}
              onClick={() => onWindowChange("closed")}
              label="Closed"
            />
          </div>
        )}
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="pl-8"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {onTagsChange && tags.length > 0 && (
        <TagFilterControl
          tags={tags}
          selectedTagIds={selectedTagIds}
          onChange={onTagsChange}
        />
      )}

      {onStageFilterChange && stages.length > 0 && (
        <StageFilterControl
          stages={stages}
          value={stageFilter}
          onChange={onStageFilterChange}
        />
      )}

      {fieldDefinitions.length > 0 && (
        <FieldFilterRow
          fieldDefinitions={fieldDefinitions}
          value={fieldFilter}
          onChange={onFieldChange}
        />
      )}
    </div>
  );
}

/**
 * Search-as-you-type tag selector: shows the chosen tag chips inline plus an
 * "Add tag" button that opens a small popover. Pick from the available tags;
 * picked ones become removable chips. No tag creation here — that lives where
 * you tag contacts. Reused by the contact filter bar and the audience-group
 * "by tag" section so the tag UX is identical everywhere.
 */
export function TagFilterControl({
  tags,
  selectedTagIds,
  onChange,
  label = "Tags:",
  emptyTriggerLabel = "Filter by tag",
}: {
  tags: Tag[];
  selectedTagIds: string[];
  onChange: (next: string[]) => void;
  label?: string;
  emptyTriggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    function handler(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const byId = new Map(tags.map((t) => [t.id, t] as const));
  const selectedTags = selectedTagIds
    .map((id) => byId.get(id))
    .filter((t): t is Tag => Boolean(t));

  const suggestions = (() => {
    const q = query.trim().toLowerCase();
    return tags.filter((t) => (q.length === 0 ? true : t.name.toLowerCase().includes(q)));
  })();

  function toggle(id: string) {
    onChange(
      selectedTagIds.includes(id)
        ? selectedTagIds.filter((x) => x !== id)
        : [...selectedTagIds, id],
    );
  }

  return (
    <div ref={boxRef} className="relative flex flex-wrap items-center gap-1.5 text-xs">
      {label && <span className="text-muted-foreground">{label}</span>}
      {selectedTags.map((t) => (
        <TagChip key={t.id} tag={t} size="xs" onRemove={() => toggle(t.id)} />
      ))}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 transition",
          open
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Plus className="size-3" />
        {selectedTags.length === 0 ? emptyTriggerLabel : "Add tag"}
      </button>
      {selectedTags.length > 0 && (
        <button
          type="button"
          onClick={() => onChange([])}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          clear
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 flex max-h-[300px] w-64 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          <div className="border-b border-border px-2.5 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tags…"
                className="h-8 pl-7 text-xs"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {suggestions.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                No tags match &quot;{query}&quot;.
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
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContactBrowser — the reusable, checkbox-driven contact list
// ---------------------------------------------------------------------------

export function ContactBrowser({
  selectedIds,
  onSelectedChange,
  fieldDefinitions = [],
  tags = [],
  stages = [],
  initialItems,
  initialNextCursor,
  onItemsLoaded,
  /** Tailwind height for the scroll area — callers in a modal want it bounded. */
  listClassName = "max-h-[55vh]",
}: {
  selectedIds: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  fieldDefinitions?: ContactFieldDefinition[];
  tags?: Tag[];
  stages?: ContactStage[];
  initialItems?: ContactListItem[];
  initialNextCursor?: string | null;
  /** Fires whenever the visible page changes — lets a parent cache id→label
   *  for the rows it has actually seen (used to render picked-chip labels
   *  without an extra round-trip). */
  onItemsLoaded?: (items: ContactListItem[]) => void;
  listClassName?: string;
}) {
  const list = useContactList({ initialItems, initialNextCursor });
  const { items } = list;
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t] as const)), [tags]);
  const stageById = useMemo(
    () => new Map(stages.map((s) => [s.id, s] as const)),
    [stages],
  );

  useEffect(() => {
    if (items.length > 0) onItemsLoaded?.(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function toggle(id: string, next: boolean) {
    const copy = new Set(selectedIds);
    if (next) copy.add(id);
    else copy.delete(id);
    onSelectedChange(copy);
  }

  const allVisibleSelected =
    items.length > 0 && items.every((i) => selectedIds.has(i.contact.id));
  const someVisibleSelected =
    !allVisibleSelected && items.some((i) => selectedIds.has(i.contact.id));

  function toggleAllVisible(next: boolean) {
    const copy = new Set(selectedIds);
    for (const i of items) {
      if (next) copy.add(i.contact.id);
      else copy.delete(i.contact.id);
    }
    onSelectedChange(copy);
  }

  const showEmpty = !list.loading && items.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <ContactFilterBar
        search={list.search}
        onSearchChange={list.setSearch}
        sourceFilter={list.sourceFilter}
        onSourceChange={list.setSourceFilter}
        windowFilter={list.windowFilter}
        onWindowChange={list.setWindowFilter}
        fieldFilter={list.fieldFilter}
        onFieldChange={list.setFieldFilter}
        fieldDefinitions={fieldDefinitions}
        tags={tags}
        selectedTagIds={list.tagIds}
        onTagsChange={list.setTagIds}
        stages={stages}
        stageFilter={list.stageFilter}
        onStageFilterChange={list.setStageFilter}
      />

      {list.error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {list.error}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card">
        {list.loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading…
          </div>
        ) : showEmpty ? (
          <div className="px-6 py-16 text-center text-sm text-muted-foreground">
            {list.search ||
            list.fieldFilter ||
            list.windowFilter !== "any" ||
            list.tagIds.length > 0
              ? "No contacts match your filters."
              : "No contacts yet."}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-border bg-muted/20 px-4 py-2 text-[11px]">
              <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer accent-primary"
                  checked={allVisibleSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someVisibleSelected;
                  }}
                  onChange={(e) => toggleAllVisible(e.target.checked)}
                  aria-label="Select all visible"
                />
                Select all visible
              </label>
              <span className="ml-auto tabular-nums">
                {items.length} shown · {selectedIds.size} selected
              </span>
            </div>
            <ul className={cn("divide-y divide-border overflow-y-auto", listClassName)}>
              {items.map((item) => (
                <BrowserRow
                  key={item.contact.id}
                  item={item}
                  fieldDefinitions={fieldDefinitions}
                  tagById={tagById}
                  stageById={stageById}
                  selected={selectedIds.has(item.contact.id)}
                  onSelectChange={(next) => toggle(item.contact.id, next)}
                />
              ))}
            </ul>
          </>
        )}
        {list.nextCursor && (
          <div className="border-t border-border p-3 text-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={list.loadMore}
              disabled={list.loadingMore}
            >
              {list.loadingMore ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
