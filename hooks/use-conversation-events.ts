"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import type { ConversationWithRefs } from "@/lib/types";

/**
 * Per-thread state. Holds messages + notes for a single conversation and
 * folds in events scoped to its room.
 */
export function useConversationEvents(initial: ConversationWithRefs): ConversationWithRefs {
  const [data, setData] = useState<ConversationWithRefs>(initial);

  useEffect(() => {
    setData(initial);
  }, [initial]);

  useEffect(() => {
    const socket = getClientSocket();
    const conversationId = initial.conversation.id;
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

    socket.on("message:new", onMessageNew);
    socket.on("message:status", onMessageStatus);
    socket.on("note:new", onNoteNew);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:status", onStatus);

    return () => {
      socket.emit("unsubscribe:conversation", { conversationId });
      socket.off("message:new", onMessageNew);
      socket.off("message:status", onMessageStatus);
      socket.off("note:new", onNoteNew);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:status", onStatus);
    };
  }, [initial.conversation.id]);

  return data;
}
