"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { TagChip } from "@/features/tags/components/tag-chip";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";
import type {
  Contact,
  ContactFieldDefinition,
  ContactListItem,
  ContactStage,
  CursorPage,
  Tag,
} from "@ccp/shared/types";

import { BrowserRow } from "./contact-browser/browser-row";
import { SelectAllRow } from "./contact-browser/select-all-row";
import { FilterButton } from "./contact-browser/filter-button";
import { TagFilterList } from "./contact-browser/tag-filter-list";
import { StageFilterMenu, MoreFilterMenu } from "./contact-browser/filter-menus";
import { ActiveFilterChips } from "./contact-browser/active-filter-chips";
import { ContactRowsSkeleton } from "./contact-browser/row-skeleton";
import type {
  ChannelFilter,
  FieldFilter,
  SourceFilter,
  StageFilter,
  WindowFilter,
} from "./contact-browser/filter-types";

export type { ChannelFilter, FieldFilter, SourceFilter, StageFilter, WindowFilter };

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
 * phone number server-side (`@@unique([workspaceId, phoneNumber])`). Name is just a
 * label — every row shows the phone number, and falls back to it when there's
 * no name.
 */

// ---------------------------------------------------------------------------
// Filter types + fetcher
// ---------------------------------------------------------------------------

export interface ContactListFilters {
  search: string;
  fieldFilter: FieldFilter | null;
  sourceFilter: SourceFilter;
  /** Channel identity filter. "any" disables the filter. */
  channelFilter: ChannelFilter;
  /**
   * ONE account on that channel — a specific WhatsApp number, Page or IG
   * handle. `null` disables it. Answers "who writes to the Sales number",
   * which `channelFilter` alone cannot express on a multi-account workspace.
   * Matched server-side through the contact's conversation, which is the
   * single owner of a thread's account.
   */
  accountFilter: string | null;
  windowFilter: WindowFilter;
  /** Keep contacts carrying ANY of these tag ids. Empty = no tag filter. */
  tagIds: string[];
  /** Lifecycle stage filter. "any" disables the filter. */
  stageFilter: StageFilter;
  /** "Group by person" — one row per unified Customer instead of per contact. */
  groupByPerson: boolean;
}

export async function fetchContactsPage(
  filters: ContactListFilters,
  cursor: string | null,
  /** Numbered (offset) pagination. When `page` is set the server ignores the
   *  cursor and returns `totalCount` on every page — used by the /contacts
   *  page. Omit for the keyset/infinite-scroll callers (the picker). */
  paging?: { page?: number; take?: number },
): Promise<CursorPage<ContactListItem>> {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.fieldFilter) {
    params.set("fieldKey", filters.fieldFilter.key);
    params.set("fieldValue", filters.fieldFilter.value);
  }
  if (filters.sourceFilter !== "all") params.set("source", filters.sourceFilter);
  // Person mode rolls up across channels, so a single-channel filter is
  // meaningless there — send groupByPerson and skip channel.
  if (filters.groupByPerson) params.set("groupByPerson", "1");
  else if (filters.channelFilter !== "any") params.set("channel", filters.channelFilter);
  // Same rule as `channel`: person mode rolls a customer up ACROSS their
  // channel-contacts, so scoping to one account would return a subset of the
  // persons on screen.
  if (!filters.groupByPerson && filters.accountFilter) {
    params.set("accountId", filters.accountFilter);
  }
  if (filters.windowFilter !== "any") params.set("window", filters.windowFilter);
  if (filters.tagIds.length > 0) params.set("tagIds", filters.tagIds.join(","));
  if (filters.stageFilter !== "any") params.set("stageId", filters.stageFilter);
  if (paging?.page != null) params.set("page", String(paging.page));
  if (paging?.take != null) params.set("take", String(paging.take));
  if (cursor) params.set("cursor", cursor);
  const res = await apiFetch(`/api/contacts?${params.toString()}`);
  if (!res.ok) throw new Error("fetch failed");
  return (await res.json()) as CursorPage<ContactListItem>;
}

// ---------------------------------------------------------------------------
// Client-side filter evaluation.
//
// Mirrors the SQL in lib/queries/contacts.ts. Used to reconcile live
// contact:updated events against the current filter set so a stage/tag/etc.
// change in another tab reflects here without a refresh.
//
// `matchesContactFiltersExceptWindow` works on a Contact alone (no row
// context) — used to decide whether a contact NOT currently in the list
// could now join it. The window dimension can't be evaluated from a
// Contact (needs lastInboundAt), so it's punted to the refetch.
//
// `matchesContactFilters` works on a ContactListItem (the row carries
// lastInboundAt), so window can be evaluated locally — used to decide
// whether an EXISTING row still belongs in the filtered view.
//
// Keep both aligned with the SQL: server is authoritative, these are an
// optimistic local mirror that gets reconciled by the next refetch if it
// drifts.
// ---------------------------------------------------------------------------

const WINDOW_OPEN_MS = 24 * 60 * 60 * 1000;

export function matchesContactFiltersExceptWindow(
  contact: Contact,
  filters: ContactListFilters,
): boolean {
  if (filters.stageFilter === "none") {
    if (contact.stageId) return false;
  } else if (filters.stageFilter !== "any") {
    if (contact.stageId !== filters.stageFilter) return false;
  }
  if (filters.sourceFilter !== "all" && contact.source !== filters.sourceFilter) {
    return false;
  }
  // Person mode rolls up across channels, so `fetchContactsPage` deliberately
  // does NOT send `channel`. This local mirror must drop it too — otherwise a
  // live `contact.updated` for a visible person whose representative contact
  // sits on a filtered-out channel fails the match and the row silently
  // vanishes from a list the server would still return it in.
  if (
    !filters.groupByPerson &&
    filters.channelFilter !== "any" &&
    contact.identityChannel !== filters.channelFilter
  ) {
    return false;
  }
  if (filters.tagIds.length > 0) {
    const contactTagIds = contact.tagIds ?? [];
    if (!filters.tagIds.some((id) => contactTagIds.includes(id))) return false;
  }
  if (filters.fieldFilter) {
    const v = contact.customFields?.[filters.fieldFilter.key];
    const s = typeof v === "string" ? v : "";
    if (!s.toLowerCase().includes(filters.fieldFilter.value.toLowerCase())) return false;
  }
  const trimmed = filters.search.trim();
  if (trimmed) {
    const q = trimmed.toLowerCase();
    // Mirrors the server's `customFields::text ILIKE` — JSON.stringify is
    // close enough for substring matching and avoids walking each key.
    const haystack = [
      contact.name ?? "",
      contact.phoneNumber ?? "",
      contact.email ?? "",
      JSON.stringify(contact.customFields ?? {}),
    ]
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

export function matchesContactFilters(
  item: ContactListItem,
  filters: ContactListFilters,
): boolean {
  if (!matchesContactFiltersExceptWindow(item.contact, filters)) return false;
  if (filters.windowFilter === "any") return true;
  const recent =
    item.lastInboundAt !== null &&
    Date.now() - new Date(item.lastInboundAt).getTime() < WINDOW_OPEN_MS;
  return filters.windowFilter === "open" ? recent : !recent;
}

// ---------------------------------------------------------------------------
// useContactList — shared list state for the page and the picker
// ---------------------------------------------------------------------------

export interface UseContactListResult {
  items: ContactListItem[];
  /** Direct setter so callers can splice in optimistic edits (new contact,
   *  bulk delete, in-place tag patch) without a refetch. */
  setItems: React.Dispatch<React.SetStateAction<ContactListItem[]>>;
  /**
   * Authoritative total matching the current filter set (server-computed on
   * page 1, not the loaded-row count). `null` until the first page lands.
   * Use it to show "Showing N of TOTAL". Survives loadMore — only page-1
   * fetches (initial / filter-change / refetch / reconcile) refresh it.
   */
  totalCount: number | null;
  /** Nudge the displayed total by a delta after a local optimistic add/remove
   *  (e.g. -ids.length on a bulk delete) so it doesn't lag a fetch. Clamped at
   *  0; the next page-1 fetch makes the server authoritative again. */
  adjustTotalCount: (delta: number) => void;
  nextCursor: string | null;
  /** Current 1-based page (numbered/`paged` mode only; always 1 otherwise). */
  page: number;
  /** Total pages for the current filter set (`ceil(totalCount / pageSize)`,
   *  min 1). 1 when not in `paged` mode. */
  pageCount: number;
  /** Jump to a page (numbered mode). Clamped to [1, pageCount] by the caller. */
  setPage: (page: number) => void;
  search: string;
  setSearch: (v: string) => void;
  fieldFilter: FieldFilter | null;
  setFieldFilter: (v: FieldFilter | null) => void;
  sourceFilter: SourceFilter;
  setSourceFilter: (v: SourceFilter) => void;
  channelFilter: ChannelFilter;
  accountFilter: string | null;
  setAccountFilter: (v: string | null) => void;
  setChannelFilter: (v: ChannelFilter) => void;
  groupByPerson: boolean;
  setGroupByPerson: (v: boolean) => void;
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
  /**
   * Reconcile a single contact:updated event against the current filter
   * state. If the row exists and still matches: patch in place. If it
   * exists but no longer matches: drop it. If it doesn't exist but now
   * matches (non-window dimensions): schedule a debounced page-1 refetch
   * to surface it. Window-dimension matches for newly-appearing contacts
   * are decided by the refetch (we can't evaluate lastInboundAt locally
   * from a Contact payload).
   */
  reconcileContactUpdate: (contact: Contact) => void;
  /**
   * Refresh the visible page with current filters. Wired to the coalesced
   * `contacts:bulk_updated` socket event from server bulk-mutation paths
   * (no per-contact payload available, so refetch is the only way to
   * reconcile).
   */
  refetch: () => void;
}

export function useContactList(opts?: {
  initialItems?: ContactListItem[];
  initialNextCursor?: string | null;
  initialTotalCount?: number | null;
  initialStageFilter?: StageFilter;
  /** Opt into numbered (offset) pagination: filter changes reset to page 1,
   *  `setPage` fetches that page (replacing rows, not appending), and
   *  `totalCount` refreshes every fetch. Default false = keyset/infinite-scroll
   *  (the picker). */
  paged?: boolean;
  /** Rows per page in `paged` mode (default 25). */
  pageSize?: number;
}): UseContactListResult {
  const paged = opts?.paged ?? false;
  const pageSize = opts?.pageSize ?? 25;
  // In paged mode the seed is page 1 — cap it to one page so an over-sized SSR
  // seed (e.g. a caller that forgot to seed in offset mode) can't render more
  // rows than the page control claims. Ordering matches the offset query.
  const [items, setItems] = useState<ContactListItem[]>(
    paged && opts?.initialItems
      ? opts.initialItems.slice(0, opts?.pageSize ?? 25)
      : (opts?.initialItems ?? []),
  );
  const [nextCursor, setNextCursor] = useState<string | null>(
    opts?.initialNextCursor ?? null,
  );
  // Latest cursor mirrored in a ref so an in-flight loadMore can tell when a
  // page-1 fetch (effect / refetch / reconcile) replaced the cursor out from
  // under it — those share loadMore's reqId, so the reqId check alone can't
  // catch them (see loadMore). Kept current in the render body below.
  const nextCursorRef = useRef(nextCursor);
  nextCursorRef.current = nextCursor;
  const [totalCount, setTotalCount] = useState<number | null>(
    opts?.initialTotalCount ?? null,
  );
  // Server is authoritative; this just smooths optimistic add/remove between
  // fetches. Clamp at 0 so a double-delete can't drive it negative.
  const adjustTotalCount = useCallback((delta: number) => {
    setTotalCount((prev) => (prev === null ? prev : Math.max(0, prev + delta)));
  }, []);
  // Numbered-pagination cursor. Only meaningful when `paged`; stays 1 otherwise.
  // Mirrored in a ref so the stable refetch/reconcile callbacks can read the
  // live page without being recreated (they subscribe socket listeners once).
  const [page, setPage] = useState(1);
  const pageRef = useRef(1);
  pageRef.current = page;
  const [search, setSearch] = useState("");
  const [fieldFilter, setFieldFilter] = useState<FieldFilter | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("any");
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [groupByPerson, setGroupByPerson] = useState(false);
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
    if (paged) return; // numbered mode uses the offset effects below
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
          { search, fieldFilter, sourceFilter, channelFilter, accountFilter, windowFilter, tagIds, stageFilter, groupByPerson },
          null,
        );
        if (reqId.current !== my) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        if (page.totalCount !== undefined) setTotalCount(page.totalCount);
      } catch {
        if (reqId.current === my) setError("Couldn't load contacts");
      } finally {
        if (reqId.current === my) setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, fieldFilter, sourceFilter, channelFilter, accountFilter, windowFilter, tagKey, stageFilter, groupByPerson]);

  // ── Numbered (offset) pagination effects — `paged` mode only ──────────────
  // A filter change resets to page 1 (page N of the old filter set is
  // meaningless). Skip the seeded initial mount so we don't fight the SSR seed.
  const skipPagedReset = useRef(hasSeed);
  useEffect(() => {
    if (!paged) return;
    if (skipPagedReset.current) {
      skipPagedReset.current = false;
      return;
    }
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, fieldFilter, sourceFilter, channelFilter, accountFilter, windowFilter, tagKey, stageFilter, groupByPerson]);

  // Fetch the current page whenever filters or the page number change. Debounce
  // ONLY the typed search (so keystrokes don't flood the API); page navigation
  // and discrete filter-chip clicks fetch immediately so they feel instant —
  // a 250ms lag on a page-number click reads as sluggish. When a filter change
  // resets page N→1, this effect's cleanup cancels the stale page-N timer before
  // it fires (see the reset above), so only one request lands.
  const skipPagedFetch = useRef(hasSeed);
  const prevPagedSearch = useRef(search);
  useEffect(() => {
    if (!paged) return;
    if (skipPagedFetch.current) {
      skipPagedFetch.current = false;
      prevPagedSearch.current = search;
      return;
    }
    const searchChanged = prevPagedSearch.current !== search;
    prevPagedSearch.current = search;
    const delay = searchChanged ? 250 : 0;
    const my = ++reqId.current;
    setLoading(true);
    setError(null);
    const t = window.setTimeout(async () => {
      try {
        const data = await fetchContactsPage(
          { search, fieldFilter, sourceFilter, channelFilter, accountFilter, windowFilter, tagIds, stageFilter, groupByPerson },
          null,
          { page, take: pageSize },
        );
        if (reqId.current !== my) return;
        setItems(data.items);
        setNextCursor(null);
        if (data.totalCount !== undefined) setTotalCount(data.totalCount);
      } catch {
        if (reqId.current === my) setError("Couldn't load contacts");
      } finally {
        if (reqId.current === my) setLoading(false);
      }
    }, delay);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, fieldFilter, sourceFilter, channelFilter, accountFilter, windowFilter, tagKey, stageFilter, groupByPerson, page]);

  function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    // Capture the request generation AND the cursor we're paging from. The
    // filter-change effect bumps `reqId` on every filter change; if one lands
    // while this page is in flight, discard the result so we don't APPEND
    // stale-filter rows onto the fresh set it just installed. But a page-1
    // refetch/reconcile that STARTED BEFORE this loadMore already bumped
    // `reqId` before we captured it, so it shares our `my` value — the reqId
    // check can't catch it. After it installs a fresh page-1 + new cursor,
    // appending our stale-cursor page duplicates rows. Guard on the cursor
    // too: if the live cursor no longer matches the one we paged from, a
    // page-1 fetch superseded us — discard.
    const my = reqId.current;
    const fromCursor = nextCursor;
    void (async () => {
      try {
        const page = await fetchContactsPage(
          { search, fieldFilter, sourceFilter, channelFilter, accountFilter, windowFilter, tagIds, stageFilter, groupByPerson },
          fromCursor,
        );
        // superseded by a filter change (reqId) or a page-1 refetch (cursor)
        if (reqId.current !== my || nextCursorRef.current !== fromCursor) return;
        setItems((prev) => [...prev, ...page.items]);
        setNextCursor(page.nextCursor);
      } catch {
        if (reqId.current === my && nextCursorRef.current === fromCursor) {
          setError("Couldn't load more");
        }
      } finally {
        // Always clear so the new filter's loadMore isn't wedged behind a
        // superseded in-flight page.
        setLoadingMore(false);
      }
    })();
  }

  // Latest filter state in a ref so the reconcile callback stays stable
  // across renders (the contacts-client subscribes its socket listener
  // once in a [] effect — recreating the callback would tear it down).
  // Both the appear-case refetch and the in-place predicate read from
  // here, so they always see the freshest filters even if a filter changed
  // between the socket event firing and React committing the next render.
  const filtersRef = useRef<ContactListFilters>({
    search,
    fieldFilter,
    sourceFilter,
    channelFilter,
    accountFilter,
    windowFilter,
    tagIds,
    stageFilter,
    groupByPerson,
  });
  filtersRef.current = { search, fieldFilter, sourceFilter, channelFilter, accountFilter, windowFilter, tagIds, stageFilter, groupByPerson };

  // Public refetch — wired to the coalesced `contacts:bulk_updated` socket
  // event. Bulk paths (server-side bulk-tag etc.) don't send per-contact
  // payloads, so the only way to reconcile is "refresh the visible page."
  // Uses the same reqId guard as the filter-change effect so a stale
  // response can't overwrite a fresher one.
  const refetch = useCallback(() => {
    const my = ++reqId.current;
    setLoading(true);
    void (async () => {
      try {
        const data = await fetchContactsPage(
          filtersRef.current,
          null,
          paged ? { page: pageRef.current, take: pageSize } : undefined,
        );
        if (reqId.current !== my) return;
        setItems(data.items);
        setNextCursor(data.nextCursor);
        if (data.totalCount !== undefined) setTotalCount(data.totalCount);
      } catch {
        // Silent — next filter change recovers.
      } finally {
        if (reqId.current === my) setLoading(false);
      }
    })();
    // paged + pageSize are mount-stable; pageRef is read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reconcileTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (reconcileTimerRef.current !== null) {
        window.clearTimeout(reconcileTimerRef.current);
        reconcileTimerRef.current = null;
      }
    };
  }, []);

  const reconcileContactUpdate = useCallback((contact: Contact) => {
    const filters = filtersRef.current;
    let needsRefetch = false;
    setItems((prev) => {
      const idx = prev.findIndex((row) => row.contact.id === contact.id);
      if (idx === -1) {
        // Not in the current view. Only schedule a refetch when an ACTIVE
        // narrowing filter means this contact might now belong on the page.
        // Under the DEFAULT (no) filter, matchesContactFiltersExceptWindow is
        // unconditionally true, so an unrelated contact:updated would collapse
        // a deeply-scrolled list back to page 1 — pointless (a hidden contact
        // is already conceptually in the unpaginated set) and harmful (loses
        // the user's scroll position).
        const hasNarrowingFilter =
          filters.search.trim() !== "" ||
          filters.fieldFilter !== null ||
          filters.sourceFilter !== "all" ||
          filters.channelFilter !== "any" ||
          filters.windowFilter !== "any" ||
          filters.tagIds.length > 0 ||
          filters.stageFilter !== "any";
        if (
          hasNarrowingFilter &&
          matchesContactFiltersExceptWindow(contact, filters)
        ) {
          needsRefetch = true;
        }
        return prev;
      }
      const patched: ContactListItem = { ...prev[idx]!, contact };
      if (matchesContactFilters(patched, filters)) {
        const next = [...prev];
        next[idx] = patched;
        return next;
      }
      return prev.filter((_, i) => i !== idx);
    });
    if (needsRefetch) {
      if (reconcileTimerRef.current !== null) {
        window.clearTimeout(reconcileTimerRef.current);
      }
      // Debounced so a burst of contact:updated events (e.g. a bulk tag
      // op fanning out one event per contact) coalesces into one refetch.
      reconcileTimerRef.current = window.setTimeout(() => {
        reconcileTimerRef.current = null;
        const my = ++reqId.current;
        void (async () => {
          try {
            const data = await fetchContactsPage(
              filtersRef.current,
              null,
              paged ? { page: pageRef.current, take: pageSize } : undefined,
            );
            if (reqId.current !== my) return;
            setItems(data.items);
            setNextCursor(data.nextCursor);
            if (data.totalCount !== undefined) setTotalCount(data.totalCount);
          } catch {
            // Silent — next filter change or refresh recovers. A noisy
            // banner here for a background reconciliation would be worse.
          }
        })();
      }, 250);
    }
    // paged + pageSize are mount-stable; filters/page read live via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pageCount =
    paged && totalCount != null
      ? Math.max(1, Math.ceil(totalCount / pageSize))
      : 1;

  return {
    items,
    setItems,
    totalCount,
    adjustTotalCount,
    nextCursor,
    page,
    pageCount,
    setPage,
    search,
    setSearch,
    fieldFilter,
    setFieldFilter,
    sourceFilter,
    setSourceFilter,
    channelFilter,
    setChannelFilter,
    accountFilter,
    setAccountFilter,
    groupByPerson,
    setGroupByPerson,
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
    reconcileContactUpdate,
    refetch,
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
  channelFilter = "any",
  onChannelChange,
  accountFilter = null,
  onAccountChange,
  accounts = [],
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
  channelFilter?: ChannelFilter;
  onChannelChange?: (v: ChannelFilter) => void;
  /** ONE account on the channel. Omit `onAccountChange` to hide the section. */
  accountFilter?: string | null;
  onAccountChange?: (v: string | null) => void;
  accounts?: Array<{ id: string; channel: string; name: string }>;
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
  const [openMenu, setOpenMenu] = useState<"stage" | "tags" | "more" | null>(null);

  const stageActive = stageFilter !== "any";
  const moreActive =
    sourceFilter !== "all" ||
    (Boolean(onChannelChange) && channelFilter !== "any") ||
    (Boolean(onAccountChange) && accountFilter !== null) ||
    (Boolean(onWindowChange) && windowFilter !== "any") ||
    fieldFilter !== null;

  function clearAll() {
    onSearchChange("");
    onSourceChange("all");
    onChannelChange?.("any");
    onAccountChange?.(null);
    onWindowChange?.("any");
    onStageFilterChange?.("any");
    onTagsChange?.([]);
    onFieldChange(null);
    setOpenMenu(null);
  }

  const hasGroupedFilters =
    (onStageFilterChange && stages.length > 0) || (onTagsChange && tags.length > 0);

  return (
    <div className="flex flex-col gap-3">
      {/* One calm toolbar: prominent search + a few smart filter buttons
          grouped into a soft rail so they read as a related cluster, distinct
          from the search field. Each button opens a portal popover (works
          inside the picker modal), and active filters surface below as
          removable chips. */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-9 pl-8"
            data-contacts-search=""
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

        <div
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5",
            hasGroupedFilters &&
              "rounded-md border border-border/40 bg-muted/20 p-1",
          )}
        >
          {onStageFilterChange && stages.length > 0 && (
            <Popover
              open={openMenu === "stage"}
              onOpenChange={(o) => setOpenMenu(o ? "stage" : null)}
              content={
                <StageFilterMenu
                  stages={stages}
                  value={stageFilter}
                  onChange={(v) => {
                    onStageFilterChange(v);
                    setOpenMenu(null);
                  }}
                />
              }
            >
              <FilterButton
                label="Stage"
                active={stageActive}
                open={openMenu === "stage"}
                onClick={() => setOpenMenu((m) => (m === "stage" ? null : "stage"))}
              />
            </Popover>
          )}

          {onTagsChange && tags.length > 0 && (
            <Popover
              open={openMenu === "tags"}
              onOpenChange={(o) => setOpenMenu(o ? "tags" : null)}
              content={
                <TagFilterList
                  tags={tags}
                  selectedTagIds={selectedTagIds}
                  onChange={onTagsChange}
                />
              }
            >
              <FilterButton
                label="Tags"
                count={selectedTagIds.length}
                open={openMenu === "tags"}
                onClick={() => setOpenMenu((m) => (m === "tags" ? null : "tags"))}
              />
            </Popover>
          )}

          <Popover
            open={openMenu === "more"}
            onOpenChange={(o) => setOpenMenu(o ? "more" : null)}
            content={
              <MoreFilterMenu
                sourceFilter={sourceFilter}
                onSourceChange={onSourceChange}
                channelFilter={channelFilter}
                onChannelChange={onChannelChange}
                accountFilter={accountFilter}
                onAccountChange={onAccountChange}
                accounts={accounts}
                windowFilter={windowFilter}
                onWindowChange={onWindowChange}
                fieldFilter={fieldFilter}
                onFieldChange={onFieldChange}
                fieldDefinitions={fieldDefinitions}
              />
            }
          >
            <FilterButton
              label="More"
              active={moreActive}
              open={openMenu === "more"}
              onClick={() => setOpenMenu((m) => (m === "more" ? null : "more"))}
            />
          </Popover>
        </div>
      </div>

      <ActiveFilterChips
        sourceFilter={sourceFilter}
        onSourceChange={onSourceChange}
        channelFilter={channelFilter}
        onChannelChange={onChannelChange}
        windowFilter={windowFilter}
        onWindowChange={onWindowChange}
        stageFilter={stageFilter}
        onStageFilterChange={onStageFilterChange ?? (() => {})}
        stages={stages}
        tagIds={selectedTagIds}
        onTagsChange={onTagsChange ?? (() => {})}
        tags={tags}
        fieldFilter={fieldFilter}
        onFieldChange={onFieldChange}
        fieldDefinitions={fieldDefinitions}
        onClearAll={clearAll}
      />
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
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const byId = new Map(tags.map((t) => [t.id, t] as const));
  const selectedTags = selectedTagIds
    .map((id) => byId.get(id))
    .filter((t): t is Tag => Boolean(t));

  return (
    <div ref={boxRef} className="relative flex flex-wrap items-center gap-1.5 text-xs">
      {label && <span className="text-muted-foreground">{label}</span>}
      {selectedTags.map((t) => (
        <TagChip
          key={t.id}
          tag={t}
          size="xs"
          onRemove={() => onChange(selectedTagIds.filter((x) => x !== t.id))}
        />
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
        <div className="absolute left-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          <TagFilterList tags={tags} selectedTagIds={selectedTagIds} onChange={onChange} />
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

  // The picker list scrolls inside its own container, so the sentinel is
  // observed against that `ul` (not the viewport) for a clean prefetch margin.
  const scrollRef = useRef<HTMLUListElement>(null);
  const loadMoreRef = useInfiniteScroll<HTMLLIElement>({
    hasMore: Boolean(list.nextCursor) && items.length < 2000,
    onLoadMore: list.loadMore,
    root: scrollRef,
  });

  // Stable `toggle` so the memoized BrowserRow doesn't re-render every row on
  // each selection. selectedIds + onSelectedChange are read through refs (kept
  // current below) instead of closed over, so the callback identity never
  // changes — passing it straight to each row keeps the memo intact.
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const onSelectedChangeRef = useRef(onSelectedChange);
  onSelectedChangeRef.current = onSelectedChange;
  const toggle = useCallback((id: string, next: boolean) => {
    const copy = new Set(selectedIdsRef.current);
    if (next) copy.add(id);
    else copy.delete(id);
    onSelectedChangeRef.current(copy);
  }, []);

  // "Select all visible" preserves picks from prior pages — additive, not
  // a replace, so loading more then toggling doesn't drop earlier choices.
  function toggleAllVisible(checked: boolean, visibleIds: string[]) {
    const copy = new Set(selectedIds);
    for (const id of visibleIds) {
      if (checked) copy.add(id);
      else copy.delete(id);
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
          <ContactRowsSkeleton count={6} />
        ) : showEmpty ? (
          <div className="px-6 py-16 text-center text-sm text-muted-foreground">
            {list.search ||
            list.fieldFilter ||
            list.windowFilter !== "any" ||
            list.sourceFilter !== "all" ||
            list.stageFilter !== "any" ||
            list.tagIds.length > 0
              ? "No contacts match your filters."
              : "No contacts yet."}
          </div>
        ) : (
          <>
            <SelectAllRow
              items={items}
              selectedIds={selectedIds}
              onToggleAll={toggleAllVisible}
              rightSlot={
                <span className="tabular-nums">
                  {items.length} shown · {selectedIds.size} selected
                </span>
              }
            />
            <ul
              ref={scrollRef}
              className={cn("divide-y divide-border overflow-y-auto", listClassName)}
            >
              {items.map((item) => (
                <BrowserRow
                  key={item.contact.id}
                  item={item}
                  tagById={tagById}
                  stageById={stageById}
                  selected={selectedIds.has(item.contact.id)}
                  onSelectChange={toggle}
                />
              ))}
              {/* Auto-load sentinel — observed against the scrolling ul. */}
              {list.nextCursor && items.length < 2000 && (
                <li
                  ref={loadMoreRef}
                  className="flex items-center justify-center px-4 py-3 text-xs text-muted-foreground"
                >
                  {list.loadingMore && (
                    <>
                      <Loader2 className="mr-2 size-3.5 animate-spin" />
                      Loading more…
                    </>
                  )}
                </li>
              )}
            </ul>
          </>
        )}
        {/* Render-cap. The list isn't virtualized today; past ~2000 DOM rows
            the page gets laggy. Steer the user to refine filters instead of
            loading unbounded pages. (use-virtualizer pattern from
            conversation-list.tsx if this cap ever needs lifting.) */}
        {list.nextCursor && items.length >= 2000 && (
          <div className="border-t border-border p-3 text-center text-xs text-muted-foreground">
            Showing {items.length.toLocaleString()} contacts. Refine the filters
            or search to see more — the list is capped to keep the page
            responsive.
          </div>
        )}
      </div>
    </div>
  );
}
