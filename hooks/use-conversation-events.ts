"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";

import { getClientSocket } from "@/lib/socket/client";
import type { ConversationWithRefs, CursorPage, Message } from "@/lib/types";

/**
 * Canonical sort for a conversation's message slice. Server-confirmed rows
 * sort by `timestamp` ascending (the server's authoritative clock — same key
 * both sides of the conversation use). Optimistic / failed rows sort to the
 * very end so that an in-flight send always anchors at the bottom and a real
 * inbound that lands during the upload slots in chronologically — matching
 * what the customer sees on their phone (WhatsApp / iMessage / Slack all use
 * server-ack time as the canonical key for the same reason).
 *
 * Tiebreaker on `id` to keep the sort stable when two server messages share
 * a millisecond (rare; happens on a tight broadcast loop).
 */
function sortByTimestamp(messages: Message[]): Message[] {
  const next = [...messages];
  next.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) return ka - kb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return next;
}

function sortKey(m: Message): number {
  // Pending OR failed — both represent "not yet acknowledged by the server",
  // both anchor at the bottom so the user reads the optimistic / failed
  // bubble as "this is the message I tried to send right now."
  if (m.pending || m.failed) return Number.POSITIVE_INFINITY;
  return new Date(m.timestamp).getTime();
}

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

  // Mirror of `data` in a ref so the socket-connect callback can read the
  // current message slice without re-running the effect on every render
  // (which would unsubscribe + resubscribe + re-fire the backfill on each
  // mutation — chatty and racy).
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  });

  // Set when a connect (or reconnect) fired while the tab was hidden — we
  // skipped the backfill at that moment to avoid joining the thundering
  // herd, and the visibility listener will fire it the moment the user
  // returns. Lives in a ref because the connect / visibility / unmount
  // closures all need to read the same flag without re-running the effect.
  const backfillNeededRef = useRef(false);

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
            // Server returns oldest-first; sort to keep optimistic / failed
            // rows pinned at the bottom even after a prepend.
            return {
              ...prev,
              messages: sortByTimestamp([...fresh, ...prev.messages]),
            };
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
    //
    // After (re)subscribing we also fire a delta fetch — `?after=<latest
    // server timestamp>` — to close the SSR-render → socket-subscribe gap.
    // Any webhook that arrived while the JS bundle was parsing / hydrating
    // got emitted into an empty room, so without this backfill those
    // messages don't surface until the next reload or thread switch. Same
    // technique Slack RTM / Discord gateway / WhatsApp Web use on every
    // reconnect.
    const onConnect = () => {
      socket.emit("subscribe:conversation", { conversationId });

      // Skip the backfill when the tab isn't visible. A team of N agents
      // with M tabs each → N·M parallel `?after=…` queries on every Caddy
      // bounce / deploy — and most of those tabs are background or sleeping.
      // The visibility-change listener below picks the backfill back up the
      // moment the user returns to the tab.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        backfillNeededRef.current = true;
        return;
      }

      // Random jitter (0–1500ms) breaks the synchronized reconnect storm
      // after a deploy. Without it, every open tab in the team fires its
      // backfill GET at the same instant, dog-piling Postgres.
      const delay = Math.floor(Math.random() * 1500);
      window.setTimeout(() => runBackfill(), delay);
    };

    // Pulled out so the visibility-change listener below can re-fire it
    // without duplicating the closure.
    const runBackfill = () => {
      // Cursor = the most recent SERVER-confirmed message we already have.
      // Optimistic / failed rows are skipped because their `timestamp` is
      // the local clock — using one as the cursor could ask the server for
      // a window in the future and miss real inbound that happened earlier.
      const known = dataRef.current.messages;
      let cursor: string | null = null;
      for (let i = known.length - 1; i >= 0; i--) {
        const m = known[i];
        if (m && !m.pending && !m.failed) {
          cursor = m.timestamp;
          break;
        }
      }
      if (!cursor) return;

      backfillNeededRef.current = false;

      void fetch(
        `/api/conversations/${conversationId}/messages?after=${encodeURIComponent(cursor)}`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<{ items: Message[] }>) : null))
        .then((res) => {
          if (!res?.items?.length) return;
          setData((prev) => {
            const have = new Set(prev.messages.map((m) => m.externalId));
            const fresh = res.items.filter((m) => !have.has(m.externalId));
            if (!fresh.length) return prev;
            return {
              ...prev,
              messages: sortByTimestamp([...prev.messages, ...fresh]),
            };
          });
        })
        .catch(() => {
          // Silent — the next reconnect or thread navigation re-fetches
          // authoritatively via the server component. A noisy retry loop
          // here would just compound a real outage.
        });
    };

    // If a connect happened while the tab was hidden, re-run the backfill
    // when the user returns. This is what makes "open laptop after lunch"
    // recover the gap without forcing a manual reload.
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
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
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
          ? prev.messages.map((m) => {
              if (m.clientTempId !== tempId || !m.pending) return m;
              // Swap the optimistic row with the server's authoritative
              // copy so the bubble's id, externalId, status, etc. line up
              // with reality. Preserve clientTempId so the React key stays
              // stable — otherwise the DOM node unmounts and the entrance
              // animation re-fires.
              //
              // Media-url preservation: if the optimistic carried a `blob:`
              // URL, keep it across the swap rather than overwriting with
              // /api/media/<id>. The image is already painted; rewriting
              // forces the browser to refetch through the auth redirect →
              // CDN, producing a visible flicker (and the "Downloading…"
              // gap if anything below is slow). Next page load reads the
              // persisted URL via mapMessage naturally.
              //
              // If the server dropped media entirely (blob upload failed
              // server-side), keep the optimistic blob too — Meta did
              // deliver to the customer, we just can't render across
              // reloads, so don't yank the image out from under the agent
              // in the current session.
              const optimisticMedia = m.media;
              const serverMedia = payload.message.media;
              let media = serverMedia;
              if (optimisticMedia?.url.startsWith("blob:")) {
                media = serverMedia
                  ? { ...serverMedia, url: optimisticMedia.url }
                  : optimisticMedia;
              }
              return {
                ...payload.message,
                clientTempId: tempId,
                ...(media ? { media } : {}),
              };
            })
          : prev.messages;

        const merged =
          tempId && messages.some((m) => m.id === payload.message.id)
            ? messages
            : [...messages, payload.message];

        // Re-sort by server timestamp on every reconcile. This is the fix
        // for the agent-vs-customer order mismatch: while an outbound
        // upload is in flight (optimistic, sortKey = ∞) the bubble stays
        // pinned at the bottom; the moment the server confirms the send
        // we swap in the real timestamp and the message slots into its
        // chronological position — same order the customer's phone shows.
        const reconciled = sortByTimestamp(merged);

        // Inbound messages reset the 24h customer-service window. Outbound
        // doesn't — but we still bubble lastMessageAt for sort order.
        const nextLastInbound =
          payload.message.direction === "in"
            ? payload.lastMessageAt
            : prev.lastInboundAt;

        // Bump the contact-panel's "Messages" tally. Always +1 here —
        // optimistic bubbles intentionally don't count (addOptimistic
        // leaves messageCount alone), so the server-confirmed row that
        // arrives via message:new is the moment the message becomes
        // "real" for tally purposes, whether or not it reconciles with
        // an optimistic. Dedupe by externalId above already prevents
        // double-counting on Meta webhook retries.
        return {
          ...prev,
          conversation: {
            ...prev.conversation,
            lastMessageAt: payload.lastMessageAt,
            lastMessagePreview: payload.preview,
          },
          messages: reconciled,
          lastInboundAt: nextLastInbound,
          ...(prev.messageCount !== undefined
            ? { messageCount: prev.messageCount + 1 }
            : {}),
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

    // Inbound media finished downloading in the background. Swap the
    // placeholder media block (or drop it on download failure) without
    // touching the rest of the row.
    const onMessageMediaReady: Parameters<typeof socket.on<"message:media:ready">>[1] = (
      payload,
    ) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) => ({
        ...prev,
        messages: prev.messages.map((m) => {
          if (m.id !== payload.messageId) return m;
          if (payload.media) {
            return { ...m, media: payload.media, mediaPending: false };
          }
          // Download failed — strip the media block, keep the row as text.
          const { media: _media, mediaPending: _p, ...rest } = m;
          return rest;
        }),
      }));
    };

    const onNoteNew: Parameters<typeof socket.on<"note:new">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) => {
        if (prev.notes.some((n) => n.id === payload.note.id)) return prev;
        return {
          ...prev,
          notes: [...prev.notes, payload.note],
          ...(prev.noteCount !== undefined
            ? { noteCount: prev.noteCount + 1 }
            : {}),
        };
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
      setData((prev) => {
        const next = prev.notes.filter((n) => n.id !== payload.noteId);
        if (next.length === prev.notes.length) return prev;
        return {
          ...prev,
          notes: next,
          ...(prev.noteCount !== undefined
            ? { noteCount: Math.max(0, prev.noteCount - 1) }
            : {}),
        };
      });
    };

    // The conversation we're viewing was deleted (by us, by a teammate, or as
    // a side-effect of a contact delete). Bounce back to the inbox before the
    // server-rendered detail page errors out on a missing row. router.replace
    // (not push) keeps the back button useful.
    const onConversationDeleted: Parameters<typeof socket.on<"conversation:deleted">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      router.replace("/inbox");
    };

    // A teammate edited the contact on this conversation (name, email,
    // stage, tags, …). Swap in the fresh contact so the message thread's
    // stage stepper and header re-render. ContactPanel listens separately
    // because it's a sibling component with its own local mirrors.
    const onContactUpdated: Parameters<typeof socket.on<"contact:updated">>[1] = (payload) => {
      setData((prev) => {
        if (prev.contact.id !== payload.contact.id) return prev;
        return { ...prev, contact: payload.contact };
      });
    };

    socket.on("message:new", onMessageNew);
    socket.on("message:status", onMessageStatus);
    socket.on("message:media:ready", onMessageMediaReady);
    socket.on("note:new", onNoteNew);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:status", onStatus);
    socket.on("conversation:read", onRead);
    socket.on("note:deleted", onNoteDeleted);
    socket.on("conversation:deleted", onConversationDeleted);
    socket.on("contact:updated", onContactUpdated);

    return () => {
      socket.emit("unsubscribe:conversation", { conversationId });
      socket.off("connect", onConnect);
      socket.off("message:new", onMessageNew);
      socket.off("message:status", onMessageStatus);
      socket.off("message:media:ready", onMessageMediaReady);
      socket.off("note:new", onNoteNew);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:status", onStatus);
      socket.off("conversation:read", onRead);
      socket.off("note:deleted", onNoteDeleted);
      socket.off("conversation:deleted", onConversationDeleted);
      socket.off("contact:updated", onContactUpdated);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
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
      // Sort pins pending bubbles at the bottom (sortKey = ∞) regardless of
      // their local-clock timestamp, so a slow-system-clock or rapid-fire
      // send doesn't shove the new bubble above an earlier real message.
      messages: sortByTimestamp([...prev.messages, message]),
    }));
  }, []);

  const markOptimisticFailed = useCallback((clientTempId: string) => {
    setData((prev) => ({
      ...prev,
      // pending → failed keeps the same ∞ sort key, so the bubble stays
      // anchored at the bottom while the user decides to retry / dismiss.
      // The sort here is defensive: if a real message came in between
      // optimistic creation and the failure, we want the failed bubble
      // below it.
      messages: sortByTimestamp(
        prev.messages.map((m) =>
          m.clientTempId === clientTempId && m.pending
            ? { ...m, pending: false, failed: true }
            : m,
        ),
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
