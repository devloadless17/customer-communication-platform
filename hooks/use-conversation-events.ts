"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";

import { getClientSocket } from "@/lib/socket-client";
import type { ConversationWithRefs, CursorPage, Message } from "@/lib/types";

export interface ConversationEventsState {
  data: ConversationWithRefs;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  /**
   * Fetch and prepend the next older page. Returns the number of messages
   * prepended (0 if there was nothing more, the page was a no-op, or a fetch
   * was already in flight).
   *
   * `commit` wraps the DOM mutation: it's called with a `run` function that
   * applies the prepend, and is expected to invoke it synchronously (default:
   * `flushSync`). The thread passes a wrapper that brackets `run` with a
   * scroll-position measurement and restore so the prepend is invisible — the
   * messages under the user's eyes don't shift by a single pixel.
   */
  loadOlder: (commit?: (run: () => void) => void) => Promise<number>;
  /**
   * Append an optimistic outbound message. Caller passes a fully-formed
   * Message with `clientTempId` set + `pending: true`. When the matching
   * `message:new` arrives via socket, we swap it in place.
   */
  addOptimistic: (message: Message) => void;
  /** Mark an in-flight optimistic message as failed so the user sees the error. */
  markOptimisticFailed: (clientTempId: string) => void;
  /** Drop a failed optimistic bubble (e.g. on retry or dismiss). */
  removeOptimistic: (clientTempId: string) => void;
  /**
   * Replace the current message slice with a windowed context around a
   * target (search-jump). Called by MessageSearch after fetching
   * /messages/context — lets the UI jump to a hit that lives outside the
   * loaded slice without paginating through every older page.
   *
   * `nextOlderCursor` becomes the new "load older" anchor; setting it null
   * disables further upward pagination if the window already reaches the
   * start of the conversation.
   */
  replaceWithContext: (input: {
    messages: Message[];
    nextOlderCursor: string | null;
  }) => void;
}

/**
 * Per-thread state. Holds messages + notes for a single conversation and
 * folds in events scoped to its room.
 *
 * Pagination: caller hands us the most recent N messages plus a cursor for
 * the next-older page. `loadOlder()` fetches and prepends; new realtime
 * messages arrive at the end via socket events. Cursor is keyset on
 * `(timestamp, id)` so concurrent inserts can't shift our window.
 *
 * Side effect: marks the conversation read whenever the user is viewing it
 * (on mount and on each inbound message). The server zeros the team-wide
 * unread counter and broadcasts `conversation:read`, which the team-events
 * hook uses to clear the badge in the inbox list.
 */
export function useConversationEvents(
  initial: ConversationWithRefs,
  initialNextOlderCursor: string | null,
): ConversationEventsState {
  const router = useRouter();
  const [data, setData] = useState<ConversationWithRefs>(initial);
  const [olderCursor, setOlderCursor] = useState<string | null>(initialNextOlderCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Render-time prop sync. Using useEffect for this leaves a paint cycle where
  // MessageThread renders the OLD conversation's messages under the NEW URL —
  // visible as a flash when switching chats. React processes state updates
  // dispatched during render in the same commit, so the swap is atomic.
  const [trackedId, setTrackedId] = useState(initial.conversation.id);
  if (trackedId !== initial.conversation.id) {
    setTrackedId(initial.conversation.id);
    setData(initial);
    setOlderCursor(initialNextOlderCursor);
  }

  const conversationId = initial.conversation.id;

  // Keep latest cursor in a ref so loadOlder can stay reference-stable.
  const cursorRef = useRef(olderCursor);
  useEffect(() => {
    cursorRef.current = olderCursor;
  }, [olderCursor]);

  const inFlightOlder = useRef(false);
  const loadOlder = useCallback(
    async (commit: (run: () => void) => void = flushSync): Promise<number> => {
      const cursor = cursorRef.current;
      if (!cursor || inFlightOlder.current) return 0;
      inFlightOlder.current = true;
      setLoadingOlder(true);
      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/messages?before=${encodeURIComponent(cursor)}`,
        );
        if (!res.ok) return 0;
        const page = (await res.json()) as CursorPage<Message>;
        let added = 0;
        // The caller's `commit` runs `run` synchronously (flushSync), so by
        // the time it returns the DOM reflects the prepend and `added` is set.
        commit(() => {
          setData((prev) => {
            const have = new Set(prev.messages.map((m) => m.id));
            const fresh = page.items.filter((m) => !have.has(m.id));
            added = fresh.length;
            if (added === 0) return prev;
            // Server returns oldest-first; prepend in order.
            return { ...prev, messages: [...fresh, ...prev.messages] };
          });
          setOlderCursor(page.nextCursor);
        });
        return added;
      } finally {
        inFlightOlder.current = false;
        setLoadingOlder(false);
      }
    },
    [conversationId],
  );

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
  // Skip when the server already says unreadCount is zero so we don't fan
  // out a needless POST + team-wide `conversation:read` broadcast on every
  // navigation.
  const initialUnread = initial.conversation.unreadCount;
  useEffect(() => {
    if (initialUnread > 0) void markRead();
  }, [markRead, initialUnread]);

  useEffect(() => {
    const socket = getClientSocket();

    // Re-(sub)subscribe on every connect — the first one covers the initial
    // subscription, every subsequent one covers a reconnect after a drop
    // longer than Socket.io's connectionStateRecovery window. Without this,
    // events for this thread silently stop arriving until the user reloads.
    // Note: messages that landed during the drop are NOT backfilled here —
    // navigating away and back re-fetches them via the server component.
    const onConnect = () => {
      socket.emit("subscribe:conversation", { conversationId });
    };
    socket.on("connect", onConnect);
    if (socket.connected) onConnect();

    const onMessageNew: Parameters<typeof socket.on<"message:new">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) => {
        // Dedupe by externalId — webhook retries can fire the same wamid twice.
        if (prev.messages.some((m) => m.externalId === payload.message.externalId)) {
          return prev;
        }

        // Reconcile against any optimistic bubble we put up for this send.
        // Match by clientTempId when present; otherwise just append.
        const tempId = payload.clientTempId;
        const messages = tempId
          ? prev.messages.map((m) =>
              m.clientTempId === tempId && m.pending
                ? // Swap the optimistic row with the server's authoritative
                  // copy so the bubble's id, externalId, status, and media URL
                  // line up with reality. Preserve clientTempId on the
                  // confirmed row so the React key stays stable across the
                  // swap — otherwise the DOM node unmounts and the entrance
                  // animation re-fires, producing a brief flicker.
                  { ...payload.message, clientTempId: tempId }
                : m,
            )
          : prev.messages;

        const reconciled =
          tempId && messages.some((m) => m.id === payload.message.id)
            ? messages
            : [...messages, payload.message];

        // Inbound messages reset the 24h customer-service window. Outbound
        // doesn't — but we still bubble lastMessageAt for sort order.
        const nextLastInbound =
          payload.message.direction === "in"
            ? payload.lastMessageAt
            : prev.lastInboundAt;

        return {
          ...prev,
          conversation: {
            ...prev.conversation,
            lastMessageAt: payload.lastMessageAt,
            lastMessagePreview: payload.preview,
          },
          messages: reconciled,
          lastInboundAt: nextLastInbound,
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

    const onNoteDeleted: Parameters<typeof socket.on<"note:deleted">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) => ({
        ...prev,
        notes: prev.notes.filter((n) => n.id !== payload.noteId),
      }));
    };

    // The conversation we're viewing was deleted (by us, by a teammate, or as
    // a side-effect of a contact delete). Bounce back to the inbox before the
    // server-rendered detail page errors out on a missing row. router.replace
    // (not push) keeps the back button useful.
    const onConversationDeleted: Parameters<typeof socket.on<"conversation:deleted">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      router.replace("/inbox");
    };

    socket.on("message:new", onMessageNew);
    socket.on("message:status", onMessageStatus);
    socket.on("note:new", onNoteNew);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:status", onStatus);
    socket.on("conversation:read", onRead);
    socket.on("note:deleted", onNoteDeleted);
    socket.on("conversation:deleted", onConversationDeleted);

    return () => {
      socket.emit("unsubscribe:conversation", { conversationId });
      socket.off("connect", onConnect);
      socket.off("message:new", onMessageNew);
      socket.off("message:status", onMessageStatus);
      socket.off("note:new", onNoteNew);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:status", onStatus);
      socket.off("conversation:read", onRead);
      socket.off("note:deleted", onNoteDeleted);
      socket.off("conversation:deleted", onConversationDeleted);
    };
  }, [conversationId, markRead, router]);

  // -------------------------------------------------------------------------
  // Optimistic helpers — exposed to ReplyBox so a click-to-send paints the
  // bubble before the network call returns.
  // -------------------------------------------------------------------------

  const addOptimistic = useCallback((message: Message) => {
    setData((prev) => ({
      ...prev,
      conversation: {
        ...prev.conversation,
        lastMessageAt: message.timestamp,
        lastMessagePreview: (message.body || "").slice(0, 200),
      },
      messages: [...prev.messages, message],
    }));
  }, []);

  const markOptimisticFailed = useCallback((clientTempId: string) => {
    setData((prev) => ({
      ...prev,
      messages: prev.messages.map((m) =>
        m.clientTempId === clientTempId && m.pending
          ? { ...m, pending: false, failed: true }
          : m,
      ),
    }));
  }, []);

  const removeOptimistic = useCallback((clientTempId: string) => {
    setData((prev) => ({
      ...prev,
      messages: prev.messages.filter((m) => m.clientTempId !== clientTempId),
    }));
  }, []);

  const replaceWithContext = useCallback(
    (input: { messages: Message[]; nextOlderCursor: string | null }) => {
      setData((prev) => ({ ...prev, messages: input.messages }));
      setOlderCursor(input.nextOlderCursor);
    },
    [],
  );

  return {
    data,
    hasMoreOlder: olderCursor !== null,
    loadingOlder,
    loadOlder,
    addOptimistic,
    markOptimisticFailed,
    removeOptimistic,
    replaceWithContext,
  };
}
