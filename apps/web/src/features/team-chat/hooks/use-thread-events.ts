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
  /** User ids currently typing in THIS thread (excludes the viewer). The
   *  caller renders names via the team-members map. */
  typingUserIds: string[];
}

export function useThreadEvents(
  channelId: string,
  rootMessageId: string,
  // Fired when the thread ROOT itself is deleted (by its author or an admin,
  // possibly in another tab/by another user). The server emits
  // `team:channel:message:deleted` with `threadRootId: null` for a top-level
  // delete and the DB cascades every reply — the panel must close rather than
  // sit on a dead root (replies into it would 404).
  onRootDeleted?: () => void,
): ThreadEventsState {
  const [replies, setReplies] = useState<TeamChannelMessageDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const inFlightRef = useRef(false);
  // Per-(message,emoji) last applied version stamp — see `onReaction`.
  const lastReactionVersionsRef = useRef(new Map<string, number>());
  // Keep the root-deleted callback on a ref so the socket effect (which only
  // re-binds on [channelId, rootMessageId]) reads the latest closure without
  // re-subscribing on every parent render.
  const onRootDeletedRef = useRef(onRootDeleted);
  useEffect(() => {
    onRootDeletedRef.current = onRootDeleted;
  });

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

    // Thread events ride the CHANNEL room's frames (membership-gated at
    // subscribe:channel, so non-members never receive thread content) and are
    // filtered here by `threadRootId === rootMessageId`. There is no dedicated
    // thread room — nothing on the server targets one.

    // Reconnect convergence. A drop longer than the 30s recovery window —
    // during which a teammate posted/edited/deleted a reply in THIS thread —
    // would leave the panel stale (the live handlers below missed those frames),
    // so on a genuine RECONNECT we refetch + replace, preserving the user's own
    // in-flight optimistic replies.
    //
    // `firstConnect` / `cancelled` are EFFECT-LOCAL (the effect re-runs on
    // [channelId, rootMessageId], so a thread switch gives a fresh pair):
    //  - firstConnect skips the synchronous `if (socket.connected) onConnect()`
    //    mount/switch call below — the hydrate effect already loads the thread,
    //    so refetching there would be a redundant double-GET.
    //  - cancelled (set in cleanup) discards a slow in-flight refetch after a
    //    switch, so a late thread-X response can't write into thread-Y's panel.
    let firstConnect = true;
    let cancelled = false;
    const onConnect = () => {
      if (firstConnect) {
        firstConnect = false;
        return;
      }
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
          setReplies((prev) => {
            const serverIds = new Set(res.items.map((m) => m.id));
            const keptOptimistic = prev.filter(
              (m) => (m.pending || m.failed) && !serverIds.has(m.id),
            );
            return [...res.items, ...keptOptimistic];
          });
          setNextCursor(res.nextCursor);
        })
        .catch(() => {});
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
      if (payload.channelId !== channelId) return;
      // The ROOT of this thread was deleted (top-level delete → threadRootId
      // null, messageId === our root). The DB cascades all replies; the panel
      // can't stay open on a dead root (replies would 404). Tell the parent
      // to close it. Checked BEFORE the reply-delete branch because a root
      // delete carries `threadRootId: null`, which the reply branch ignores.
      if (payload.threadRootId === null && payload.messageId === rootMessageId) {
        onRootDeletedRef.current?.();
        return;
      }
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
      // Same rule as use-team-channel-events: gate ONLY optimistic frames by
      // version; always apply the authoritative server frame (it's the full DB
      // snapshot) while still recording its version.
      if (payload.optimistic && payload.version <= lastVersion) return;
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

    const onTyping: Parameters<typeof socket.on<"team:channel:thread:typing:update">>[1] = (
      payload,
    ) => {
      if (payload.threadRootId !== rootMessageId) return;
      setTypingUserIds(payload.typingUserIds);
    };

    socket.on("connect", onConnect);
    socket.on("team:channel:message", onMessage);
    socket.on("team:channel:message:edited", onEdited);
    socket.on("team:channel:message:deleted", onDeleted);
    socket.on("team:channel:reaction:changed", onReaction);
    socket.on("team:channel:thread:typing:update", onTyping);
    if (socket.connected) onConnect();

    return () => {
      // Discard any in-flight reconnect refetch so a slow response from THIS
      // (channel, root) can't write into the next thread after a switch.
      cancelled = true;
      socket.off("connect", onConnect);
      socket.off("team:channel:message", onMessage);
      socket.off("team:channel:message:edited", onEdited);
      socket.off("team:channel:message:deleted", onDeleted);
      socket.off("team:channel:reaction:changed", onReaction);
      socket.off("team:channel:thread:typing:update", onTyping);
      // Clear stale snapshot so reopening the same thread later starts
      // from a fresh state instead of last-seen typers.
      setTypingUserIds([]);
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
    typingUserIds,
  };
}
