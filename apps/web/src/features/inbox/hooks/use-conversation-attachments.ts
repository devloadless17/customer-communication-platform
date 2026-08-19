"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { getClientSocket } from "@/lib/socket-client";
import type { CursorPage, Message } from "@ccp/shared/types";

export type AttachmentKind = "image" | "video" | "audio" | "document";

interface State {
  items: Message[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

const INITIAL: State = {
  items: [],
  nextCursor: null,
  loading: true,
  loadingMore: false,
  error: null,
};

/**
 * Per-conversation media list for the "Files" tab. Keyset-paginated (the
 * server matches the thread's compound `(timestamp DESC, id DESC)` order so
 * a thumbnail's position is stable across pages).
 *
 *   - Refetches the first page when `conversationId` or `kind` changes.
 *   - Listens to `message:new` / `message:media:ready` for the active
 *     conversation and re-fetches the first page so a freshly-sent or just-
 *     downloaded media row appears live without a refresh.
 *   - Silently no-ops with an empty list when `conversationId` is null
 *     (the panel is rendered for a closing thread or a transitional state).
 */
export function useConversationAttachments(
  conversationId: string | null,
  kind: AttachmentKind | null,
): {
  items: Message[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
} {
  const [state, setState] = useState<State>(INITIAL);
  // TWO controllers, deliberately. Page-1 fetches ("replace" / "silent") share
  // one — a newer one supersedes an older because both write page 1 — while
  // "load more" gets its own. `silent` is driven by live socket frames, so one
  // shared controller let inbound traffic the agent never triggered abort their
  // in-flight Load-more page, which then silently never arrived. An append is
  // additive and cannot stale-overwrite, so nothing but a reset needs to cancel
  // it. Both are aborted on chat-switch / kind-change / unmount so a slow
  // request doesn't land into the next view.
  const controllerRef = useRef<AbortController | null>(null);
  const appendControllerRef = useRef<AbortController | null>(null);

  // Fetch modes:
  //   "replace" — chat-switch / kind-change / manual refresh: reset to a
  //               loading skeleton and swap in page 1.
  //   "append"  — load-more: append the next keyset page.
  //   "silent"  — live socket refetch (message:new / media:ready): MERGE page
  //               1 into the existing list WITHOUT clearing items, dropping
  //               loaded older pages, or flashing a skeleton. Preserves the
  //               nextCursor too. This is load-bearing: a "replace" here would
  //               blank an open MediaLightbox (it indexes into `items`) and
  //               collapse every loaded page back to page 1 on any inbound
  //               media frame.
  const fetchPage = useCallback(
    async (cursor: string | null, mode: "replace" | "append" | "silent") => {
      if (!conversationId) {
        setState({ ...INITIAL, loading: false });
        return;
      }
      const ctrl = new AbortController();
      if (mode === "append") {
        appendControllerRef.current?.abort();
        appendControllerRef.current = ctrl;
        setState((s) => ({ ...s, loadingMore: true }));
      } else {
        controllerRef.current?.abort();
        controllerRef.current = ctrl;
        if (mode === "replace") {
          // A reset drops the list AND the cursor, so an in-flight append is
          // stale by definition. A "silent" merge keeps both — it leaves it be.
          appendControllerRef.current?.abort();
          setState({ ...INITIAL, loading: true });
        }
      }
      // "silent": leave state untouched until the merge below — no flash.
      try {
        const params = new URLSearchParams();
        if (cursor) params.set("cursor", cursor);
        if (kind) params.set("kind", kind);
        const qs = params.size > 0 ? `?${params.toString()}` : "";
        const res = await fetchWithSessionGuard(
          `/api/conversations/${conversationId}/attachments${qs}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) throw new Error(`http_${res.status}`);
        const data = (await res.json()) as CursorPage<Message>;
        if (ctrl.signal.aborted) return;
        setState((s) => {
          if (mode === "append") {
            return {
              items: [...s.items, ...data.items],
              nextCursor: data.nextCursor,
              loading: false,
              loadingMore: false,
              error: null,
            };
          }
          if (mode === "silent") {
            // Merge page 1 into the loaded list: refresh any items the fresh
            // page also returned (e.g. a pending→ready media patch) and
            // prepend genuinely-new ones, keeping loaded older pages + the
            // existing nextCursor so pagination + an open lightbox survive.
            const freshById = new Map(data.items.map((m) => [m.id, m]));
            const existingIds = new Set(s.items.map((m) => m.id));
            const merged = s.items.map((m) => freshById.get(m.id) ?? m);
            const added = data.items.filter((m) => !existingIds.has(m.id));
            return {
              ...s,
              items: [...added, ...merged],
              loading: false,
              loadingMore: false,
              error: null,
            };
          }
          // "replace"
          return {
            items: data.items,
            nextCursor: data.nextCursor,
            loading: false,
            loadingMore: false,
            error: null,
          };
        });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setState((s) => ({
          ...s,
          loading: false,
          loadingMore: false,
          error: err instanceof Error ? err.message : "fetch failed",
        }));
      }
    },
    [conversationId, kind],
  );

  // Fetch first page on mount + whenever conversationId / kind changes.
  useEffect(() => {
    void fetchPage(null, "replace");
    return () => {
      controllerRef.current?.abort();
      appendControllerRef.current?.abort();
    };
  }, [fetchPage]);

  // Live invalidation: a new media message landed (or a pending one finished
  // downloading) for THIS conversation → refetch the first page. We don't
  // try to splice the row in by hand: the new row's position in the global
  // newest-first order is the same as page 1's first slot, and the server
  // call is one cheap round-trip. Older pages stay loaded.
  //
  // Debounced 300ms (trailing) so a burst of 4-5 media frames (e.g. a
  // customer sending 5 photos in one batch + 5 media:ready follow-ups)
  // collapses to ONE refetch instead of 10. The bubble itself paints
  // live via the main thread, so this purely-gallery refresh latency is
  // imperceptible to the agent.
  useEffect(() => {
    if (!conversationId) return;
    const socket = getClientSocket();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefetch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void fetchPage(null, "silent");
      }, 300);
    };
    const onMessageNew: Parameters<typeof socket.on<"message:new">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      if (!payload.message.media) return;
      scheduleRefetch();
    };
    const onMediaReady: Parameters<typeof socket.on<"message:media:ready">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      scheduleRefetch();
    };
    socket.on("message:new", onMessageNew);
    socket.on("message:media:ready", onMediaReady);
    return () => {
      socket.off("message:new", onMessageNew);
      socket.off("message:media:ready", onMediaReady);
      if (timer) clearTimeout(timer);
    };
  }, [conversationId, fetchPage]);

  const loadMore = useCallback(() => {
    if (state.loadingMore || !state.nextCursor) return;
    void fetchPage(state.nextCursor, "append");
  }, [fetchPage, state.loadingMore, state.nextCursor]);

  const refresh = useCallback(() => {
    void fetchPage(null, "replace");
  }, [fetchPage]);

  return {
    items: state.items,
    loading: state.loading,
    loadingMore: state.loadingMore,
    error: state.error,
    hasMore: state.nextCursor !== null,
    loadMore,
    refresh,
  };
}
