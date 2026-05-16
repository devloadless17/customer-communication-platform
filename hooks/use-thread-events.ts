"use client";

import { useCallback, useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket/client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import type { TeamChannelMessageDto } from "@/lib/team-chat/types";

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

  // Hydrate when the root changes (user clicked a different message's
  // thread). Fresh fetch — replies aren't kept across roots.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReplies([]);
    void fetchWithSessionGuard(
      `/api/team/channels/${channelId}/messages/${rootMessageId}/thread`,
    )
      .then((r) => (r.ok ? (r.json() as Promise<{ items: TeamChannelMessageDto[] }>) : null))
      .then((res) => {
        if (cancelled || !res?.items) return;
        setReplies(res.items);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, rootMessageId]);

  useEffect(() => {
    const socket = getClientSocket();

    const onConnect = () => {
      socket.emit("subscribe:channel-thread", { rootMessageId });
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

    const onEdited: Parameters<typeof socket.on<"team:channel:message:edited">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      setReplies((prev) =>
        prev.map((m) =>
          m.id === payload.messageId
            ? { ...m, body: payload.body, editedAt: payload.editedAt }
            : m,
        ),
      );
    };

    const onDeleted: Parameters<typeof socket.on<"team:channel:message:deleted">>[1] = (
      payload,
    ) => {
      if (payload.threadRootId !== rootMessageId) return;
      setReplies((prev) => prev.filter((m) => m.id !== payload.messageId));
    };

    const onReaction: Parameters<typeof socket.on<"team:channel:reaction:changed">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      setReplies((prev) =>
        prev.map((m) => {
          if (m.id !== payload.messageId) return m;
          const filtered = m.reactions.filter((r) => r.emoji !== payload.emoji);
          if (payload.userIds.length === 0) return { ...m, reactions: filtered };
          return {
            ...m,
            reactions: [...filtered, { emoji: payload.emoji, userIds: payload.userIds }],
          };
        }),
      );
    };

    socket.on("connect", onConnect);
    socket.on("team:channel:message", onMessage);
    socket.on("team:channel:message:edited", onEdited);
    socket.on("team:channel:message:deleted", onDeleted);
    socket.on("team:channel:reaction:changed", onReaction);
    if (socket.connected) onConnect();

    return () => {
      socket.emit("unsubscribe:channel-thread", { rootMessageId });
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

  return { replies, loading, addOptimistic, markOptimisticFailed, removeOptimistic };
}
