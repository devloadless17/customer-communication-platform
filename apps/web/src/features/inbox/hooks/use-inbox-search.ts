"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ContactSearchHit,
  GlobalMessageHit,
  InboxSearchScope,
  NoteSearchHit,
} from "@ccp/shared/dtos";

const DEBOUNCE_MS = 250;

/** Result row type for a given scope. */
export type ScopeHit<S extends InboxSearchScope> = S extends "contacts"
  ? ContactSearchHit
  : S extends "messages"
    ? GlobalMessageHit
    : NoteSearchHit;

interface Page<H> {
  items: H[];
  nextCursor: string | null;
}

export interface InboxSearchState<S extends InboxSearchScope> {
  /** True once the user has typed a non-empty query. */
  active: boolean;
  results: ScopeHit<S>[];
  nextCursor: string | null;
  /** First-page fetch in flight (drives the spinner). */
  loading: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/**
 * Debounced, paged, team-wide search for one scope of the tabbed inbox search.
 *
 * One instance per scope so each tab keeps its own results, cursor, and
 * loading state — switching tabs is instant (no refetch) and a load-more on
 * one tab can't clobber another. The query string is shared (the user types
 * once); the scope is fixed per instance.
 *
 * Request hygiene: an AbortController cancels the stale first-page fetch on
 * every keystroke, and a queryRef guards a late load-more page from appending
 * under a query the user has since changed.
 * Results are a snapshot — realtime events don't re-run the search; the user
 * re-types to refresh (a global LIKE on every team event would be wasteful).
 */
export function useInboxSearch<S extends InboxSearchScope>(
  scope: S,
  query: string,
): InboxSearchState<S> {
  type H = ScopeHit<S>;
  const trimmed = query.trim();
  const active = trimmed.length > 0;

  const [results, setResults] = useState<H[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

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
      const url = `/api/inbox/search?scope=${scope}&q=${encodeURIComponent(trimmed)}`;
      fetch(url, { signal: controller.signal })
        .then((r) => (r.ok ? (r.json() as Promise<Page<H>>) : null))
        .then((page) => {
          if (!page) return;
          setResults(page.items);
          setNextCursor(page.nextCursor);
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          console.warn(`[use-inbox-search:${scope}] failed`, err);
        })
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, trimmed, scope]);

  const cursorRef = useRef(nextCursor);
  useEffect(() => {
    cursorRef.current = nextCursor;
  }, [nextCursor]);

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    const q = queryRef.current;
    if (!cursor || !q) return;
    setLoadingMore(true);
    const url = `/api/inbox/search?scope=${scope}&q=${encodeURIComponent(q)}&cursor=${encodeURIComponent(cursor)}`;
    fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<Page<H>>) : null))
      .then((page) => {
        if (!page) return;
        // Drop a page that landed after the user changed the query.
        if (queryRef.current !== q) return;
        setResults((prev) => [...prev, ...page.items]);
        setNextCursor(page.nextCursor);
      })
      .finally(() => setLoadingMore(false));
  }, [scope]);

  return { active, results, nextCursor, loading, loadingMore, loadMore };
}
