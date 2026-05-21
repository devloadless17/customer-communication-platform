"use client";

import { useEffect, useRef } from "react";

/**
 * Auto-load-more via IntersectionObserver. Attach the returned ref to a
 * sentinel element at the end of a list; `onLoadMore` fires whenever the
 * sentinel scrolls into view (within `rootMargin`).
 *
 * `onLoadMore` is expected to be self-guarding (a no-op while a page is
 * already in flight) — the contacts `loadMore` already bails on
 * `loadingMore`, so re-firing while visible is harmless.
 *
 * Pass `root` for lists that scroll inside their own `overflow-y-auto`
 * container (e.g. the picker modal) so the prefetch margin is measured
 * against that container instead of the viewport.
 */
export function useInfiniteScroll<T extends HTMLElement = HTMLDivElement>({
  hasMore,
  onLoadMore,
  root,
  rootMargin = "300px",
}: {
  hasMore: boolean;
  onLoadMore: () => void;
  root?: React.RefObject<HTMLElement | null>;
  rootMargin?: string;
}) {
  const sentinelRef = useRef<T>(null);
  const cb = useRef(onLoadMore);
  cb.current = onLoadMore;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb.current();
      },
      { root: root?.current ?? null, rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, root, rootMargin]);

  return sentinelRef;
}
