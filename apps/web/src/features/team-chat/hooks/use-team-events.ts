"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import type { ConversationWithRefs, CursorPage } from "@ccp/shared/types";

export interface TeamEventsState {
  conversations: ConversationWithRefs[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/**
 * Holds the list of conversations and folds in incremental Socket.io events
 * so the inbox updates without a refetch.
 *
 * Server-rendered initial state seeds the list — events from the team room
 * mutate that state in place.
 *
 * Pagination: the server hands us page 1 (30 most recent) plus a cursor.
 * `loadMore()` fetches the next page and appends it. New conversations from
 * `message:new` are spliced at the TOP and never affect the cursor — keyset
 * pagination, not offset.
 *
 * `activeConversationId` is the thread the user is currently viewing. We use
 * it to skip the unread bump on inbound messages for that thread.
 */
export function useTeamEvents(
  teamId: string,
  initialConversations: ConversationWithRefs[],
  initialNextCursor: string | null,
  activeConversationId: string | null = null,
): TeamEventsState {
  const [conversations, setConversations] =
    useState<ConversationWithRefs[]>(initialConversations);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);

  // Re-seed when the server hands us a MEANINGFULLY different initial list.
  // Gating on raw array identity blew away every realtime update on any
  // `router.refresh()` (notably TimezoneProvider's first-visit refresh) —
  // a fresh server render produces a new array reference even when the
  // underlying data is unchanged. Compare by team + the set of conversation
  // ids instead: only re-seed when the team switches or the served list
  // actually changes.
  const lastSeedKeyRef = useRef<string>("");
  useEffect(() => {
    const key = `${teamId}|${initialConversations.map((c) => c.conversation.id).join(",")}|${initialNextCursor ?? ""}`;
    if (key === lastSeedKeyRef.current) return;
    lastSeedKeyRef.current = key;
    setConversations(initialConversations);
    setNextCursor(initialNextCursor);
  }, [teamId, initialConversations, initialNextCursor]);

  // loadMore is stable across renders — useCallback so the component can put
  // it in an effect dep array without re-running on every paint.
  const cursorRef = useRef(nextCursor);
  useEffect(() => {
    cursorRef.current = nextCursor;
  }, [nextCursor]);

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    setLoadingMore(true);
    fetchWithSessionGuard(`/api/conversations?cursor=${encodeURIComponent(cursor)}`)
      .then((r) => (r.ok ? (r.json() as Promise<CursorPage<ConversationWithRefs>>) : null))
      .then((page) => {
        if (!page) return;
        setConversations((prev) => {
          // Dedupe in case a realtime event already prepended one of these.
          const seen = new Set(prev.map((c) => c.conversation.id));
          const fresh = page.items.filter((c) => !seen.has(c.conversation.id));
          return [...prev, ...fresh];
        });
        setNextCursor(page.nextCursor);
      })
      .finally(() => setLoadingMore(false));
  }, []);

  // Mirror activeConversationId into a ref so the message:new handler reads
  // the latest value without re-subscribing on every navigation.
  const activeIdRef = useRef(activeConversationId);
  useEffect(() => {
    activeIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    const socket = getClientSocket();

    // Re-(sub)subscribe + resync the head on every connect — the first one
    // covers the initial subscription, every subsequent one covers a
    // reconnect after a drop longer than Socket.io's connectionStateRecovery
    // window (or a full server restart). Without this, the inbox list goes
    // silently stale on any non-trivial drop until the user reloads.
    const firstConnectRef = { value: true };
    /**
     * Resync the conversation list after a (re)connect with bounded
     * retries. Without retries a single network blip during reconnect
     * silently leaves the list stale until the user's next deliberate
     * navigation; with retries we recover transparently.
     */
    async function resyncOnce(): Promise<boolean> {
      try {
        const r = await fetchWithSessionGuard(`/api/conversations`);
        if (!r.ok) return false;
        const page = (await r.json()) as CursorPage<ConversationWithRefs>;
        setConversations((prev) => {
          const freshIds = new Set(page.items.map((c) => c.conversation.id));
          const tail = prev.filter((c) => !freshIds.has(c.conversation.id));
          return [...page.items, ...tail];
        });
        return true;
      } catch {
        return false;
      }
    }
    async function resyncWithBackoff(): Promise<void> {
      const delays = [0, 500, 1500, 4000]; // ~6s total
      for (const ms of delays) {
        if (ms > 0) await new Promise((r) => window.setTimeout(r, ms));
        if (await resyncOnce()) return;
      }
      // Bounded — if all retries fail the list is stale until the user
      // triggers another reconnect or navigates. A nuclear `router.refresh()`
      // here would also work but feels heavier than warranted.
    }

    const onConnect = () => {
      socket.emit("subscribe:team", { teamId });
      if (firstConnectRef.value) {
        firstConnectRef.value = false;
        return; // initial — server-seeded data is already current
      }
      void resyncWithBackoff();
    };
    socket.on("connect", onConnect);
    if (socket.connected) onConnect();

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
          // Inbound messages reset the 24h customer-service window. The
          // conversation list uses this for its window chip; outbound
          // messages don't move the clock.
          lastInboundAt:
            message.direction === "in" ? lastMessageAt : existing.lastInboundAt,
        };
        // Re-sort by recency so the touched conversation jumps to the top.
        const next = [...prev];
        next.splice(idx, 1);
        next.unshift(updated);
        return next;
      });
    };

    // All three handlers below follow the same shape: only allocate a new
    // array when the targeted conversation is actually in the loaded slice
    // (cross-thread events for conversations the user hasn't paged into bail
    // and return `prev`, so React's setState skips the re-render entirely).
    // Same pattern `onContactUpdated` already uses below. On a busy team with
    // a 100-row visible list, this collapses the per-event work for the ~90%
    // of events that don't touch a visible conversation from O(N) + re-render
    // to O(N) + zero work in React's reconciler.
    const onAssigned: Parameters<typeof socket.on<"conversation:assigned">>[1] = ({
      conversationId,
      assignedUser,
    }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        const next = prev.slice();
        next[idx] = {
          ...existing,
          conversation: {
            ...existing.conversation,
            assignedUserId: assignedUser?.id ?? null,
          },
          assignedUser,
        };
        return next;
      });
    };

    const onStatus: Parameters<typeof socket.on<"conversation:status">>[1] = ({
      conversationId,
      status,
    }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        // Status-already-current → bail. Saves a re-render when the same
        // status arrives twice (e.g. a stale tab re-fires after reconnect).
        if (existing.conversation.status === status) return prev;
        const next = prev.slice();
        next[idx] = {
          ...existing,
          conversation: { ...existing.conversation, status },
        };
        return next;
      });
    };

    const onRead: Parameters<typeof socket.on<"conversation:read">>[1] = ({
      conversationId,
    }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        if (existing.conversation.unreadCount === 0) return prev;
        const next = prev.slice();
        next[idx] = {
          ...existing,
          conversation: { ...existing.conversation, unreadCount: 0 },
        };
        return next;
      });
    };

    const onConversationDeleted: Parameters<typeof socket.on<"conversation:deleted">>[1] = ({
      conversationId,
    }) => {
      setConversations((prev) => {
        // findIndex first so we can bail on a no-match without allocating.
        // The bulk-delete path emits one event per deleted id, so a teammate
        // bulk-deleting 50 conversations would otherwise cause 50 list-wide
        // filter allocations on every other agent's tab.
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const next = prev.slice();
        next.splice(idx, 1);
        return next;
      });
    };

    // Contact edits (name/email/location/stage/tags/customFields) — patch
    // the embedded contact on every conversation that points at this id.
    // The sidebar's stage filter + per-stage counts use contact.stageId, so
    // a stage change made by a teammate now re-evaluates here without a
    // page refresh. Conversations belonging to other contacts pass through
    // untouched (the map keeps stable references where it can).
    const onContactUpdated: Parameters<typeof socket.on<"contact:updated">>[1] = ({
      contact,
    }) => {
      setConversations((prev) => {
        let changed = false;
        const next = prev.map((c) => {
          if (c.contact.id !== contact.id) return c;
          changed = true;
          return { ...c, contact };
        });
        return changed ? next : prev;
      });
    };

    socket.on("message:new", onMessageNew);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:status", onStatus);
    socket.on("conversation:read", onRead);
    socket.on("conversation:deleted", onConversationDeleted);
    socket.on("contact:updated", onContactUpdated);

    return () => {
      socket.off("connect", onConnect);
      socket.off("message:new", onMessageNew);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:status", onStatus);
      socket.off("conversation:read", onRead);
      socket.off("conversation:deleted", onConversationDeleted);
      socket.off("contact:updated", onContactUpdated);
    };
  }, [teamId]);

  return { conversations, hasMore: nextCursor !== null, loadingMore, loadMore };
}
