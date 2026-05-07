"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import type { ConversationWithRefs } from "@/lib/types";

/**
 * Per-thread state. Holds messages + notes for a single conversation and
 * folds in events scoped to its room.
 *
 * Side effect: marks the conversation read whenever the user is viewing it
 * (on mount and on each inbound message). The server zeros the team-wide
 * unread counter and broadcasts `conversation:read`, which the team-events
 * hook uses to clear the badge in the inbox list.
 */
export function useConversationEvents(initial: ConversationWithRefs): ConversationWithRefs {
  const [data, setData] = useState<ConversationWithRefs>(initial);

  useEffect(() => {
    setData(initial);
  }, [initial]);

  const conversationId = initial.conversation.id;

  // Throttled mark-read: a burst of inbound messages must not fan out into a
  // burst of HTTP calls. While one is in flight we just remember to fire one
  // more on completion — the second call coalesces any further requests.
  const inFlight = useRef(false);
  const queued = useRef(false);
  const markRead = useCallback(async () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    try {
      await fetch(`/api/conversations/${conversationId}/read`, { method: "POST" });
    } catch {
      // Silent — server state reconciles on the next call / page reload.
    } finally {
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        void markRead();
      }
    }
  }, [conversationId]);

  // Mark read when the thread becomes visible (and again whenever the
  // conversationId changes — i.e. the user navigated to a different thread).
  useEffect(() => {
    void markRead();
  }, [markRead]);

  useEffect(() => {
    const socket = getClientSocket();
    socket.emit("subscribe:conversation", { conversationId });

    const onMessageNew: Parameters<typeof socket.on<"message:new">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) => {
        // Dedupe: webhook retries can fire the same externalId twice.
        if (prev.messages.some((m) => m.externalId === payload.message.externalId)) {
          return prev;
        }
        return {
          ...prev,
          conversation: {
            ...prev.conversation,
            lastMessageAt: payload.lastMessageAt,
            lastMessagePreview: payload.preview,
          },
          messages: [...prev.messages, payload.message],
        };
      });

      // The user is looking at this thread — bounce unread back to zero so
      // other clients clear their badge too. Inbound only; outbound doesn't
      // bump unread.
      if (payload.message.direction === "in") {
        void markRead();
      }
    };

    const onMessageStatus: Parameters<typeof socket.on<"message:status">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) => ({
        ...prev,
        messages: prev.messages.map((m) =>
          m.id === payload.messageId ? { ...m, status: payload.status } : m,
        ),
      }));
    };

    const onNoteNew: Parameters<typeof socket.on<"note:new">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) => {
        if (prev.notes.some((n) => n.id === payload.note.id)) return prev;
        return { ...prev, notes: [...prev.notes, payload.note] };
      });
    };

    const onAssigned: Parameters<typeof socket.on<"conversation:assigned">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) => ({
        ...prev,
        conversation: {
          ...prev.conversation,
          assignedUserId: payload.assignedUser?.id ?? null,
        },
        assignedUser: payload.assignedUser,
      }));
    };

    const onStatus: Parameters<typeof socket.on<"conversation:status">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) => ({
        ...prev,
        conversation: { ...prev.conversation, status: payload.status },
      }));
    };

    const onRead: Parameters<typeof socket.on<"conversation:read">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) =>
        prev.conversation.unreadCount === 0
          ? prev
          : { ...prev, conversation: { ...prev.conversation, unreadCount: 0 } },
      );
    };

    socket.on("message:new", onMessageNew);
    socket.on("message:status", onMessageStatus);
    socket.on("note:new", onNoteNew);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:status", onStatus);
    socket.on("conversation:read", onRead);

    return () => {
      socket.emit("unsubscribe:conversation", { conversationId });
      socket.off("message:new", onMessageNew);
      socket.off("message:status", onMessageStatus);
      socket.off("note:new", onNoteNew);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:status", onStatus);
      socket.off("conversation:read", onRead);
    };
  }, [conversationId, markRead]);

  return data;
}
