"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";

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
 *
 * Same call ALSO pings /api/conversations/:id/typing so the customer's
 * WhatsApp shows a typing bubble. That endpoint is a Meta-side indicator
 * that lasts 25s and clears when we send a message — we refresh every
 * ~20s so a long composition keeps the bubble alive without spamming.
 *
 * Meta DOES NOT expose a "stop typing" call, so once we ping, the customer
 * sees the bubble for up to 25s no matter what we do. To keep stray
 * keystrokes from pinning the customer's phone to a bubble for 25s after
 * the agent walked away, we delay the FIRST ping until the agent has been
 * typing continuously for `META_TYPING_START_DELAY_MS`. Short bursts never
 * reach Meta; sustained typing does and then refreshes itself.
 */
const META_TYPING_REFRESH_MS = 20_000;
// Hold the first Meta ping until the agent has typed continuously for this
// long, so a brief keystroke burst can't pin the customer's phone to a 25s
// typing bubble (Meta has no "stop typing" call). The whole rationale below
// is written around this 800ms window — keep them in sync.
const META_TYPING_START_DELAY_MS = 800;

export function useTyping(
  conversationId: string,
  selfUserId: string,
): {
  typingUserIds: string[];
  visitorTyping: boolean;
  /** null = unknown (no frame yet); true = visitor socket connected; false = left. */
  visitorPresent: boolean | null;
  visitorLeftAt: number | null;
  notifyTyping: () => void;
  stopTyping: () => void;
} {
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const [visitorTyping, setVisitorTyping] = useState(false);
  const [visitorPresent, setVisitorPresent] = useState<boolean | null>(null);
  const [visitorLeftAt, setVisitorLeftAt] = useState<number | null>(null);
  const visitorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMetaPingRef = useRef(0);
  const metaStartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once we've actually sent Meta a `typing_on` this session — so we only
  // send `typing_off` (to clear the customer's bubble) when there's a live one
  // to clear. A brief burst that never reached Meta needs no stop.
  const metaActiveRef = useRef(false);

  const cancelMetaStart = useCallback(() => {
    if (metaStartTimer.current) {
      clearTimeout(metaStartTimer.current);
      metaStartTimer.current = null;
    }
  }, []);

  const stopTyping = useCallback(() => {
    if (!startedRef.current) return;
    startedRef.current = false;
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    // Cancel any not-yet-fired first Meta ping. Brief typing bursts (<800ms)
    // never reach Meta, so the customer doesn't see a 25-second bubble after
    // a single keystroke.
    cancelMetaStart();
    // If we DID send a live `typing_on`, tell Meta to clear the bubble now
    // (typing_off) instead of waiting out its ~20s TTL. WhatsApp has no
    // typing_off — the server no-ops there — so this is a harmless best-effort
    // ping on every channel.
    if (metaActiveRef.current) {
      metaActiveRef.current = false;
      void apiFetch(`/api/conversations/${conversationId}/typing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: false }),
      }).catch(() => {});
    }
    getClientSocket().emit("typing:stop", { conversationId });
  }, [conversationId, cancelMetaStart]);

  const pingMetaTyping = useCallback(() => {
    // Fire-and-forget; server handles the "no inbound to anchor on" case
    // and Meta failures are logged server-side. Errors here must not pop
    // up in the agent UI — keystroke side-effect should be invisible.
    metaActiveRef.current = true;
    void apiFetch(`/api/conversations/${conversationId}/typing`, {
      method: "POST",
    }).catch(() => {});
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

    // Customer-side bubble. Two cases:
    //   1) Inside the 20s refresh window of a still-active typing session:
    //      do nothing. The previous Meta ping is still alive (~25s TTL).
    //   2) First keystroke of a new typing session, OR 20s+ since last ping:
    //      schedule a ping ~800ms out. If the agent stops typing before
    //      then, the timer is cancelled in stopTyping/idle/blur and Meta
    //      never sees a single-keystroke flicker that would commit the
    //      customer's phone to a 25s bubble.
    const now = Date.now();
    const needsFreshPing = now - lastMetaPingRef.current >= META_TYPING_REFRESH_MS;
    if (needsFreshPing && !metaStartTimer.current) {
      metaStartTimer.current = setTimeout(() => {
        metaStartTimer.current = null;
        lastMetaPingRef.current = Date.now();
        pingMetaTyping();
      }, META_TYPING_START_DELAY_MS);
    }
  }, [conversationId, pingMetaTyping]);

  useEffect(() => {
    const socket = getClientSocket();

    const onUpdate: Parameters<typeof socket.on<"typing:update">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      const others = payload.typingUserIds.filter((id) => id !== selfUserId);
      // Identity-preserve when contents are unchanged. Without this,
      // every typing:update (fired on each teammate keystroke) returns a
      // fresh array reference, re-rendering MessageThread + the whole
      // timeline pipeline even when zero teammates are typing. Pattern
      // mirrors contexts/conversation-viewers-context.tsx.
      setTypingUserIds((prev) =>
        prev.length === others.length && prev.every((id, i) => id === others[i])
          ? prev
          : others,
      );
    };
    socket.on("typing:update", onUpdate);

    // Website-widget visitor typing. The gateway relays an explicit on/off and
    // clears on disconnect, but a dropped "off" would otherwise pin the bubble,
    // so each "on" arms a safety auto-clear that a fresh "on" refreshes.
    const onVisitorTyping: Parameters<
      typeof socket.on<"conversation:visitor_typing">
    >[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      if (visitorTimer.current) {
        clearTimeout(visitorTimer.current);
        visitorTimer.current = null;
      }
      setVisitorTyping(payload.on);
      if (payload.on) {
        visitorTimer.current = setTimeout(() => setVisitorTyping(false), 8000);
      }
    };
    socket.on("conversation:visitor_typing", onVisitorTyping);

    const onVisitorPresence: Parameters<
      typeof socket.on<"conversation:visitor_presence">
    >[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setVisitorPresent(payload.present);
      // Prefer the server's leftAt (accurate for a late-opened thread and for the
      // "Away/never-seen" case where it is explicitly null); fall back to now only
      // when the field is absent (older server).
      setVisitorLeftAt(
        payload.present ? null : payload.leftAt !== undefined ? payload.leftAt : Date.now(),
      );
      if (!payload.present) setVisitorTyping(false);
    };
    socket.on("conversation:visitor_presence", onVisitorPresence);

    return () => {
      socket.off("typing:update", onUpdate);
      socket.off("conversation:visitor_typing", onVisitorTyping);
      socket.off("conversation:visitor_presence", onVisitorPresence);
      if (visitorTimer.current) {
        clearTimeout(visitorTimer.current);
        visitorTimer.current = null;
      }
      setVisitorTyping(false);
      // Leaving the thread should clear our typing flag — server also clears
      // on unsubscribe:conversation, but doing it here too means the local
      // ref state matches before the socket round-trip.
      stopTyping();
    };
  }, [conversationId, selfUserId, stopTyping]);

  return { typingUserIds, visitorTyping, visitorPresent, visitorLeftAt, notifyTyping, stopTyping };
}
