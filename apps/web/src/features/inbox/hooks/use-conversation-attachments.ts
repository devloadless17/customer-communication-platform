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
  // Active fetch controller — aborted on chat-switch / kind-change /
  // unmount so a slow first-page request doesn't land into the next view.
  const controllerRef = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (!conversationId) {
        setState({ ...INITIAL, loading: false });
        return;
      }
      controllerRef.current?.abort();
      const ctrl = new AbortController();
      controllerRef.current = ctrl;
      setState((s) =>
        append ? { ...s, loadingMore: true } : { ...INITIAL, loading: true },
      );
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
        setState((s) => ({
          items: append ? [...s.items, ...data.items] : data.items,
          nextCursor: data.nextCursor,
          loading: false,
          loadingMore: false,
          error: null,
        }));
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
    void fetchPage(null, false);
    return () => controllerRef.current?.abort();
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
        void fetchPage(null, false);
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
    void fetchPage(state.nextCursor, true);
  }, [fetchPage, state.loadingMore, state.nextCursor]);

  const refresh = useCallback(() => {
    void fetchPage(null, false);
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
