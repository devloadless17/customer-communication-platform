"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { CheckSquare, Loader2, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ConversationWithRefs, User } from "@/lib/types";
import { ConversationListItem } from "./conversation-list-item";
import type { FilterId } from "./sidebar";

export function ConversationList({
  currentUser,
  conversations,
  filter,
  search,
  onSearchChange,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  currentUser: User;
  conversations: ConversationWithRefs[];
  filter: FilterId;
  search: string;
  onSearchChange: (s: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const selectedId = useSelectedLayoutSegment();
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
    if (
      !confirm(
        `Delete ${ids.length} chat${ids.length === 1 ? "" : "s"}? Removes all messages and notes from these threads. Contacts stay. Can't be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch("/api/conversations/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationIds: ids }),
      });
      if (!res.ok) {
        alert("Failed to delete chats");
        return;
      }
      // Server emits conversation:deleted per id; the list state will
      // reconcile through the team-events hook.
      setSelectionMode(false);
    } finally {
      setDeleting(false);
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();

    return conversations.filter(({ conversation: c, contact }) => {
      if (filter === "mine" && c.assignedUserId !== currentUser.id) return false;
      if (filter === "unassigned" && c.assignedUserId !== null) return false;
      if (filter === "closed" && c.status !== "closed") return false;
      if (filter === "all" && c.status === "closed") return false;

      if (q) {
        const haystack =
          `${contact.name} ${contact.phoneNumber} ${c.lastMessagePreview}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [conversations, currentUser.id, filter, search]);

  const filterLabel: Record<FilterId, string> = {
    all: "All open",
    mine: "Assigned to me",
    unassigned: "Unassigned",
    closed: "Closed",
  };

  // Infinite-scroll sentinel: an empty div near the bottom of the list. When
  // it enters the scroll container's viewport, fetch the next page. Held in
  // a ref so we can install an IntersectionObserver against the actual
  // scroll viewport (not the document) — the ScrollArea's internal viewport
  // becomes the root once we find it.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    // Find the nearest ancestor that actually scrolls — the Radix ScrollArea
    // viewport. Falls back to null (= window) which still works for normal
    // overflow.
    let root: Element | null = sentinel.parentElement;
    while (root && root !== document.body) {
      const overflowY = getComputedStyle(root).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") break;
      root = root.parentElement;
    }

    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMoreRef.current();
      },
      { root, rootMargin: "200px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMore, conversations.length]);

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col bg-background">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 pt-4 pb-3">
        <div>
          <h1 className="text-base font-semibold leading-tight">{filterLabel[filter]}</h1>
          <p className="text-xs text-muted-foreground">
            {selectionMode && selectedIds.size > 0
              ? `${selectedIds.size} selected`
              : `${visible.length} ${visible.length === 1 ? "conversation" : "conversations"}`}
          </p>
        </div>
        <div className="flex items-center gap-1">
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
            aria-label="Toggle selection mode"
          >
            <CheckSquare className="size-4" />
          </button>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Sort and filter"
          >
            <SlidersHorizontal className="size-4" />
          </button>
        </div>
      </header>

      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search name, phone, or message…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-9 pl-8"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <ul className="flex flex-col px-1.5 pb-3">
          <AnimatePresence initial={false} mode="popLayout">
            {visible.map(({ conversation, contact, assignedUser }) => {
              const checked = selectedIds.has(conversation.id);
              return (
                <motion.li
                  key={conversation.id}
                  layout
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: "easeOut" }}
                  className="relative"
                >
                  {selectionMode ? (
                    <button
                      type="button"
                      onClick={() => toggle(conversation.id)}
                      className={cn(
                        "block w-full cursor-pointer text-left",
                        checked && "bg-primary/5 rounded-md",
                      )}
                    >
                      <div className="flex items-center gap-2 pl-2">
                        <input
                          type="checkbox"
                          className="size-4 cursor-pointer accent-primary"
                          checked={checked}
                          onChange={() => toggle(conversation.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Select ${contact.name}`}
                        />
                        <div className="min-w-0 flex-1">
                          <ConversationListItem
                            conversation={conversation}
                            contact={contact}
                            assignedUser={assignedUser}
                            active={false}
                          />
                        </div>
                      </div>
                    </button>
                  ) : (
                    <Link href={`/inbox/${conversation.id}`} prefetch={false}>
                      <ConversationListItem
                        conversation={conversation}
                        contact={contact}
                        assignedUser={assignedUser}
                        active={selectedId === conversation.id}
                      />
                    </Link>
                  )}
                </motion.li>
              );
            })}
          </AnimatePresence>
          {visible.length === 0 && (
            <li className="px-3 py-12 text-center text-xs text-muted-foreground">
              No conversations match.
            </li>
          )}
        </ul>

        {/* Sentinel: triggers loadMore when scrolled into view. Always
            rendered (even when hasMore is false) so a brief race between
            "load completes" and "observer fires once more" is harmless. */}
        <div ref={sentinelRef} className="h-px" />

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
    </div>
  );
}
