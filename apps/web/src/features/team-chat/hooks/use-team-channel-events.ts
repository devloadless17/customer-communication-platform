"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { getClientSocket } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { useCoalescedAsync } from "@/features/inbox/lib/coalesce";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";

/**
 * Per-channel state. Mirrors the pattern of `useConversationEvents`:
 *   - subscribe to the channel room on mount, unsubscribe on unmount
 *   - on (re)connect, re-subscribe + delta-fetch via `?after=<latest>`
 *   - on `team:channel:message`, append/reconcile
 *   - on `team:channel:message:edited`, patch in place
 *   - on `team:channel:message:deleted`, splice
 *   - on `team:channel:reaction:changed`, patch the reaction snapshot
 *   - on `team:channel:pin:changed`, patch `pinned`
 *   - on `team:channel:typing:update`, update the typing set
 *   - on visibility return, re-run the backfill if we skipped it earlier
 *
 * Provides `addOptimistic`, `markOptimisticFailed`, `removeOptimistic`,
 * `loadOlder` for the composer + scroller. Mark-read is debounced via the
 * /read POST — the read receipt is per-user, per-channel.
 */
export interface TeamChannelEventsState {
  messages: TeamChannelMessageDto[];
  typingUserIds: string[];
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  /**
   * Fetch + prepend the next older page. The optional `commit` callback lets
   * useChatScroll wrap the state update in `flushSync` between a scrollHeight
   * read and a scrollTop write, so the prepend doesn't visually jump. Default
   * is `flushSync` directly — manual "Load older" callers don't care about
   * the anchor and can pass through.
   */
  loadOlder: (commit?: (run: () => void) => void) => Promise<number>;
  /**
   * "Anchored" mode — the loaded slice doesn't include the live tail. True
   * after `loadAround()` until the user paginates forward to live (or calls
   * `goToLive()`). When true, socket-fanout new-message events DO NOT append
   * — they bump `pendingLiveCount` so the UI can offer a Jump-to-Live pill.
   */
  anchored: boolean;
  /** Whether more newer messages exist between `messages[last]` and live. */
  hasMoreNewer: boolean;
  loadingNewer: boolean;
  /** Paginate forward in time. Only meaningful while `anchored`. */
  loadNewer: () => Promise<number>;
  /**
   * Load a context window around `messageId` — used by search jump-to when
   * the target isn't in the current slice. Replaces the loaded messages and
   * enters anchored mode. Returns the messageId iff it was found; the caller
   * scrolls to it after this resolves.
   */
  loadAround: (messageId: string) => Promise<string | null>;
  /**
   * Drop anchored mode and refetch the live tail. Clears pendingLiveCount.
   * Returns the new message list length so the caller can sequence a
   * scroll-to-bottom after.
   */
  goToLive: () => Promise<void>;
  /** Count of new messages arrived via socket while anchored. */
  pendingLiveCount: number;
  addOptimistic: (m: TeamChannelMessageDto) => void;
  markOptimisticFailed: (clientTempId: string) => void;
  removeOptimistic: (clientTempId: string) => void;
  /**
   * Re-send a failed optimistic message: flip it back to `pending` and re-POST
   * the same body + clientTempId. Text-only — media retries aren't supported
   * (the original File bytes aren't retained after the first optimistic add).
   */
  retryOptimistic: (clientTempId: string) => void;
}

export function useTeamChannelEvents(
  channelId: string,
  initialMessages: TeamChannelMessageDto[],
  initialNextCursor: string | null,
  // Used to skip markRead when the incoming message is the current
  // user's own send (their optimistic confirm or a multi-tab echo).
  // Optional only to keep older call sites compiling during a refactor.
  currentUserId?: string,
): TeamChannelEventsState {
  const [messages, setMessages] = useState<TeamChannelMessageDto[]>(initialMessages);
  const [olderCursor, setOlderCursor] = useState<string | null>(initialNextCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Anchored-mode state. `null` newerCursor means "this slice ends at live"
  // — the default for a fresh channel mount, since SSR served the newest page.
  const [newerCursor, setNewerCursor] = useState<string | null>(null);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [pendingLiveCount, setPendingLiveCount] = useState(0);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);

  // First socket connection vs a genuine RECONNECT (drives the connect handler:
  // first → cheap delta backfill against the fresh SSR seed; reconnect → the
  // recoverOnReconnect full-page converge). Declared BEFORE the channel-switch
  // reset block below, which clears them so a keyless-workspace navigation is
  // treated as a first connect, not a reconnect.
  const hasConnectedOnceRef = useRef(false);
  // Set when a reconnect lands while the tab is hidden — the visibility handler
  // then runs the converge-refetch instead of the delta.
  const reconnectNeededRef = useRef(false);

  // Sync from server props when the channel changes.
  const [trackedId, setTrackedId] = useState(channelId);
  if (trackedId !== channelId) {
    setTrackedId(channelId);
    setMessages(initialMessages);
    setOlderCursor(initialNextCursor);
    setNewerCursor(null);
    setPendingLiveCount(0);
    setTypingUserIds([]);
    // CRITICAL: TeamChatWorkspace is rendered KEYLESS (team/[channelId]/page.tsx),
    // so a /team/A → /team/B navigation REUSES this hook instance (refs persist)
    // rather than remounting (unlike the inbox thread, which is key={id}). Reset
    // the connect gate so the post-switch `if (socket.connected) onConnect()`
    // (re-fired because the socket effect re-runs on channelId) is treated as a
    // FIRST connect → cheap delta runBackfill against the fresh SSR seed — NOT a
    // recoverOnReconnect full-page refetch+replace, which would fire on every
    // navigation and could clobber live socket state. Only a genuine socket
    // reconnect (no channel change) now runs recoverOnReconnect.
    hasConnectedOnceRef.current = false;
    reconnectNeededRef.current = false;
  }

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });

  // Per-(message,emoji) last applied version stamp — see `onReaction` below.
  // Stored on a ref so the handler closes over a stable mutable Map across
  // re-renders, and (crucially) keeps state across socket reconnects.
  const lastReactionVersionsRef = useRef(new Map<string, number>());

  const cursorRef = useRef(olderCursor);
  useEffect(() => {
    cursorRef.current = olderCursor;
  }, [olderCursor]);

  // Anchored-mode flag read by the socket onMessage handler — when true, new
  // tail messages are queued as `pendingLiveCount` instead of appended,
  // because the user is reading an off-tail slice. Ref so the long-lived
  // socket effect doesn't need to re-bind on every state change.
  const anchoredRef = useRef(newerCursor !== null);
  useEffect(() => {
    anchoredRef.current = newerCursor !== null;
  }, [newerCursor]);

  const backfillNeededRef = useRef(false);

  // Set when a team:channel:message frame (from someone else) lands while the
  // tab is hidden/backgrounded. markRead is DEFERRED until the tab is next
  // visible (fired by onVisibility) — a background tab parked on a channel
  // must NOT stamp the read receipt for messages nobody actually saw, or it
  // silently swallows the user's own unread dot + mention badges. Mirrors the
  // inbox's `sawInboundWhileHiddenRef` (use-conversation-events.ts).
  const sawInboundWhileHiddenRef = useRef(false);

  // Holds the pending onConnect backfill/recover timer so the socket effect's
  // cleanup can cancel it. Without this, a channel switch (A→B→C faster than the
  // 0–1500ms jitter) leaves channel A's delayed timer alive; it fires while B/C
  // is shown and its closure writes A's page into the shared messages state — a
  // transient cross-channel render until the next event corrects it.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mark-read: throttled via `useCoalescedAsync` (shared with the inbox
  // hook so the in-flight + queued pattern stays consistent). Stamps the
  // receipt to "now" so the sidebar badge clears for this user across
  // every tab. A burst of inbound channel messages fires one POST.
  const markRead = useCoalescedAsync(async () => {
    try {
      await fetchWithSessionGuard(`/api/team/channels/${channelId}/read`, {
        method: "POST",
      });
    } catch {
      // Silent — reconciles on next call.
    }
  }, [channelId]);

  // Mark read on mount (the user just opened the channel) AND again on
  // leave. The leave-side call closes the navigation-straggler race: when
  // the user clicks away, `activeChannelId` flips FIRST, so a
  // `team:channel:message` frame for THIS channel that lands in the gap
  // before this hook unmounts is no longer `isActive` and bumps the sidebar
  // dot true (use-team-channels-events.ts onMessage). `team:channel:read`
  // is one-shot per markRead, so without a follow-up markRead that bump has
  // nothing to clear it and the dot sticks until the channel is re-opened.
  // Stamping the receipt as we leave guarantees everything shown up to that
  // moment reads as read; only genuinely-newer messages (frame arriving
  // after the leave stamp) stay unread, which is correct. The cleanup
  // closes over the OLD channel's `markRead` (deps include channelId), so a
  // B→C switch marks B read, not C.
  //
  // BOTH calls are gated on `visibilityState === "visible"`: a tab opened in
  // the background (e.g. cmd-click, or restored after sleep) must NOT mark a
  // channel read before the user has actually looked at it — that would
  // swallow their unread dot + mentions. When hidden on mount we set
  // `sawInboundWhileHiddenRef` so `onVisibility` fires the deferred markRead
  // on return.
  useEffect(() => {
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      void markRead();
    } else {
      sawInboundWhileHiddenRef.current = true;
    }
    return () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void markRead();
      }
    };
  }, [markRead]);

  const inFlightOlder = useRef(false);
  const loadOlder = useCallback(
    async (commit: (run: () => void) => void = flushSync): Promise<number> => {
      const cursor = cursorRef.current;
      if (!cursor || inFlightOlder.current) return 0;
      inFlightOlder.current = true;
      setLoadingOlder(true);
      try {
        const res = await fetchWithSessionGuard(
          `/api/team/channels/${channelId}/messages?before=${encodeURIComponent(cursor)}`,
        );
        if (!res.ok) return 0;
        const page = (await res.json()) as {
          items: TeamChannelMessageDto[];
          nextCursor: string | null;
        };
        let added = 0;
        // `commit` runs `run` synchronously so by the time it returns the DOM
        // reflects the prepend — useChatScroll uses this to pin scroll
        // position between scrollHeight read and scrollTop write.
        commit(() => {
          setMessages((prev) => {
            const have = new Set(prev.map((m) => m.id));
            const fresh = page.items.filter((m) => !have.has(m.id));
            added = fresh.length;
            if (added === 0) return prev;
            return [...fresh, ...prev];
          });
          setOlderCursor(page.nextCursor);
        });
        return added;
      } finally {
        inFlightOlder.current = false;
        setLoadingOlder(false);
      }
    },
    [channelId],
  );

  /**
   * Paginate forward in anchored mode — appends the next page after the
   * loaded tail. Triggered by the bottom-sentinel observer in channel-thread.
   * When the response has no `nextCursor`, we've caught up to live: we drop
   * out of anchored mode and the pendingLiveCount queue resumes appending
   * directly via the onMessage socket handler.
   */
  const inFlightNewer = useRef(false);
  const loadNewer = useCallback(async (): Promise<number> => {
    if (!newerCursor || inFlightNewer.current) return 0;
    inFlightNewer.current = true;
    setLoadingNewer(true);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages?after=${encodeURIComponent(newerCursor)}`,
      );
      if (!res.ok) return 0;
      const page = (await res.json()) as {
        items: TeamChannelMessageDto[];
        // Server returns `nextCursor: string | null` — null means end-of-tail.
        // Was previously optional during a pre-cursor server era; now mandatory.
        nextCursor: string | null;
      };
      let added = 0;
      setMessages((prev) => {
        const have = new Set(prev.map((m) => m.id));
        const fresh = page.items.filter((m) => !have.has(m.id));
        added = fresh.length;
        if (added === 0) return prev;
        return [...prev, ...fresh];
      });
      setNewerCursor(page.nextCursor);
      // Caught up to live — drain any queued socket events the user missed
      // while anchored. The next `onMessage` event will append directly.
      if (page.nextCursor === null) setPendingLiveCount(0);
      return added;
    } finally {
      inFlightNewer.current = false;
      setLoadingNewer(false);
    }
  }, [channelId, newerCursor]);

  /**
   * Load a context window around `messageId` — replaces the loaded slice and
   * enters anchored mode. Returns the messageId iff the anchor was found
   * (caller scrolls to it after).
   */
  const inFlightAround = useRef(false);
  const loadAround = useCallback(
    async (messageId: string): Promise<string | null> => {
      if (inFlightAround.current) return null;
      inFlightAround.current = true;
      try {
        const res = await fetchWithSessionGuard(
          `/api/team/channels/${channelId}/messages/around?messageId=${encodeURIComponent(messageId)}`,
        );
        if (!res.ok) return null;
        const page = (await res.json()) as {
          items: TeamChannelMessageDto[];
          hasMoreBefore: boolean;
          hasMoreAfter: boolean;
          beforeCursor: string | null;
          afterCursor: string | null;
        };
        flushSync(() => {
          setMessages(page.items);
          setOlderCursor(page.beforeCursor);
          setNewerCursor(page.afterCursor);
          // Queue resets — we're showing a deliberate slice, not live.
          // Anything the user "missed" is past `afterCursor` and will be
          // re-counted via socket events from now on.
          setPendingLiveCount(0);
        });
        return messageId;
      } finally {
        inFlightAround.current = false;
      }
    },
    [channelId],
  );

  /**
   * Drop anchored mode: refetch the most-recent page from the server, replace
   * the loaded slice, and clear the pendingLiveCount queue. Used by the
   * "Jump to live" pill at the bottom of an anchored view.
   */
  const goToLive = useCallback(async (): Promise<void> => {
    const res = await fetchWithSessionGuard(`/api/team/channels/${channelId}/messages`);
    if (!res.ok) return;
    const page = (await res.json()) as {
      items: TeamChannelMessageDto[];
      nextCursor: string | null;
    };
    // Flip the anchored ref SYNCHRONOUSLY before the React state update.
    // Refs update immediately; the effect that syncs `anchoredRef.current`
    // from `newerCursor` runs AFTER commit, so if a tail message arrives in
    // the microsecond gap between `flushSync(setNewerCursor(null))` and
    // the effect firing, the socket handler reads `anchoredRef === true`
    // and queues the message as pending-live — leaving an invisible gap.
    anchoredRef.current = false;
    flushSync(() => {
      setMessages(page.items);
      setOlderCursor(page.nextCursor);
      setNewerCursor(null);
      setPendingLiveCount(0);
    });
  }, [channelId]);

  useEffect(() => {
    const socket = getClientSocket();

    const onConnect = () => {
      socket.emit("subscribe:channel", { channelId });
      const firstConnect = !hasConnectedOnceRef.current;
      hasConnectedOnceRef.current = true;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        backfillNeededRef.current = true;
        // Remember a reconnect so the visibility handler converges (not just
        // delta) when the tab returns.
        if (!firstConnect) reconnectNeededRef.current = true;
        return;
      }
      const delay = Math.floor(Math.random() * 1500);
      // First connect → delta backfill (SSR seed is fresh). Reconnect →
      // converge the loaded slice to server truth (the delta can't carry
      // edits/reactions/pins/deletes to already-loaded messages). Tracked in a
      // ref + cancelled on cleanup so a channel switch can't leave the prior
      // channel's timer firing into the shared messages state.
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (firstConnect) runBackfill();
        else void recoverOnReconnect();
      }, delay);
    };

    // Reconnect convergence: refetch the latest page and REPLACE the loaded
    // slice so edits/reactions/pins/deletes a teammate made while we were
    // offline are reflected (a delta-only backfill would miss them). Preserves
    // the user's own in-flight optimistic sends (pending/failed have no server
    // row yet) so they don't vanish. Skipped in anchored (search-jump) mode —
    // we don't yank the user off their slice; the delta keeps their tail fresh.
    const recoverOnReconnect = async (): Promise<void> => {
      backfillNeededRef.current = false;
      reconnectNeededRef.current = false;
      if (anchoredRef.current) {
        runBackfill();
        return;
      }
      try {
        const res = await fetchWithSessionGuard(
          `/api/team/channels/${channelId}/messages`,
        );
        if (!res.ok) {
          runBackfill();
          return;
        }
        const page = (await res.json()) as {
          items: TeamChannelMessageDto[];
          nextCursor: string | null;
        };
        setMessages((prev) => {
          const serverIds = new Set(page.items.map((m) => m.id));
          const keptOptimistic = prev.filter(
            (m) => (m.pending || m.failed) && !serverIds.has(m.id),
          );
          return [...page.items, ...keptOptimistic];
        });
        setOlderCursor(page.nextCursor);
      } catch {
        runBackfill();
      }
    };

    const runBackfill = () => {
      const known = messagesRef.current;
      let cursor: string | null = null;
      for (let i = known.length - 1; i >= 0; i--) {
        const m = known[i];
        if (m && !m.pending && !m.failed) {
          cursor = m.createdAt;
          break;
        }
      }
      if (!cursor) return;
      backfillNeededRef.current = false;
      void fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages?after=${encodeURIComponent(cursor)}`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<{ items: TeamChannelMessageDto[] }>) : null))
        .then((res) => {
          if (!res?.items?.length) return;
          setMessages((prev) => {
            const have = new Set(prev.map((m) => m.id));
            const fresh = res.items.filter((m) => !have.has(m.id));
            if (!fresh.length) return prev;
            return [...prev, ...fresh];
          });
        })
        .catch(() => {});
    };

    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        if (socket.connected) {
          // A reconnect that landed while hidden needs the full converge; a plain
          // deferred backfill (tab hidden across a live message) just needs delta.
          if (reconnectNeededRef.current) {
            void recoverOnReconnect();
          } else if (backfillNeededRef.current) {
            runBackfill();
          }
        }
        // The user is now actually looking at this channel — flush the
        // markRead we deferred while hidden (mount-while-hidden or an inbound
        // message that landed in the background). Clears their unread dot +
        // mentions now that they've genuinely seen the content.
        if (sawInboundWhileHiddenRef.current) {
          sawInboundWhileHiddenRef.current = false;
          void markRead();
        }
      }
    };

    const onMessage: Parameters<typeof socket.on<"team:channel:message">>[1] = (payload) => {
      if (payload.channelId !== channelId) return;
      // Thread replies don't surface in the main channel feed.
      if (payload.message.threadRootId !== null) return;

      const tempId = payload.clientTempId;
      // Anchored mode (search-jump active): the user is reading an off-tail
      // slice. A brand-new tail message arrived after their afterCursor and
      // must NOT be appended — the slice would visually mix recent + old
      // confusingly. Instead, bump pendingLiveCount so the Jump-to-Live pill
      // can offer one-click catch-up. Exception: the user's OWN optimistic
      // swap (matching clientTempId) must always reconcile in-place so the
      // bubble stops showing as pending — that's a confirmation of THEIR
      // send, not a brand-new tail message from someone else.
      if (anchoredRef.current && !tempId) {
        setPendingLiveCount((n) => n + 1);
        return;
      }

      setMessages((prev) => {
        // Dedupe.
        if (prev.some((m) => m.id === payload.message.id)) return prev;
        const next = tempId
          ? prev.map((m) =>
              m.clientTempId === tempId && m.pending
                ? { ...payload.message, clientTempId: tempId }
                : m,
            )
          : prev;
        const reconciled = tempId && next.some((m) => m.id === payload.message.id)
          ? next
          : [...next, payload.message];
        return reconciled;
      });
      // Skip markRead for the user's OWN send (their optimistic + the
      // server echo). Without the gate, one user posting N messages
      // fires N /read POSTs from their own tab — a small storm that
      // pegs the api log under any chatty session.
      if (payload.message.authorUserId !== currentUserId) {
        if (
          typeof document === "undefined" ||
          document.visibilityState === "visible"
        ) {
          // The user is looking at this channel — mark it read so other
          // tabs + the sidebar badge stay in lockstep.
          void markRead();
        } else {
          // Backgrounded tab parked on this channel: DON'T mark read for a
          // message the user never saw — that silently clears their own
          // unread dot + mention badges. Defer to the visibility handler.
          sawInboundWhileHiddenRef.current = true;
        }
      }
    };

    // All five handlers below follow the same shape: findIndex first, bail
    // (return `prev`) if the targeted message isn't in the loaded slice
    // (paginated above the cursor). Without this, every reaction / edit /
    // pin / thread-reply / delete event re-allocates the entire `messages`
    // array AND re-renders the channel feed — even when the touched
    // message scrolled off the top of the slice an hour ago. React's
    // setState bails on ref equality, so returning `prev` skips the
    // re-render entirely.
    const onEdited: Parameters<typeof socket.on<"team:channel:message:edited">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === payload.messageId);
        if (idx === -1) return prev;
        const next = prev.slice();
        next[idx] = { ...prev[idx]!, body: payload.body, editedAt: payload.editedAt };
        return next;
      });
    };

    const onDeleted: Parameters<typeof socket.on<"team:channel:message:deleted">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      // Thread-reply deletes are handled by use-thread-events; this hook
      // only cares about top-level deletes.
      if (payload.threadRootId) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === payload.messageId);
        if (idx === -1) return prev;
        const next = prev.slice();
        next.splice(idx, 1);
        return next;
      });
    };

    // Per-(message,emoji) last-applied version. Discards events whose
    // `version` is older than what we already applied so two toggles
    // landing out-of-order can't roll the snapshot back.
    const reactionVersionsRef = lastReactionVersionsRef.current;
    const onReaction: Parameters<typeof socket.on<"team:channel:reaction:changed">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      const key = `${payload.messageId}::${payload.emoji}`;
      const lastVersion = reactionVersionsRef.get(key) ?? 0;
      // OPTIMISTIC frames are gated by version (so a stale optimistic frame
      // can't roll back a newer optimistic one). AUTHORITATIVE frames (no
      // `optimistic` flag) are ALWAYS applied — they carry the full DB snapshot
      // and are truth — but we still RECORD their version so a later stale
      // optimistic frame below it is discarded.
      if (payload.optimistic && payload.version <= lastVersion) return;
      reactionVersionsRef.set(key, payload.version);
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === payload.messageId);
        if (idx === -1) return prev;
        const m = prev[idx]!;
        // Replace the emoji's bucket; drop the bucket entirely if empty.
        const filtered = m.reactions.filter((r) => r.emoji !== payload.emoji);
        const nextReactions =
          payload.userIds.length === 0
            ? filtered
            : [...filtered, { emoji: payload.emoji, userIds: payload.userIds }];
        const next = prev.slice();
        next[idx] = { ...m, reactions: nextReactions };
        return next;
      });
    };

    const onPin: Parameters<typeof socket.on<"team:channel:pin:changed">>[1] = (payload) => {
      if (payload.channelId !== channelId) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === payload.messageId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        // Pin-already-current → bail. Idempotent pin/unpin races (two admins
        // clicking pin nearly simultaneously) emit the same event twice;
        // second one is a no-op.
        if (existing.pinned === payload.pinned) return prev;
        const next = prev.slice();
        next[idx] = { ...existing, pinned: payload.pinned };
        return next;
      });
    };

    const onThreadReply: Parameters<typeof socket.on<"team:channel:thread:reply">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === payload.rootMessageId);
        if (idx === -1) return prev;
        const next = prev.slice();
        next[idx] = {
          ...prev[idx]!,
          threadReplyCount: payload.replyCount,
          threadLastReplyAt: payload.lastReplyAt,
        };
        return next;
      });
    };

    const onTyping: Parameters<typeof socket.on<"team:channel:typing:update">>[1] = (
      payload,
    ) => {
      if (payload.channelId !== channelId) return;
      setTypingUserIds(payload.typingUserIds);
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    socket.on("connect", onConnect);
    socket.on("team:channel:message", onMessage);
    socket.on("team:channel:message:edited", onEdited);
    socket.on("team:channel:message:deleted", onDeleted);
    socket.on("team:channel:reaction:changed", onReaction);
    socket.on("team:channel:pin:changed", onPin);
    socket.on("team:channel:thread:reply", onThreadReply);
    socket.on("team:channel:typing:update", onTyping);
    if (socket.connected) onConnect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socket.emit("unsubscribe:channel", { channelId });
      socket.off("connect", onConnect);
      socket.off("team:channel:message", onMessage);
      socket.off("team:channel:message:edited", onEdited);
      socket.off("team:channel:message:deleted", onDeleted);
      socket.off("team:channel:reaction:changed", onReaction);
      socket.off("team:channel:pin:changed", onPin);
      socket.off("team:channel:thread:reply", onThreadReply);
      socket.off("team:channel:typing:update", onTyping);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [channelId, markRead, currentUserId]);

  const addOptimistic = useCallback((m: TeamChannelMessageDto) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const markOptimisticFailed = useCallback((clientTempId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.clientTempId === clientTempId && m.pending
          ? { ...m, pending: false, failed: true }
          : m,
      ),
    );
  }, []);

  const removeOptimistic = useCallback((clientTempId: string) => {
    setMessages((prev) => prev.filter((m) => m.clientTempId !== clientTempId));
  }, []);

  // Re-send a failed optimistic message. Flip it back to pending immediately,
  // then re-POST the same body + clientTempId so the eventual server echo
  // reconciles the SAME row (matching `onMessage`'s clientTempId swap). The
  // URL is derived from the message's own `threadRootId` so a failed thread
  // reply retries into its thread, not the channel root.
  const retryOptimistic = useCallback(
    (clientTempId: string) => {
      const target = messagesRef.current.find(
        (m) => m.clientTempId === clientTempId,
      );
      if (!target) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.clientTempId === clientTempId
            ? { ...m, pending: true, failed: false }
            : m,
        ),
      );
      const url = target.threadRootId
        ? `/api/team/channels/${channelId}/messages/${target.threadRootId}/thread`
        : `/api/team/channels/${channelId}/messages`;
      void fetchWithSessionGuard(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: target.body, clientTempId }),
      })
        .then((res) => {
          if (!res.ok) markOptimisticFailed(clientTempId);
          // success: the matching socket event swaps the optimistic row.
        })
        .catch(() => markOptimisticFailed(clientTempId));
    },
    [channelId, markOptimisticFailed],
  );

  return {
    messages,
    typingUserIds,
    hasMoreOlder: olderCursor !== null,
    loadingOlder,
    loadOlder,
    anchored: newerCursor !== null,
    hasMoreNewer: newerCursor !== null,
    loadingNewer,
    loadNewer,
    loadAround,
    goToLive,
    pendingLiveCount,
    addOptimistic,
    markOptimisticFailed,
    removeOptimistic,
    retryOptimistic,
  };
}
