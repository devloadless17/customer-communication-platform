"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckSquare, Loader2, Search, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useVirtualizer } from "@tanstack/react-virtual";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@ccp/shared/utils";
import type {
  ContactStage,
  ConversationWithRefs,
} from "@ccp/shared/types";
import { ConversationListItem } from "./conversation-list-item";
import { InboxSearchPanel, type SearchResultTarget } from "./inbox-search-panel";
import type { Filter, PresetFilterId } from "./inbox-controls";

const PRESET_LABELS: Record<PresetFilterId, string> = {
  active: "Active",
  all: "All chats",
  mine: "Assigned to me",
  unassigned: "Unassigned",
  closed: "Closed",
};

function ConversationListImpl({
  conversations,
  stages,
  filter,
  search,
  onSearchChange,
  hasMore,
  loadingMore,
  onLoadMore,
  activeConversationId,
  pendingConversationId,
  onOpenConversation,
  onOpenSearchResult,
  onStartContactChat,
  onPrefetchConversation,
  canDeleteConversations,
}: {
  conversations: ConversationWithRefs[];
  stages: ContactStage[];
  filter: Filter;
  search: string;
  onSearchChange: (s: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
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
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (selectionMode) return;
    setSelectedIds(new Set());
  }, [selectionMode]);

  // Clear selection when the filter changes — otherwise checkboxes look
  // unchecked (the rows aren't in the new view) but selectedIds still
  // carries the prior ids, and a bulk-delete would target invisible chats.
  // The reducer key is the filter's discriminated shape; stage filter id
  // and preset id both feed the comparison.
  const filterKey =
    filter.kind === "preset" ? `p:${filter.id}` : `s:${filter.stageId}`;
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filterKey]);

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
      const res = await fetch("/api/conversations/bulk", {
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
  const searchActive = search.trim().length > 0;
  // The live list always renders the full server slice; no client filter.
  const visible = conversations;

  const headerTitle = useMemo(() => {
    if (filter.kind === "preset") {
      return PRESET_LABELS[filter.id];
    }
    const stage = stages.find((s) => s.id === filter.stageId);
    return stage ? `Stage · ${stage.name}` : "Stage";
  }, [filter, stages]);

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

  // Row height: each ConversationListItem is ~76px (avatar + 3 stacked lines
  // with some padding). `measureElement` adapts if a row turns out taller
  // (long names wrap, etc.); the estimate just bootstraps the layout.
  const ROW_HEIGHT = 76;
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

  return (
    <div className="flex h-full w-full shrink flex-col bg-background md:w-64 md:min-w-48 lg:w-64 lg:min-w-52 xl:w-80 xl:min-w-60">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 pt-4 pb-3">
        <div>
          <h1 className="text-base font-semibold leading-tight">{headerTitle}</h1>
          <p className="text-xs text-muted-foreground">
            {selectionMode && selectedIds.size > 0
              ? `${selectedIds.size} selected`
              : `${visible.length} ${visible.length === 1 ? "conversation" : "conversations"}`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {canDeleteConversations && (
            <button
              type="button"
              onClick={() => setSelectionMode((v) => !v)}
              title={selectionMode ? "Exit selection mode" : "Select multiple"}
              className={cn(
                "flex size-8 items-center justify-center rounded-md transition-colors",
                selectionMode
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              aria-label={selectionMode ? "Exit selection mode" : "Select multiple"}
            >
              <CheckSquare className="size-4" />
            </button>
          )}
          {/* Sort & filter — not yet implemented. Removed until it does
              something; the current Filter chips below already cover most use
              cases (All / Mine / Unassigned). */}
        </div>
      </header>

      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search contacts, messages, comments…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-9 pl-8 pr-8"
          />
          {search.length > 0 && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
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
        {visible.length === 0 ? (
          <div className="px-3 py-12 text-center text-xs text-muted-foreground">
            No conversations match.
          </div>
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
                    // keyboard support, no onClick+stopPropagation dance.
                    <label
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 pl-2",
                        checked && "rounded-md bg-primary/5",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-4 cursor-pointer accent-primary"
                        checked={checked}
                        onChange={() => toggle(conversation.id)}
                        aria-label={`Select ${contact.name}`}
                      />
                      <div className="min-w-0 flex-1">
                        <ConversationListItem
                          conversation={conversation}
                          contact={contact}
                          assignedUser={assignedUser}
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
                      className="block w-full text-left"
                    >
                      <ConversationListItem
                        conversation={conversation}
                        contact={contact}
                        assignedUser={assignedUser}
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
          <div className="flex items-center justify-center px-3 py-4 text-[11px] text-muted-foreground">
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
            <span className="inline-flex h-7 items-center rounded-full bg-primary/10 px-2.5 text-[11px] font-medium text-primary tabular-nums">
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
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
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

