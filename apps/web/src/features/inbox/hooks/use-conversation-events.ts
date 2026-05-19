"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";

import { getClientSocket } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { useCoalescedAsync } from "@/features/inbox/lib/coalesce";
import {
  applyMessageStatus,
  COALESCED_LIVE_HOOK_EVENTS,
  THREAD_REDUCER_EVENTS,
} from "@/features/inbox/lib/thread-reducers";
import type { ConversationWithRefs, CursorPage, Message } from "@ccp/shared/types";

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

/**
 * Fast path for the common case: a new inbound/outbound message lands at
 * the end of an already-sorted list. Walks back past pending/failed
 * (sortKey = ∞) entries and inserts the new message at the right boundary.
 * Falls back to a full sort if the message is out of order (rare — typically
 * only on optimistic-vs-real reconcile when the server timestamp is earlier
 * than the local one). Avoids the O(N log N) of a full Array.sort on every
 * inbound, which adds up on busy threads.
 */
function appendSorted(messages: Message[], incoming: Message): Message[] {
  if (messages.length === 0) return [incoming];
  const incomingKey = sortKey(incoming);

  // Find the index where the new message belongs. Scanning from the right is
  // ~O(1) for the dominant case (new message at/near the end), and capped at
  // O(N) for the pathological case which would also degrade a full sort.
  let insertAt = messages.length;
  while (insertAt > 0) {
    const prev = messages[insertAt - 1]!;
    if (sortKey(prev) <= incomingKey) break;
    insertAt -= 1;
  }
  if (insertAt === messages.length) {
    return [...messages, incoming];
  }
  const next = messages.slice();
  next.splice(insertAt, 0, incoming);
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
  /**
   * Signed-in agent id. Threaded into reducers via `ReducerContext` so the
   * `conversation:read` handler can distinguish "I read this" (clears my
   * per-agent `unreadForMe`) from "a teammate read this" (only clears
   * team-wide `unreadCount`).
   */
  currentUserId: string,
  // Called after the mark-read POST resolves so the shell can patch its
  // cached thread snapshot (unreadCount → 0). Without this, switching back
  // to a thread already viewed this session would re-fire the POST every
  // time MessageThread re-mounts.
  onMarkRead?: (conversationId: string) => void,
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
        const res = await fetchWithSessionGuard(
          `/api/conversations/${conversationId}/messages?before=${encodeURIComponent(cursor)}`,
        );
        if (!res.ok) return 0;
        const page = (await res.json()) as CursorPage<Message>;
        let added = 0;
        let nextSliceLen = 0;
        // Hard cap on the in-memory slice. Thread isn't virtualized today
        // (see message-thread.tsx render loop), so 500+ DOM bubbles plus a
        // LocalTime per bubble hurts scroll perf and a runaway user clicking
        // Load older 30+ times freezes the tab. Drop the cursor once we
        // cross the limit so the UI hides the "Load older" affordance. To
        // go further back the user can use search → replaceWithContext,
        // which swaps the slice rather than appending.
        const MAX_THREAD_SLICE = 500;
        // The caller's `commit` runs `run` synchronously (flushSync), so by
        // the time it returns the DOM reflects the prepend and `added` is set.
        commit(() => {
          setData((prev) => {
            const have = new Set(prev.messages.map((m) => m.id));
            const fresh = page.items.filter((m) => !have.has(m.id));
            added = fresh.length;
            if (added === 0) {
              nextSliceLen = prev.messages.length;
              return prev;
            }
            // Server returns oldest-first; sort to keep optimistic / failed
            // rows pinned at the bottom even after a prepend.
            const merged = sortByTimestamp([...fresh, ...prev.messages]);
            nextSliceLen = merged.length;
            return { ...prev, messages: merged };
          });
          // Past the slice cap → drop the cursor so the UI stops loading.
          setOlderCursor(
            nextSliceLen >= MAX_THREAD_SLICE ? null : page.nextCursor,
          );
        });
        return added;
      } finally {
        inFlightOlder.current = false;
        setLoadingOlder(false);
      }
    },
    [conversationId],
  );

  // Mark-read coordination. The shell tells us via `onMarkRead` to patch
  // the cached unreadCount=0 after the POST succeeds, so re-mounting the
  // thread (chat-switch back) finds initialUnread=0 and skips the POST.
  // Throttled via `useCoalescedAsync` — a burst of inbound messages fires
  // one POST instead of N; same util backs the team-chat hook so the
  // pattern stays consistent across both surfaces.
  const onMarkReadRef = useRef(onMarkRead);
  onMarkReadRef.current = onMarkRead;
  const markRead = useCoalescedAsync(async () => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/read`, { method: "POST" });
      if (res.ok) onMarkReadRef.current?.(conversationId);
    } catch {
      // Silent — server state reconciles on the next call / page reload.
    }
  }, [conversationId]);

  // Mark read when the thread becomes visible. The shell remounts this
  // hook on every chat switch (via key=displayedId), and on remount we read
  // initial.conversation.unreadCount from the cache — which the shell's
  // onMarkRead callback has already patched to 0 if we marked the thread
  // read earlier in this session. Net effect: at most one POST per
  // (conversation × unread-cycle), even with rapid chat switching.
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

      void fetchWithSessionGuard(
        `/api/conversations/${conversationId}/messages?after=${encodeURIComponent(cursor)}`,
      )
        .then((r) =>
          r.ok
            ? (r.json() as Promise<{
                items: Message[];
                state?: {
                  status: ConversationWithRefs["conversation"]["status"];
                  assignedUserId: string | null;
                  assignedUser: ConversationWithRefs["assignedUser"];
                  unreadCount: number;
                  unreadForMe?: boolean;
                };
              }>)
            : null,
        )
        .then((res) => {
          if (!res) return;
          const freshState = res.state;
          const freshItems = res.items ?? [];
          if (!freshState && freshItems.length === 0) return;
          setData((prev) => {
            // Re-sync the conversation header alongside any new messages.
            // Without this, an assignment/status/read flip that fired while
            // the socket was disconnected stays stuck on the stale value
            // until the agent navigates away and back. The reducer-style
            // identity-bail keeps this a no-op when nothing changed.
            let next = prev;
            if (freshState) {
              const headerChanged =
                next.conversation.status !== freshState.status ||
                next.conversation.assignedUserId !== freshState.assignedUserId ||
                next.conversation.unreadCount !== freshState.unreadCount ||
                next.conversation.unreadForMe !== freshState.unreadForMe ||
                (next.assignedUser?.id ?? null) !==
                  (freshState.assignedUser?.id ?? null);
              if (headerChanged) {
                next = {
                  ...next,
                  conversation: {
                    ...next.conversation,
                    status: freshState.status,
                    assignedUserId: freshState.assignedUserId,
                    unreadCount: freshState.unreadCount,
                    ...(freshState.unreadForMe !== undefined
                      ? { unreadForMe: freshState.unreadForMe }
                      : {}),
                  },
                  assignedUser: freshState.assignedUser,
                };
              }
            }
            if (freshItems.length === 0) return next;
            const have = new Set(next.messages.map((m) => m.externalId));
            const fresh = freshItems.filter((m) => !have.has(m.externalId));
            if (!fresh.length) return next;
            return {
              ...next,
              messages: sortByTimestamp([...next.messages, ...fresh]),
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
        // Notify the reply-box's stuck-watchdog that the confirming frame
        // arrived. Without this, the watchdog would mark the bubble as
        // failed after 30s even though the server CONFIRMED the send.
        if (tempId && typeof window !== "undefined") {
          try {
            window.dispatchEvent(new Event(`ccp:optimistic-confirmed:${tempId}`));
          } catch {
            // Synthetic events can't fail under normal conditions; ignore.
          }
        }
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

        // Reconcile into the sorted list. Two paths:
        //   - Optimistic match already in `messages` (tempId reconcile): the
        //     map() above swapped the optimistic for the server copy. The
        //     bubble's sortKey changed from ∞ to the real timestamp, so the
        //     ordering of the *whole* list might shift around that one row.
        //     Full sort.
        //   - No reconcile (fresh inbound or fresh outbound from another tab):
        //     append-sorted is O(N) worst-case but O(1) for the dominant
        //     "new message lands at the end" case. Avoids a full Array.sort
        //     per `message:new` event.
        const merged =
          tempId && messages.some((m) => m.id === payload.message.id)
            ? sortByTimestamp(messages)
            : appendSorted(messages, payload.message);
        const reconciled = merged;

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

    // Status events arrive sent → delivered → read in tight succession (often
    // 100-500ms apart, sometimes back-to-back inside one tick). Each one is
    // its own React render of the thread, so on a fresh send to a 500-msg
    // thread the user sees three renders for one bubble. Coalesce: keep the
    // latest status per messageId in a ref and flush them in one setData on
    // the next animation frame. The reducer is already monotonic (delivered
    // < read), so dropping intermediate states is safe.
    const pendingStatuses = new Map<string, Parameters<typeof applyMessageStatus>[1]>();
    let statusFlushRaf: number | null = null;
    const flushStatuses = () => {
      statusFlushRaf = null;
      if (pendingStatuses.size === 0) return;
      const batch = Array.from(pendingStatuses.values());
      pendingStatuses.clear();
      setData((prev) => {
        let next = prev;
        for (const p of batch) next = applyMessageStatus(next, p);
        return next;
      });
    };
    const onMessageStatus: Parameters<typeof socket.on<"message:status">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      pendingStatuses.set(payload.messageId, payload);
      if (statusFlushRaf === null) {
        statusFlushRaf = requestAnimationFrame(flushStatuses);
      }
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

    // The conversation we're viewing was deleted (by us, by a teammate, or as
    // a side-effect of a contact delete). Bounce back to the inbox before the
    // server-rendered detail page errors out on a missing row. router.replace
    // (not push) keeps the back button useful.
    const onConversationDeleted: Parameters<typeof socket.on<"conversation:deleted">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      router.replace("/inbox");
    };

    // `contact:updated` is now wired through THREAD_REDUCER_EVENTS
    // (target: "all" via `applyContactUpdate`) so the same reducer drives
    // both this live state and the LRU snapshots in inbox-shell. Don't
    // re-bind it here — the iterated loop below handles it.

    // Background send-worker reported a failure. Map to the same
    // markOptimisticFailed reducer the pre-S1 inline HTTP-error path used,
    // so the bubble flips from `pending` to `failed` with a Retry button.
    // The toast lives in reply-box (HTTP-side); we just update the bubble.
    const onMessageFailed: Parameters<typeof socket.on<"message:failed">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      if (!payload.clientTempId) return; // nothing to match against
      setData((prev) => ({
        ...prev,
        messages: prev.messages.map((m) =>
          m.clientTempId === payload.clientTempId && m.pending
            ? { ...m, pending: false, failed: true }
            : m,
        ),
      }));
    };

    socket.on("message:new", onMessageNew);
    // message:status is in COALESCED_LIVE_HOOK_EVENTS — the live hook RAF-
    // coalesces it (sent/delivered/read transitions cascade in bursts and a
    // React render per arrival pinned the inbox CPU during broadcasts). The
    // reducer itself is still shared via THREAD_REDUCER_EVENTS so the
    // cached-shell consumer applies the same logic without RAF batching.
    socket.on("message:status", onMessageStatus);
    socket.on("message:failed", onMessageFailed);
    socket.on("note:new", onNoteNew);
    socket.on("conversation:deleted", onConversationDeleted);

    // Iterated wiring — bind one direct-setData handler per reducer entry.
    // Skips events in COALESCED_LIVE_HOOK_EVENTS (declared in thread-reducers.ts
    // as the structural source of truth). Adding a non-coalesced entry to
    // THREAD_REDUCER_EVENTS auto-wires this hook with no edits here.
    //
    // Targeting:
    //   - target: "conversation" (default) — payload.conversationId narrows
    //     to this hook's thread.
    //   - target: "all" — payload has no conversationId (e.g. contact:updated
    //     fires team-wide). The reducer's own identity bail decides whether
    //     it applies to this thread.
    const reducerCtx = { currentUserId };
    const reducerHandlers = THREAD_REDUCER_EVENTS.filter(
      (e) => !COALESCED_LIVE_HOOK_EVENTS.has(e.event),
    ).map(({ event, apply, target }) => {
      const handler = (payload: { conversationId?: string } & Record<string, unknown>) => {
        // Reducer try/catch — a malformed payload from a version-skewed
        // server (post-deploy) would throw inside the setState updater
        // and break the React tree for the displayed thread. Isolate to
        // this event so the rest of the inbox keeps working.
        try {
          if ((target ?? "conversation") === "conversation") {
            if (payload?.conversationId !== conversationId) return;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setData((prev) => (apply as any)(prev, payload, reducerCtx));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[use-conversation-events] reducer for "${event}" threw`, err);
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket.on(event as any, handler as any);
      return { event, handler };
    });

    return () => {
      // Drop any pending coalesced status flush — the next mount will
      // backfill anything we missed via the `?after=...` GET.
      if (statusFlushRaf !== null) {
        cancelAnimationFrame(statusFlushRaf);
        statusFlushRaf = null;
      }
      pendingStatuses.clear();
      socket.emit("unsubscribe:conversation", { conversationId });
      socket.off("connect", onConnect);
      socket.off("message:new", onMessageNew);
      socket.off("message:status", onMessageStatus);
      socket.off("message:failed", onMessageFailed);
      socket.off("note:new", onNoteNew);
      socket.off("conversation:deleted", onConversationDeleted);
      for (const { event, handler } of reducerHandlers) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        socket.off(event as any, handler as any);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [conversationId, currentUserId, markRead, router]);

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
    setData((prev) => {
      // Free any blob: URL attached to the optimistic media before dropping
      // the row. createObjectURL'd URLs persist until revokeObjectURL is
      // called or the document is unloaded — without this revoke, dismissing
      // a failed 100MB video send and clicking Retry would leak the file
      // bytes for the lifetime of the tab. Net change is zero when the row
      // had no media or wasn't a blob: URL (e.g. an already-reconciled real
      // /api/media path).
      const toDrop = prev.messages.find((m) => m.clientTempId === clientTempId);
      const mediaUrl = toDrop?.media?.url;
      if (mediaUrl && mediaUrl.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(mediaUrl);
        } catch {
          // Ignore — already-revoked URLs throw, which is fine.
        }
      }
      return {
        ...prev,
        messages: prev.messages.filter((m) => m.clientTempId !== clientTempId),
      };
    });
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
