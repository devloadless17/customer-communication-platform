"use client";

import { useEffect, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";

/**
 * Live set of teammates currently viewing the SAME conversation as the
 * caller. Filtered to exclude the local user — the header pill only paints
 * for "someone ELSE is here too."
 *
 * Server contract (apps/api/src/realtime/realtime.gateway.ts):
 *   - Server pushes `conversation:viewers` to the conversation room on
 *     every membership change AND once to the joining socket immediately
 *     after subscribe (so the pill paints without waiting for a change).
 *   - Multi-tab counted as one viewer via PresenceService.addViewer's
 *     0→1 transition gate, so a teammate's second tab doesn't blink the
 *     pill on / off.
 *
 * Client contract: a sibling `useConversationEvents` already emits
 * `subscribe:conversation` / `unsubscribe:conversation` on mount / unmount /
 * reconnect — we don't re-subscribe here. We only listen.
 *
 * State holds JUST the userIds. Resolving id → User happens in the caller
 * so the same teamMembers Map already memoized in MessageThread is reused
 * (no second lookup, no stale-name risk).
 */
export function useConversationViewers(
  conversationId: string,
  currentUserId: string,
): string[] {
  const [otherViewerIds, setOtherViewerIds] = useState<string[]>([]);

  useEffect(() => {
    setOtherViewerIds([]);

    const socket = getClientSocket();
    const onViewers: Parameters<typeof socket.on<"conversation:viewers">>[1] = (
      payload,
    ) => {
      if (payload.conversationId !== conversationId) return;
      // Filter self out. Don't sort here — the server's snapshot order is
      // stable (Map insertion = subscribe order) and stable order keeps the
      // pill avatars from reshuffling on every change.
      const others = payload.viewerUserIds.filter((id) => id !== currentUserId);
      setOtherViewerIds((prev) => {
        // Identity-preserve on no-op so the consumer's memoized
        // Avatar map doesn't re-render on every keystroke from the
        // SAME viewer set.
        if (
          prev.length === others.length &&
          prev.every((id, i) => id === others[i])
        ) {
          return prev;
        }
        return others;
      });
    };

    socket.on("conversation:viewers", onViewers);
    return () => {
      socket.off("conversation:viewers", onViewers);
    };
  }, [conversationId, currentUserId]);

  return otherViewerIds;
}
