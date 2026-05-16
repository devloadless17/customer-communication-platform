"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket/client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import type { TeamChannelMessageDto } from "@/lib/team-chat/types";

/**
 * Per-channel state. Mirrors the pattern of `useConversationEvents`:
 *   - subscribe to the channel room on mount, unsubscribe on unmount
 *   - on (re)connect, re-subscribe + delta-fetch via `?after=<latest>`
 *   - on `team:channel:message`, append/reconcile
 *   - on `team:channel:message:edited`, patch in place
 *   - on `team:channel:message:deleted`, splice
 *   - on `team:channel:reaction:changed`, patch the reaction snapshot
 *   - on `team:channel:pin:changed`, patch `pinned`
 *   - on `team:channel:typing:update`, update the typing set
 *   - on visibility return, re-run the backfill if we skipped it earlier
 *
 * Provides `addOptimistic`, `markOptimisticFailed`, `removeOptimistic`,
 * `loadOlder` for the composer + scroller. Mark-read is debounced via the
 * /read POST — the read receipt is per-user, per-channel.
 */
export interface TeamChannelEventsState {
  messages: TeamChannelMessageDto[];
  typingUserIds: string[];
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<number>;
  addOptimistic: (m: TeamChannelMessageDto) => void;
  markOptimisticFailed: (clientTempId: string) => void;
  removeOptimistic: (clientTempId: string) => void;
}

export function useTeamChannelEvents(
  channelId: string,
  initialMessages: TeamChannelMessageDto[],
  initialNextCursor: string | null,
): TeamChannelEventsState {
  const [messages, setMessages] = useState<TeamChannelMessageDto[]>(initialMessages);
  const [olderCursor, setOlderCursor] = useState<string | null>(initialNextCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);

  // Sync from server props when the channel changes.
  const [trackedId, setTrackedId] = useState(channelId);
  if (trackedId !== channelId) {
    setTrackedId(channelId);
    setMessages(initialMessages);
    setOlderCursor(initialNextCursor);
    setTypingUserIds([]);
  }

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });

  const cursorRef = useRef(olderCursor);
  useEffect(() => {
    cursorRef.current = olderCursor;
  }, [olderCursor]);

  const backfillNeededRef = useRef(false);

  // Mark-read: throttled. Stamps the receipt to "now" so the sidebar
  // badge clears for this user across every tab.
  const inFlightRead = useRef(false);
  const queuedRead = useRef(false);
  const markRead = useCallback(async () => {
    if (inFlightRead.current) {
      queuedRead.current = true;
      return;
    }
    inFlightRead.current = true;
    try {
      await fetchWithSessionGuard(`/api/team/channels/${channelId}/read`, {
        method: "POST",
      });
    } catch {
      // Silent — reconciles on next call.
    } finally {
      inFlightRead.current = false;
      if (queuedRead.current) {
        queuedRead.current = false;
        void markRead();
      }
    }
  }, [channelId]);

  // Mark read on mount (the user just opened the channel).
  useEffect(() => {
    void markRead();
  }, [markRead]);

  const inFlightOlder = useRef(false);
  const loadOlder = useCallback(async (): Promise<number> => {
    const cursor = cursorRef.current;
    if (!cursor || inFlightOlder.current) return 0;
    inFlightOlder.current = true;
    setLoadingOlder(true);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages?before=${encodeURIComponent(cursor)}`,
      );
      if (!res.ok) return 0;
      const page = (await res.json()) as {
        items: TeamChannelMessageDto[];
        nextCursor: string | null;
      };
      let added = 0;
      setMessages((prev) => {
        const have = new Set(prev.map((m) => m.id));
        const fresh = page.items.filter((m) => !have.has(m.id));
        added = fresh.length;
        if (added === 0) return prev;
        return [...fresh, ...prev];
      });
      setOlderCursor(page.nextCursor);
      return added;
    } finally {
      inFlightOlder.current = false;
      setLoadingOlder(false);
    }
  }, [channelId]);

  useEffect(() => {
    const socket = getClientSocket();

    const onConnect = () => {
      socket.emit("subscribe:channel", { channelId });
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        backfillNeededRef.current = true;
        return;
      }
      const delay = Math.floor(Math.random() * 1500);
      window.setTimeout(() => runBackfill(), delay);
    };

    const runBackfill = () => {
      const known = messagesRef.current;
      let cursor: string | null = null;
      for (let i = known.length - 1; i >= 0; i--) {
        const m = known[i];
        if (m && !m.pending && !m.failed) {
          cursor = m.createdAt;
          break;
        }
      }
      if (!cursor) return;
      backfillNeededRef.current = false;
      void fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages?after=${encodeURIComponent(cursor)}`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<{ items: TeamChannelMessageDto[] }>) : null))
        .then((res) => {
          if (!res?.items?.length) return;
          setMessages((prev) => {
            const have = new Set(prev.map((m) => m.id));
            const fresh = res.items.filter((m) => !have.has(m.id));
            if (!fresh.length) return prev;
            return [...prev, ...fresh];
          });
        })
        .catch(() => {});
    };

    const onVisibility = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        backfillNeededRef.current &&
        socket.connected
      ) {
        runBackfill();
      }
    };

    const onMessage: Parameters<typeof socket.on<"team:channel:message">>[1] = (payload) => {
      if (payload.channelId !== channelId) return;
      // Thread replies don't surface in the main channel feed.
      if (payload.message.threadRootId !== null) return;
      setMessages((prev) => {
        // Dedupe.
        if (prev.some((m) => m.id === payload.message.id)) return prev;
        const tempId = payload.clientTempId;
        const next = tempId
          ? prev.map((m) =>
              m.clientTempId === tempId && m.pending
                ? { ...payload.message, clientTempId: tempId }
                : m,
            )
          : prev;
        const reconciled = tempId && next.some((m) => m.id === payload.message.id)
          ? next
          : [...next, payload.message];
        return reconciled;
      });
      // The user is looking at this channel — mark it read so other tabs +
      // the sidebar badge stay in lockstep.
      void markRead();
    };

    const onEdited: Parameters<typeof socket.on<"team:channel:message:edited">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      setMessages((prev) =>
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
      if (payload.channelId !== channelId) return;
      // Thread-reply deletes are handled by use-thread-events; this hook
      // only cares about top-level deletes.
      if (payload.threadRootId) return;
      setMessages((prev) => prev.filter((m) => m.id !== payload.messageId));
    };

    const onReaction: Parameters<typeof socket.on<"team:channel:reaction:changed">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== payload.messageId) return m;
          // Replace the emoji's bucket; drop the bucket entirely if empty.
          const filtered = m.reactions.filter((r) => r.emoji !== payload.emoji);
          if (payload.userIds.length === 0) {
            return { ...m, reactions: filtered };
          }
          return {
            ...m,
            reactions: [...filtered, { emoji: payload.emoji, userIds: payload.userIds }],
          };
        }),
      );
    };

    const onPin: Parameters<typeof socket.on<"team:channel:pin:changed">>[1] = (payload) => {
      if (payload.channelId !== channelId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.messageId ? { ...m, pinned: payload.pinned } : m,
        ),
      );
    };

    const onThreadReply: Parameters<typeof socket.on<"team:channel:thread:reply">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.rootMessageId
            ? {
                ...m,
                threadReplyCount: payload.replyCount,
                threadLastReplyAt: payload.lastReplyAt,
              }
            : m,
        ),
      );
    };

    const onTyping: Parameters<typeof socket.on<"team:channel:typing:update">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      setTypingUserIds(payload.typingUserIds);
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    socket.on("connect", onConnect);
    socket.on("team:channel:message", onMessage);
    socket.on("team:channel:message:edited", onEdited);
    socket.on("team:channel:message:deleted", onDeleted);
    socket.on("team:channel:reaction:changed", onReaction);
    socket.on("team:channel:pin:changed", onPin);
    socket.on("team:channel:thread:reply", onThreadReply);
    socket.on("team:channel:typing:update", onTyping);
    if (socket.connected) onConnect();

    return () => {
      socket.emit("unsubscribe:channel", { channelId });
      socket.off("connect", onConnect);
      socket.off("team:channel:message", onMessage);
      socket.off("team:channel:message:edited", onEdited);
      socket.off("team:channel:message:deleted", onDeleted);
      socket.off("team:channel:reaction:changed", onReaction);
      socket.off("team:channel:pin:changed", onPin);
      socket.off("team:channel:thread:reply", onThreadReply);
      socket.off("team:channel:typing:update", onTyping);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [channelId, markRead]);

  const addOptimistic = useCallback((m: TeamChannelMessageDto) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const markOptimisticFailed = useCallback((clientTempId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.clientTempId === clientTempId && m.pending
          ? { ...m, pending: false, failed: true }
          : m,
      ),
    );
  }, []);

  const removeOptimistic = useCallback((clientTempId: string) => {
    setMessages((prev) => prev.filter((m) => m.clientTempId !== clientTempId));
  }, []);

  return {
    messages,
    typingUserIds,
    hasMoreOlder: olderCursor !== null,
    loadingOlder,
    loadOlder,
    addOptimistic,
    markOptimisticFailed,
    removeOptimistic,
  };
}
