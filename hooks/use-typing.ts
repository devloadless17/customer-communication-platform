"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket/client";

/**
 * Two-way typing state for one conversation.
 *
 * `notifyTyping()` is called from the reply box on each keystroke; we
 * coalesce into one `typing:start` per agent and auto-`typing:stop` after
 * a short idle window so a tab close (which the server sees) and a "user
 * walked away" (which it doesn't) both clean up.
 *
 * `typingUsers` is the set of *other* teammates currently typing — the
 * caller's own userId is filtered out before render.
 */
export function useTyping(
  conversationId: string,
  selfUserId: string,
): { typingUserIds: string[]; notifyTyping: () => void; stopTyping: () => void } {
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const startedRef = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTyping = useCallback(() => {
    if (!startedRef.current) return;
    startedRef.current = false;
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    getClientSocket().emit("typing:stop", { conversationId });
  }, [conversationId]);

  const notifyTyping = useCallback(() => {
    const socket = getClientSocket();
    if (!startedRef.current) {
      startedRef.current = true;
      socket.emit("typing:start", { conversationId });
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      startedRef.current = false;
      idleTimer.current = null;
      socket.emit("typing:stop", { conversationId });
    }, 4000);
  }, [conversationId]);

  useEffect(() => {
    const socket = getClientSocket();

    const onUpdate: Parameters<typeof socket.on<"typing:update">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setTypingUserIds(payload.typingUserIds.filter((id) => id !== selfUserId));
    };
    socket.on("typing:update", onUpdate);

    return () => {
      socket.off("typing:update", onUpdate);
      // Leaving the thread should clear our typing flag — server also clears
      // on unsubscribe:conversation, but doing it here too means the local
      // ref state matches before the socket round-trip.
      stopTyping();
    };
  }, [conversationId, selfUserId, stopTyping]);

  return { typingUserIds, notifyTyping, stopTyping };
}
