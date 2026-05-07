"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import type { ConversationWithRefs } from "@/lib/types";

/**
 * Holds the list of conversations and folds in incremental Socket.io events
 * so the inbox updates without a refetch.
 *
 * Server-rendered initial state seeds the list — events from the team room
 * mutate that state in place.
 */
export function useTeamEvents(
  teamId: string,
  initialConversations: ConversationWithRefs[],
): ConversationWithRefs[] {
  const [conversations, setConversations] =
    useState<ConversationWithRefs[]>(initialConversations);

  // Re-seed when the server hands us a different initial list (e.g. after
  // navigation to /inbox from another route).
  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  useEffect(() => {
    const socket = getClientSocket();
    socket.emit("subscribe:team", { teamId });

    const onMessageNew: Parameters<typeof socket.on<"message:new">>[1] = ({
      conversationId,
      preview,
      lastMessageAt,
      unreadDelta,
      message,
    }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        const updated: ConversationWithRefs = {
          ...existing,
          conversation: {
            ...existing.conversation,
            lastMessageAt,
            lastMessagePreview: preview,
            unreadCount:
              message.direction === "in"
                ? existing.conversation.unreadCount + unreadDelta
                : existing.conversation.unreadCount,
          },
        };
        // Re-sort by recency so the touched conversation jumps to the top.
        const next = [...prev];
        next.splice(idx, 1);
        next.unshift(updated);
        return next;
      });
    };

    const onAssigned: Parameters<typeof socket.on<"conversation:assigned">>[1] = ({
      conversationId,
      assignedUser,
    }) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.conversation.id === conversationId
            ? {
                ...c,
                conversation: {
                  ...c.conversation,
                  assignedUserId: assignedUser?.id ?? null,
                },
                assignedUser,
              }
            : c,
        ),
      );
    };

    const onStatus: Parameters<typeof socket.on<"conversation:status">>[1] = ({
      conversationId,
      status,
    }) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.conversation.id === conversationId
            ? { ...c, conversation: { ...c.conversation, status } }
            : c,
        ),
      );
    };

    socket.on("message:new", onMessageNew);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:status", onStatus);

    return () => {
      socket.off("message:new", onMessageNew);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:status", onStatus);
    };
  }, [teamId]);

  return conversations;
}
