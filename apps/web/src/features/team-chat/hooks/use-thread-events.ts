"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";

/**
 * Thread side-panel state. Subscribes to:
 *   - the thread room (`channel-thread:<rootMessageId>`) for new replies
 *   - the same room for edits / deletes / reactions on replies
 *
 * The parent's main feed hook (`useTeamChannelEvents`) handles the root
 * message's own reaction / edit / delete events — this hook just owns the
 * replies. Splitting the surface keeps the panel cheap to close (one
 * effect tears down) and avoids double-applies when both surfaces see the
 * same event.
 */
export interface ThreadEventsState {
  replies: TeamChannelMessageDto[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  /** Fetch the next page of replies forward in time. Idempotent while
   *  in-flight — concurrent calls return 0 immediately. */
  loadMore: () => Promise<number>;
  addOptimistic: (m: TeamChannelMessageDto) => void;
  markOptimisticFailed: (clientTempId: string) => void;
  removeOptimistic: (clientTempId: string) => void;
}

export function useThreadEvents(
  channelId: string,
  rootMessageId: string,
): ThreadEventsState {
  const [replies, setReplies] = useState<TeamChannelMessageDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const inFlightRef = useRef(false);
  // Per-(message,emoji) last applied version stamp — see `onReaction`.
  const lastReactionVersionsRef = useRef(new Map<string, number>());

  // Hydrate when the root changes (user clicked a different message's
  // thread). Fresh fetch — replies aren't kept across roots.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReplies([]);
    setNextCursor(null);
    void fetchWithSessionGuard(
      `/api/team/channels/${channelId}/messages/${rootMessageId}/thread`,
    )
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              items: TeamChannelMessageDto[];
              nextCursor: string | null;
            }>)
          : null,
      )
      .then((res) => {
        if (cancelled || !res?.items) return;
        setReplies(res.items);
        setNextCursor(res.nextCursor);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, rootMessageId]);

  const loadMore = useCallback(async (): Promise<number> => {
    if (!nextCursor || inFlightRef.current) return 0;
    inFlightRef.current = true;
    setLoadingMore(true);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages/${rootMessageId}/thread?after=${encodeURIComponent(nextCursor)}`,
      );
      if (!res.ok) return 0;
      const page = (await res.json()) as {
        items: TeamChannelMessageDto[];
        nextCursor: string | null;
      };
      let added = 0;
      setReplies((prev) => {
        const have = new Set(prev.map((m) => m.id));
        const fresh = page.items.filter((m) => !have.has(m.id));
        added = fresh.length;
        if (added === 0) return prev;
        return [...prev, ...fresh];
      });
      setNextCursor(page.nextCursor);
      return added;
    } finally {
      inFlightRef.current = false;
      setLoadingMore(false);
    }
  }, [channelId, rootMessageId, nextCursor]);

  useEffect(() => {
    const socket = getClientSocket();

    // Thread events ride the channel's team-room frames and are filtered
    // here by `threadRootId === rootMessageId`. The dedicated thread room
    // was removed — nothing on the server targeted it.
    const onConnect = () => {
      // no-op kept for symmetry with sibling event hooks; the channel
      // subscribe is owned by use-team-channel-events.
    };

    const onMessage: Parameters<typeof socket.on<"team:channel:message">>[1] = (payload) => {
      // Only listen for replies into THIS thread. Top-level + other threads
      // bounce off here cleanly.
      if (payload.message.threadRootId !== rootMessageId) return;
      setReplies((prev) => {
        if (prev.some((m) => m.id === payload.message.id)) return prev;
        const tempId = payload.clientTempId;
        const next = tempId
          ? prev.map((m) =>
              m.clientTempId === tempId && m.pending
                ? { ...payload.message, clientTempId: tempId }
                : m,
            )
          : prev;
        return tempId && next.some((m) => m.id === payload.message.id)
          ? next
          : [...next, payload.message];
      });
    };

    // findIndex + bail pattern: edit/reaction events from the same channel
    // fire on every reply hook AND every other-thread reply hook AND the
    // main feed hook simultaneously. Most won't match this specific thread
    // — bail before the map allocation to keep React's setState from
    // re-rendering the thread side panel for every unrelated edit.
    const onEdited: Parameters<typeof socket.on<"team:channel:message:edited">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      setReplies((prev) => {
        const idx = prev.findIndex((m) => m.id === payload.messageId);
        if (idx === -1) return prev;
        const next = prev.slice();
        next[idx] = { ...prev[idx]!, body: payload.body, editedAt: payload.editedAt };
        return next;
      });
    };

    const onDeleted: Parameters<typeof socket.on<"team:channel:message:deleted">>[1] = (
      payload,
    ) => {
      if (payload.threadRootId !== rootMessageId) return;
      setReplies((prev) => {
        const idx = prev.findIndex((m) => m.id === payload.messageId);
        if (idx === -1) return prev;
        const next = prev.slice();
        next.splice(idx, 1);
        return next;
      });
    };

    const reactionVersionsRef = lastReactionVersionsRef.current;
    const onReaction: Parameters<typeof socket.on<"team:channel:reaction:changed">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      const key = `${payload.messageId}::${payload.emoji}`;
      const lastVersion = reactionVersionsRef.get(key) ?? 0;
      // Same out-of-order discard as use-team-channel-events.
      if (payload.version <= lastVersion) return;
      reactionVersionsRef.set(key, payload.version);
      setReplies((prev) => {
        const idx = prev.findIndex((m) => m.id === payload.messageId);
        if (idx === -1) return prev;
        const m = prev[idx]!;
        const filtered = m.reactions.filter((r) => r.emoji !== payload.emoji);
        const nextReactions =
          payload.userIds.length === 0
            ? filtered
            : [...filtered, { emoji: payload.emoji, userIds: payload.userIds }];
        const next = prev.slice();
        next[idx] = { ...m, reactions: nextReactions };
        return next;
      });
    };

    socket.on("connect", onConnect);
    socket.on("team:channel:message", onMessage);
    socket.on("team:channel:message:edited", onEdited);
    socket.on("team:channel:message:deleted", onDeleted);
    socket.on("team:channel:reaction:changed", onReaction);
    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("team:channel:message", onMessage);
      socket.off("team:channel:message:edited", onEdited);
      socket.off("team:channel:message:deleted", onDeleted);
      socket.off("team:channel:reaction:changed", onReaction);
    };
  }, [channelId, rootMessageId]);

  const addOptimistic = useCallback((m: TeamChannelMessageDto) => {
    setReplies((prev) => [...prev, m]);
  }, []);

  const markOptimisticFailed = useCallback((clientTempId: string) => {
    setReplies((prev) =>
      prev.map((m) =>
        m.clientTempId === clientTempId && m.pending
          ? { ...m, pending: false, failed: true }
          : m,
      ),
    );
  }, []);

  const removeOptimistic = useCallback((clientTempId: string) => {
    setReplies((prev) => prev.filter((m) => m.clientTempId !== clientTempId));
  }, []);

  return {
    replies,
    loading,
    hasMore: nextCursor !== null,
    loadingMore,
    loadMore,
    addOptimistic,
    markOptimisticFailed,
    removeOptimistic,
  };
}
