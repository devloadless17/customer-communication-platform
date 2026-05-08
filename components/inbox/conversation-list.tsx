"use client";

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { Loader2, Search, SlidersHorizontal } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
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
            {visible.length} {visible.length === 1 ? "conversation" : "conversations"}
          </p>
        </div>
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Sort and filter"
        >
          <SlidersHorizontal className="size-4" />
        </button>
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
            {visible.map(({ conversation, contact, assignedUser }) => (
              <motion.li
                key={conversation.id}
                layout
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
              >
                <Link href={`/inbox/${conversation.id}`} prefetch={false}>
                  <ConversationListItem
                    conversation={conversation}
                    contact={contact}
                    assignedUser={assignedUser}
                    active={selectedId === conversation.id}
                  />
                </Link>
              </motion.li>
            ))}
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
    </div>
  );
}
