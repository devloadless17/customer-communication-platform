"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowDownWideNarrow,
  CheckCircle2,
  CheckSquare,
  Clock,
  Inbox as InboxIcon,
  Loader2,
  Search,
  SearchX,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";
import type {
  ContactStage,
  ConversationWithRefs,
  Tag,
} from "@ccp/shared/types";
import { useConversationCounts } from "@/features/inbox/hooks/use-conversation-counts";
import { useInboxFilter } from "@/features/inbox/contexts/inbox-filter-context";
import { conversationFilterKey } from "@/features/inbox/lib/filter-key";
import { useInboxViews } from "@/features/inbox/contexts/inbox-views-context";
import { ConversationListItem } from "./conversation-list-item";
import { InboxSearchPanel, type SearchResultTarget } from "./inbox-search-panel";
import type { Filter, PresetFilterId } from "./inbox-controls";

const PRESET_LABELS: Record<PresetFilterId, string> = {
  active: "Active",
  all: "All chats",
  mine: "Assigned to me",
  unassigned: "Unassigned",
  closed: "Closed",
  flagged: "Flagged",
};

function ConversationListImpl({
  conversations,
  stages,
  filter,
  search,
  onSearchChange,
  hasMore,
  loadingMore,
  listRefetching,
  onLoadMore,
  activeConversationId,
  pendingConversationId,
  onOpenConversation,
  onOpenSearchResult,
  onStartContactChat,
  onPrefetchConversation,
  canDeleteConversations,
  tags,
  currentUserId,
}: {
  conversations: ConversationWithRefs[];
  stages: ContactStage[];
  /** Team tag catalog — forwarded to each row for the tag chips. */
  tags: Tag[];
  /** Viewing agent's id — drives the row "You" assignee emphasis. */
  currentUserId: string;
  filter: Filter;
  search: string;
  onSearchChange: (s: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  /** True while a filter-switch refetch is in flight — show a skeleton, not the
   *  "all caught up" empty state, until the new filter's rows land. */
  listRefetching: boolean;
  onLoadMore: () => void;
  /** Id of the conversation the shell is currently showing. Drives the
   *  highlighted-row style. */
  activeConversationId: string | null;
  /** Set to the id of a chat the agent just clicked while its data is being
   *  fetched from /api/inbox/conversation/<id>. Lets the row render an
   *  immediate "I heard you" state without waiting for the network. */
  pendingConversationId: string | null;
  /** Open a conversation in the workspace. The shell handles cache + URL
   *  sync — this list just dispatches. */
  onOpenConversation: (conversationId: string) => void;
  /** Open a conversation from a search hit, optionally jumping to a message.
   *  Distinct from onOpenConversation because message hits carry a target
   *  the thread must scroll to. */
  onOpenSearchResult: (target: SearchResultTarget) => void;
  /** Start a fresh chat with a contact that has no conversation yet (a
   *  contact-tab hit on a never-messaged contact). */
  onStartContactChat: (contactId: string) => void;
  /** Warm the workspace cache for a conversation the agent is likely about
   *  to click. Idempotent and cheap — fires on hover/focus, no-ops if the
   *  row is already cached or in flight. */
  onPrefetchConversation: (conversationId: string) => void;
  /** `conversations:delete` — gates the multi-select toolbar + bulk delete.
   *  When false, the "Select multiple" affordance is hidden entirely. */
  canDeleteConversations: boolean;
}) {
  const { confirm, alert, confirmDialog } = useConfirm();
  // "selection mode": clicking a row toggles its checkbox instead of opening
  // the chat. Toggled by the toolbar button or auto-engaged when the agent
  // checks the first row. Esc / Clear exits.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // The account narrow. It is a SECOND filter dimension, independent of
  // `filter` (which arrives as a prop), and it must take part in `filterKey`
  // below — see the comment there for what happens when it doesn't.
  const { accountId } = useInboxFilter();
  const [deleting, setDeleting] = useState(false);
  // Roving keyboard focus through the loaded rows (j/k or arrows; Enter opens).
  // -1 = no row highlighted (the default; the highlight is opt-in via a keypress
  // so it never competes with the active/unread cues on first paint). Distinct
  // from `activeConversationId` (the OPEN thread) and `selectedIds` (selection
  // mode) — this is purely a keyboard cursor.
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  useEffect(() => {
    if (selectionMode) return;
    setSelectedIds(new Set());
  }, [selectionMode]);

  // Clear selection when the filter changes — otherwise checkboxes look
  // unchecked (the rows aren't in the new view) but selectedIds still
  // carries the prior ids, and a bulk-delete would target invisible chats.
  //
  // ONE AUTHORITY for what "the list I'm looking at" means, because this key
  // was built inline from `filter` alone and the account narrow — a second,
  // independent dimension living in the filter context — was not in it. See
  // lib/filter-key.ts for what that omission cost.
  const filterKey = conversationFilterKey(filter, accountId);
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filterKey]);

  // Drop the keyboard highlight whenever the underlying list identity changes
  // (filter / stage switch / search) or the agent enters selection mode — the
  // cursor's index no longer points at the same conversation, and selection
  // mode owns row clicks via its own checkboxes.
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [filterKey, search, selectionMode]);

  // Hover-prefetch debounce. Without this, scrolling through 20 rows fires
  // 20 fetches in ~200ms — those evict useful entries from the LRU before
  // the agent has a chance to click anything. 150ms is long enough to weed
  // out drive-by mouse paths but short enough that an intentional hover
  // before a click still warms the cache.
  const hoverTimerRef = useRef<number | null>(null);
  const cancelHoverPrefetch = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };
  const scheduleHoverPrefetch = (conversationId: string) => {
    cancelHoverPrefetch();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      onPrefetchConversation(conversationId);
    }, 150);
  };
  useEffect(() => cancelHoverPrefetch, []);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const copy = new Set(prev);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  }

  async function bulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Delete ${ids.length} chat${ids.length === 1 ? "" : "s"}?`,
      description:
        "Removes all messages and notes from these threads. The contacts stay. This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await apiFetch("/api/conversations/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationIds: ids }),
      });
      if (!res.ok) {
        await alert("Couldn't delete chats", "Please try again.");
        return;
      }
      // Server emits conversation:deleted per id; the list state will
      // reconcile through the team-events hook.
      setSelectionMode(false);
    } finally {
      setDeleting(false);
    }
  }

  // A non-empty query swaps the live conversation list for the global tabbed
  // search panel (InboxSearchPanel). The live list is no longer client-side
  // filtered — search is a true server query across the WHOLE team now, not a
  // filter over the loaded slice (which could only ever find loaded rows).
  // A single character keeps the live list visible (the global search panel's
  // own server query needs ≥2 chars to return anything useful anyway) — only a
  // ≥2-char query swaps to the tabbed search panel.
  const searchActive = search.trim().length >= 2;
  // The live list always renders the full server slice; no client filter.
  // Sort mode. "recent" = the server's lastMessageAt-desc order (default).
  // "waiting" = longest-waiting first (oldest customer message at top) — the
  // shared-inbox triage view ("answer who's waited longest"). Applied CLIENT-
  // SIDE over the loaded rows (each carries lastInboundAt), so it needs zero
  // changes to the server cursor / pagination / live-reorder — the realtime
  // list keeps flowing through its existing reducers and this just re-sorts the
  // result. Limitation: it orders the LOADED set; scrolling loads more, which
  // sort in. Initial "recent" matches SSR (no hydration mismatch).
  const [sortMode, setSortMode] = useState<"recent" | "waiting">("recent");
  useEffect(() => {
    try {
      if (window.localStorage.getItem("inbox:sort") === "waiting") {
        setSortMode("waiting");
      }
    } catch {
      // private mode — default sort, no persistence
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem("inbox:sort", sortMode);
    } catch {
      // ignore quota / private-mode
    }
  }, [sortMode]);
  const cycleSort = useCallback(() => {
    setSortMode((m) => (m === "recent" ? "waiting" : "recent"));
  }, []);

  const visible = useMemo(() => {
    if (sortMode === "recent") return conversations;
    // Oldest inbound first; a conversation with no inbound yet (null) isn't
    // "waiting on a reply", so it sorts last. Array.sort is stable, so equal
    // keys keep the server's recency tiebreak.
    return [...conversations].sort((a, b) => {
      const ai = a.lastInboundAt;
      const bi = b.lastInboundAt;
      if (ai === bi) return 0;
      if (ai === null) return 1;
      if (bi === null) return -1;
      return ai < bi ? -1 : 1;
    });
  }, [conversations, sortMode]);

  const { views: savedViews, counts: viewCounts } = useInboxViews();

  const headerTitle = useMemo(() => {
    if (filter.kind === "preset") {
      return PRESET_LABELS[filter.id];
    }
    // The list isn't rendered for the calls view (the shell swaps in the
    // calls history), but keep the union exhaustive for the type checker.
    if (filter.kind === "calls") return "Calls";
    if (filter.kind === "view") {
      // A view that vanished (deleted, or un-shared out from under this agent)
      // still has its id in the cookie for one render. "View" beats printing a
      // cuid; the layout drops the stale id on the next load.
      return savedViews.find((v) => v.id === filter.viewId)?.name ?? "View";
    }
    const stage = stages.find((s) => s.id === filter.stageId);
    return stage ? `Stage · ${stage.name}` : "Stage";
  }, [filter, stages, savedViews]);

  // Authoritative bucket total for the CURRENT view. The loaded slice
  // (`visible.length`) only counts paginated-in rows, so the header used to
  // show "40+ conversations" while the sub-sidebar — fed by these same
  // server counts — showed the true total right beside it. Reading the same
  // source here makes the two agree.
  //
  // This is a SECOND `useConversationCounts` mount (the sub-sidebar owns the
  // first). It's a read against an endpoint that already exists, coalesced
  // and socket-refreshed, so the marginal cost is one extra GET + listener
  // set per inbox mount — cheap, and worth killing the side-by-side
  // disagreement. `null` until the first response lands; we fall back to the
  // slice count (visually correct, just possibly short) until then.
  const serverCounts = useConversationCounts();
  const headerTotal = useMemo<number | null>(() => {
    // Saved views are counted by their own endpoint, on a slower cadence —
    // see InboxViewsProvider for why they don't ride the preset counts.
    if (filter.kind === "view") return viewCounts?.[filter.viewId]?.total ?? null;
    if (!serverCounts) return null;
    if (filter.kind === "preset") return serverCounts[filter.id] ?? 0;
    if (filter.kind === "stage") return serverCounts.byStage[filter.stageId] ?? 0;
    return null; // calls view doesn't render this list
  }, [serverCounts, filter, viewCounts]);

  // ---- Virtualization wiring ----------------------------------------------
  //
  // The Radix ScrollArea renders its actual scroll surface as a child
  // `[data-radix-scroll-area-viewport]` div. We resolve that element on
  // mount via a ref + post-render walk, and feed it into the virtualizer.
  //
  // Why virtualize: load-more grows `visible` to 100-250 rows in regular
  // pilot use. Each row's memoized DOM is ~10 nodes → 2000-2500 nodes total,
  // measurable layout cost on every socket event despite per-row memo.
  // Virtualization caps the rendered set to viewport + small overscan
  // (typically 15-30 rows) regardless of list length. Same UX, ~90% DOM
  // reduction on large lists.
  // Direct viewport ref via ScrollArea's `viewportRef` prop — no more
  // useLayoutEffect + querySelector round-trip. The callback ref fires as
  // soon as the viewport node attaches, triggering one re-render in which
  // the virtualizer immediately has a scrollElement and produces real
  // measured items instead of the fallback estimate. Net: the empty-list
  // window between mount and the layout-effect closing is gone.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const viewportRef = useCallback((node: HTMLDivElement | null) => {
    setScrollEl(node);
  }, []);

  // Row height: ConversationListItem is now a FIXED 80px (h-20 — see that
  // file). Keeping this estimate EXACTLY equal to the rendered height means
  // the SSR/first-paint fallback positions (index * ROW_HEIGHT) already match
  // what `measureElement` measures, so nothing repositions on hydration — kills
  // the "rows bounce/settle on hard refresh" jank. If you change the row's
  // height, change BOTH numbers together.
  const ROW_HEIGHT = 80;
  const rowVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (idx) => visible[idx]!.conversation.id,
  });

  // SSR + the brief client window before useLayoutEffect resolves `scrollEl`
  // both produce a virtualizer that hasn't measured anything yet, so
  // `getVirtualItems()` returns []. Without a fallback, the list paints
  // empty on first hard-refresh (HTML has no rows) until JS hydrates and
  // the virtualizer kicks in — so the chat workspace renders fully while
  // the conversation list flashes empty for a beat.
  //
  // Fall back to rendering the first ~viewportful of rows at predictable
  // offsets (index * ROW_HEIGHT — what the virtualizer will eventually
  // produce from estimateSize). `measureElement` is attached on the
  // fallback rows too so the virtualizer captures real heights during the
  // pre-mount paint — by the time `scrollEl` arrives, the first measured
  // render already has correct positions instead of re-deriving from the
  // 76px estimate. Closes the theoretical estimate-vs-measure layout-shift
  // window on rows that turn out taller than the estimate (long-name wraps,
  // future row variants).
  const virtualItems = rowVirtualizer.getVirtualItems();
  const fallbackRows = 30; // covers ~2x typical viewport height
  type RenderItem = { key: string; index: number; start: number };
  const renderItems: RenderItem[] =
    virtualItems.length > 0
      ? virtualItems.map((v) => ({
          key: String(v.key),
          index: v.index,
          start: v.start,
        }))
      : visible.slice(0, fallbackRows).map((item, idx) => ({
          key: item.conversation.id,
          index: idx,
          start: idx * ROW_HEIGHT,
        }));
  // Total scroll height: virtualizer's value once measured, otherwise the
  // estimated total so the scrollbar handle reflects real list length.
  const totalHeight =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize()
      : visible.length * ROW_HEIGHT;

  // Infinite-scroll trigger. Instead of an IntersectionObserver on a
  // sentinel div (which doesn't exist inside the virtualized container in a
  // measurable position), we watch `rowVirtualizer.getVirtualItems()` —
  // when the last rendered virtual item is at-or-past the end of `visible`,
  // we're near the bottom of the loaded set and it's time to fetch more.
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  const lastVirtualIndex =
    rowVirtualizer.getVirtualItems().at(-1)?.index ?? -1;

  useEffect(() => {
    if (!hasMore || loadingMore) return;
    if (lastVirtualIndex < 0) return;
    // Trigger when the rendered range gets within 5 rows of the end of the
    // currently-loaded slice. Mirrors the prior `rootMargin: 200px` feel.
    if (lastVirtualIndex >= visible.length - 5) {
      onLoadMoreRef.current();
    }
  }, [lastVirtualIndex, hasMore, loadingMore, visible.length]);

  // ---- Keyboard navigation (j/k + arrows, Enter to open) ------------------
  //
  // A roving FOCUS highlight over the loaded rows. Attached to the list root
  // so the keys work whenever the list region has focus, but we bail the
  // moment the agent is typing in a field (search box, any future input) so
  // search typing — and `j`/`k` as literal characters — is never swallowed.
  // Selection mode and the search panel both take the list rows away, so we
  // no-op there too. On every move we ask the virtualizer to scroll the new
  // index into view (it may be outside the windowed/overscan set).
  const isTypingTarget = (el: EventTarget | null): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el.isContentEditable
    );
  };

  const onListKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // Don't intercept while typing (search box / contenteditable) or when the
      // rows aren't the active surface (selection mode, search panel open).
      if (selectionMode || searchActive) return;
      if (isTypingTarget(document.activeElement)) return;
      if (visible.length === 0) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      const key = e.key;
      const down = key === "j" || key === "ArrowDown";
      const up = key === "k" || key === "ArrowUp";

      if (down || up) {
        e.preventDefault();
        setHighlightedIndex((prev) => {
          // First keypress with nothing highlighted enters at the top (down) or
          // bottom (up); subsequent presses step and clamp at the ends.
          const next =
            prev < 0
              ? down
                ? 0
                : visible.length - 1
              : down
                ? Math.min(prev + 1, visible.length - 1)
                : Math.max(prev - 1, 0);
          rowVirtualizer.scrollToIndex(next);
          return next;
        });
        return;
      }

      if (key === "Enter" && highlightedIndex >= 0) {
        const item = visible[highlightedIndex];
        if (item) {
          e.preventDefault();
          onOpenConversation(item.conversation.id);
        }
      }
    },
    [
      selectionMode,
      searchActive,
      visible,
      highlightedIndex,
      rowVirtualizer,
      onOpenConversation,
    ],
  );

  // Warm the cache for the keyboard-highlighted row so Enter opens instantly,
  // mirroring the mouse hover-prefetch. Cheap + idempotent (no-ops if cached /
  // in flight). Skipped while the highlight is cleared (-1).
  useEffect(() => {
    if (highlightedIndex < 0) return;
    const item = visible[highlightedIndex];
    if (item) onPrefetchConversation(item.conversation.id);
  }, [highlightedIndex, visible, onPrefetchConversation]);

  // The list root is tabIndex={-1} with a keydown handler, but nothing focuses
  // it — so j/k nav is inert until a row is clicked. On mount, move focus into
  // the region so keyboard nav works right away. Guarded to fine-pointer
  // (desktop) devices so touch/mobile doesn't get a stray focus ring, and
  // skipped when focus already sits on a real control (e.g. the search box) so
  // we never yank it. preventScroll keeps the pane from jumping.
  const listRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== listRootRef.current) {
      return;
    }
    listRootRef.current?.focus({ preventScroll: true });
  }, []);

  // Width is owned by the parent column in inbox-shell (drag-resizable on
  // desktop, full-width on mobile); this just fills it.
  return (
    <div
      ref={listRootRef}
      className="flex h-full w-full flex-col bg-background outline-none"
      // Keyboard nav (j/k + arrows, Enter) — handler bails on input focus so
      // search typing is unaffected. tabIndex lets the region take focus
      // (e.g. on a click in the empty gutter) so the keys work without first
      // focusing a row; -1 keeps it out of the Tab order.
      tabIndex={-1}
      onKeyDown={onListKeyDown}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 pt-4 pb-3">
        <div>
          <h1 className="text-base font-semibold leading-tight">{headerTitle}</h1>
          <p className="text-xs text-muted-foreground">
            {selectionMode && selectedIds.size > 0
              ? `${selectedIds.size} selected`
              : headerTotal !== null
                ? // Authoritative server total for this view (matches the
                  // sub-sidebar badge). Exact — no misleading "+".
                  `${headerTotal} ${headerTotal === 1 ? "conversation" : "conversations"}`
                : // Server count not in yet — fall back to the LOADED slice.
                  // It undercounts while `hasMore`, so show "N+" rather than a
                  // wrong exact count; once everything's loaded the slice IS the
                  // bucket and the exact number is true.
                  `${visible.length}${hasMore ? "+" : ""} ${visible.length === 1 && !hasMore ? "conversation" : "conversations"}`}
            {sortMode === "waiting" &&
              !(selectionMode && selectedIds.size > 0) && (
                <span className="text-primary"> · longest waiting</span>
              )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {canDeleteConversations && (
            <button
              type="button"
              onClick={() => setSelectionMode((v) => !v)}
              aria-pressed={selectionMode}
              title={selectionMode ? "Exit selection mode" : "Select multiple"}
              className={cn(
                "flex size-8 pointer-coarse:size-9 items-center justify-center rounded-md transition-colors",
                selectionMode
                  ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/40"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              aria-label={selectionMode ? "Exit selection mode" : "Select multiple"}
            >
              <CheckSquare className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={cycleSort}
            title={
              sortMode === "waiting"
                ? "Sorted by longest waiting — click for latest activity"
                : "Sorted by latest activity — click for longest waiting"
            }
            aria-label="Toggle sort order"
            aria-pressed={sortMode === "waiting"}
            className={cn(
              "flex size-8 pointer-coarse:size-9 items-center justify-center rounded-md transition-colors",
              sortMode === "waiting"
                ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/40"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {sortMode === "waiting" ? (
              <Clock className="size-4" />
            ) : (
              <ArrowDownWideNarrow className="size-4" />
            )}
          </button>
        </div>
      </header>

      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search contacts, messages, comments…"
            aria-label="Search contacts, messages, and comments"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-9 pl-8 pr-8"
          />
          {search.length > 0 && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {searchActive ? (
        // Global tabbed search (Contacts / Messages / Comments) — replaces the
        // live conversation list while a query is present.
        <InboxSearchPanel
          query={search}
          onOpenResult={onOpenSearchResult}
          onStartContactChat={onStartContactChat}
        />
      ) : (
        <ScrollArea viewportRef={viewportRef} className="flex-1">
        {visible.length === 0 && listRefetching ? (
          // Filter-switch in flight and the loaded slice had no rows for this
          // view yet — show a calm skeleton instead of flashing "all caught up"
          // for the ~50-400ms until the server page lands. Matches the h-20 row
          // rhythm so there's no layout jump when the real rows replace it.
          <div className="flex flex-col gap-px p-2" aria-hidden>
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex h-20 items-center gap-3 rounded-lg px-3">
                <div className="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          // Context-aware empty copy. Three distinct cases, in priority order:
          //   1. First-run — no conversations exist at all (broad `active`/`all`
          //      preset, no active search). Guide setup instead of reading like
          //      a broken filter. A new team always lands here.
          //   2. "Caught up" — an empty `unassigned`/`mine` preset with NO active
          //      search is GOOD news (nothing waiting / nothing on your plate),
          //      so frame it as an achievement, not a failed lookup.
          //   3. No-match — an active search OR an empty stage filter genuinely
          //      narrowed everything out; keep the SearchX "try something else"
          //      framing.
          filter.kind === "preset" &&
          (filter.id === "active" || filter.id === "all") &&
          !searchActive ? (
            <EmptyState
              icon={InboxIcon}
              title="No conversations yet"
              description="Messages from your connected WhatsApp number will appear here. Make sure WhatsApp is connected in Settings."
              className="m-3 border-0 bg-transparent py-14"
            />
          ) : filter.kind === "preset" &&
            (filter.id === "unassigned" || filter.id === "mine") &&
            !searchActive ? (
            <EmptyState
              icon={CheckCircle2}
              title={
                filter.id === "unassigned"
                  ? "Nothing unassigned 🎉"
                  : "You're all caught up"
              }
              description={
                filter.id === "unassigned"
                  ? "Every conversation has an owner. New unassigned chats will show up here."
                  : "No conversations are assigned to you right now. Nice work."
              }
              className="m-3 border-0 bg-transparent py-12"
            />
          ) : (
            <EmptyState
              icon={SearchX}
              title="No conversations match this view"
              description="Try a different filter or stage to see more chats."
              className="m-3 border-0 bg-transparent py-12"
            />
          )
        ) : (
          // Virtualized list. The outer div has the full estimated height
          // (sum of all row sizes) so the scrollbar's drag handle reflects
          // the true list length, NOT the rendered subset. Each row is
          // absolutely positioned at its computed offset. Two-CSS rule
          // keeps virtualization invisible to row markup — the row's own
          // styles never know it's being windowed.
          <div
            className="relative w-full px-1.5 pb-3"
            style={{ height: `${totalHeight}px` }}
          >
            {renderItems.map((row) => {
              const item = visible[row.index]!;
              const { conversation, contact, assignedUser } = item;
              const checked = selectedIds.has(conversation.id);
              // Keyboard cursor — only meaningful outside selection mode. A
              // subtle inset ring + faint bg, deliberately distinct from the
              // active(open) `bg-primary/10` and the unread blue left-bar so the
              // three cues never read as one state.
              const highlighted = !selectionMode && row.index === highlightedIndex;
              return (
                <div
                  key={row.key}
                  // measureElement attaches on EVERY row (fallback too) so
                  // the virtualizer captures real heights before scrollEl
                  // arrives. Its first owned render then uses measured
                  // values instead of the 76px estimate — no estimate-vs-
                  // measure shift on rows that turn out taller.
                  ref={rowVirtualizer.measureElement}
                  data-index={row.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {selectionMode ? (
                    // <label> wrapping the checkbox is the canonical way to
                    // make the whole row a toggle target — valid HTML, native
                    // keyboard support, no onClick+stopPropagation dance. The
                    // checkbox sits in a w-6 lead column that appears only in
                    // selection mode; normal rows are flush-left (no reserved
                    // gutter — an empty gutter looked like wasted indent). A
                    // ~24px content shift on entering selection mode (a rare,
                    // deliberate action) is the accepted trade for clean rows.
                    <label
                      className={cn(
                        "flex w-full cursor-pointer items-center",
                        checked && "rounded-md bg-primary/5",
                      )}
                    >
                      <span className="flex w-6 shrink-0 items-center justify-center">
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer accent-primary"
                          checked={checked}
                          onChange={() => toggle(conversation.id)}
                          aria-label={`Select ${contact.name}`}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <ConversationListItem
                          conversation={conversation}
                          contact={contact}
                          assignedUser={assignedUser}
                          tags={tags}
                          currentUserId={currentUserId}
                          active={false}
                          pending={false}
                        />
                      </div>
                    </label>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpenConversation(conversation.id)}
                      onMouseEnter={() => scheduleHoverPrefetch(conversation.id)}
                      onMouseLeave={cancelHoverPrefetch}
                      onFocus={() => onPrefetchConversation(conversation.id)}
                      className={cn(
                        "block w-full rounded-lg text-left",
                        highlighted &&
                          "bg-accent/30 ring-1 ring-inset ring-primary/40",
                      )}
                      aria-current={
                        activeConversationId === conversation.id
                          ? "page"
                          : highlighted
                            ? "true"
                            : undefined
                      }
                    >
                      <ConversationListItem
                        conversation={conversation}
                        contact={contact}
                        assignedUser={assignedUser}
                        tags={tags}
                        currentUserId={currentUserId}
                        active={activeConversationId === conversation.id}
                        pending={pendingConversationId === conversation.id}
                      />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {hasMore && (
          <div className="flex items-center justify-center px-3 py-4 text-2xs text-muted-foreground">
            {loadingMore ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" />
                Loading more…
              </span>
            ) : (
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => onLoadMore()}
              >
                Load older conversations
              </button>
            )}
          </div>
        )}
        </ScrollArea>
      )}

      <AnimatePresence>
        {selectionMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 60, opacity: 0 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0.2 }}
            className="flex items-center gap-2 border-t border-border bg-popover px-3 py-2 shadow-lg"
          >
            <span className="inline-flex h-7 items-center rounded-full bg-primary/10 px-2.5 text-2xs font-medium text-primary tabular-nums">
              {selectedIds.size} selected
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={bulkDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Delete
            </Button>
            <button
              type="button"
              onClick={() => setSelectionMode(false)}
              className="inline-flex size-7 pointer-coarse:size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Cancel"
            >
              <X className="size-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {confirmDialog}
    </div>
  );
}

/**
 * Memoized so the inbox shell can re-render for unrelated state changes
 * (active-thread cache patches, composer state, etc.) without forcing the
 * whole list to walk its rows. Parent must pass stable refs for arrays /
 * callbacks; everything currently does via useMemo / useCallback.
 */
export const ConversationList = memo(ConversationListImpl);

