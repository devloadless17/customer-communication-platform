"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ConversationWithRefs, CursorPage } from "@/lib/types";

const DEBOUNCE_MS = 250;

export interface ConversationSearchState {
  /** True when the user has typed a non-empty query. The conversation list
   *  should show {@link results} instead of the realtime list in this case. */
  active: boolean;
  /** Server matches. Empty (and `loading=true`) during the initial debounce. */
  results: ConversationWithRefs[];
  /** Cursor for the next page of search results, or null when exhausted. */
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/**
 * Debounced server-side conversation search.
 *
 * The live conversation list ({@link useTeamEvents}) only knows about the
 * pages the client has paginated through. With a few hundred conversations
 * the contact the user wants is often offscreen, so a client-only filter
 * can't find it. This hook fires a debounced server query and exposes the
 * matches as a separate result set; the inbox swaps the list when active.
 *
 * Snapshot semantics: realtime events keep mutating the live list in the
 * background, but search results are NOT re-evaluated when new inbound
 * messages arrive. The user re-types or clears the box to refresh. Doing
 * a live-search subscription would mean re-running the LIKE query on
 * every team event — wasteful and unnecessary for an investigative gesture.
 */
export function useConversationSearch(search: string): ConversationSearchState {
  const trimmed = search.trim();
  const active = trimmed.length > 0;

  const [results, setResults] = useState<ConversationWithRefs[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Mirror the active query into a ref so loadMore reads the latest without
  // re-creating the callback (which would churn the IntersectionObserver
  // installed by the conversation list).
  const queryRef = useRef(trimmed);
  useEffect(() => {
    queryRef.current = trimmed;
  }, [trimmed]);

  useEffect(() => {
    if (!active) {
      setResults([]);
      setNextCursor(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/conversations?search=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
      })
        .then((r) =>
          r.ok ? (r.json() as Promise<CursorPage<ConversationWithRefs>>) : null,
        )
        .then((page) => {
          if (!page) return;
          setResults(page.items);
          setNextCursor(page.nextCursor);
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          console.warn("[use-conversation-search] failed", err);
        })
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, trimmed]);

  const cursorRef = useRef(nextCursor);
  useEffect(() => {
    cursorRef.current = nextCursor;
  }, [nextCursor]);

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    const q = queryRef.current;
    if (!cursor || !q) return;
    setLoadingMore(true);
    fetch(
      `/api/conversations?search=${encodeURIComponent(q)}&cursor=${encodeURIComponent(cursor)}`,
    )
      .then((r) =>
        r.ok ? (r.json() as Promise<CursorPage<ConversationWithRefs>>) : null,
      )
      .then((page) => {
        if (!page) return;
        // Guard against a stale page arriving after the user changed the query.
        if (queryRef.current !== q) return;
        setResults((prev) => {
          const seen = new Set(prev.map((c) => c.conversation.id));
          const fresh = page.items.filter((c) => !seen.has(c.conversation.id));
          return [...prev, ...fresh];
        });
        setNextCursor(page.nextCursor);
      })
      .finally(() => setLoadingMore(false));
  }, []);

  return {
    active,
    results,
    nextCursor,
    loading,
    loadingMore,
    loadMore,
  };
}
