"use client";

import { useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import type { ConversationWithRefs } from "@/lib/types";

/**
 * Holds the list of conversations and folds in incremental Socket.io events
 * so the inbox updates without a refetch.
 *
 * Server-rendered initial state seeds the list — events from the team room
 * mutate that state in place.
 *
 * `activeConversationId` is the thread the user is currently viewing. We use
 * it to skip the unread bump on inbound messages for that thread, so the
 * badge never flashes on a conversation you're literally reading. The thread
 * itself also POSTs mark-read, but that's a round-trip — this is the
 * zero-latency path.
 */
export function useTeamEvents(
  teamId: string,
  initialConversations: ConversationWithRefs[],
  activeConversationId: string | null = null,
): ConversationWithRefs[] {
  const [conversations, setConversations] =
    useState<ConversationWithRefs[]>(initialConversations);

  // Re-seed when the server hands us a different initial list (e.g. after
  // navigation to /inbox from another route).
  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  // Mirror activeConversationId into a ref so the message:new handler reads
  // the latest value without re-subscribing on every navigation.
  const activeIdRef = useRef(activeConversationId);
  useEffect(() => {
    activeIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    const socket = getClientSocket();
    socket.emit("subscribe:team", { teamId });

    const onMessageNew: Parameters<typeof socket.on<"message:new">>[1] = ({
      conversationId,
      preview,
      lastMessageAt,
      unreadDelta,
      message,
      newConversation,
    }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) {
          // Brand-new thread (first contact, or first inbound after a closed
          // thread). The server sends the full row; splice it in at the top.
          if (!newConversation) return prev;
          return [newConversation, ...prev];
        }
        const existing = prev[idx]!;
        // If the user is currently viewing this thread, suppress the bump —
        // the server-side mark-read will follow but this avoids a 1-tick
        // badge flash on the conversation that's already on screen.
        const isActive = activeIdRef.current === conversationId;
        const nextUnread =
          message.direction === "in" && !isActive
            ? existing.conversation.unreadCount + unreadDelta
            : existing.conversation.unreadCount;
        const updated: ConversationWithRefs = {
          ...existing,
          conversation: {
            ...existing.conversation,
            lastMessageAt,
            lastMessagePreview: preview,
            unreadCount: nextUnread,
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

    const onRead: Parameters<typeof socket.on<"conversation:read">>[1] = ({
      conversationId,
    }) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.conversation.id === conversationId &&
          c.conversation.unreadCount !== 0
            ? { ...c, conversation: { ...c.conversation, unreadCount: 0 } }
            : c,
        ),
      );
    };

    socket.on("message:new", onMessageNew);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:status", onStatus);
    socket.on("conversation:read", onRead);

    return () => {
      socket.off("message:new", onMessageNew);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:status", onStatus);
      socket.off("conversation:read", onRead);
    };
  }, [teamId]);

  return conversations;
}
