"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import type { ConversationWithRefs, CursorPage } from "@ccp/shared/types";
import type { Filter } from "@/features/inbox/components/inbox-controls";

export interface TeamEventsState {
  conversations: ConversationWithRefs[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** True while the initial list for a freshly-selected filter is loading. */
  refreshing: boolean;
}

/**
 * Compose the server-side filter into URL query params. Empty when filter
 * is `all`-preset (preserves the historical "no filter param = all
 * non-closed" default for any legacy consumers that don't pass one).
 */
function filterParams(filter: Filter | undefined): URLSearchParams {
  const p = new URLSearchParams();
  if (!filter) return p;
  if (filter.kind === "preset") {
    p.set("filter", filter.id);
  } else {
    p.set("stageId", filter.stageId);
  }
  return p;
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
  /**
   * Signed-in agent id. Used to maintain per-agent `unreadForMe` alongside
   * team-wide `unreadCount` — a teammate's read clears the team counter but
   * NOT my "I haven't seen this" flag, while my own read clears both.
   */
  currentUserId: string,
  /**
   * Active inbox filter (preset or stage). Drives the server-side WHERE
   * clause via `/api/conversations?filter=...&stageId=...` so the loaded
   * slice is the FULL team's matching threads — not just whatever fits in
   * a paginated team-recency window. SSR seeds the unfiltered list; the
   * first filter change after mount triggers a clean refetch.
   */
  filter?: Filter,
): TeamEventsState {
  const [conversations, setConversations] =
    useState<ConversationWithRefs[]>(initialConversations);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Stable filter ref so socket handlers + resync can read the latest
  // without re-binding on every change. The filter-change effect below
  // owns the actual refetch.
  const filterRef = useRef<Filter | undefined>(filter);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

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
    const params = filterParams(filterRef.current);
    params.set("cursor", cursor);
    fetchWithSessionGuard(`/api/conversations?${params.toString()}`)
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

  // Filter-change refetch. SSR seeds the unfiltered list (matches default
  // `{kind:"preset", id:"all"}`). When the user clicks Mine / Unassigned /
  // Closed / a stage row, refetch with the matching server-side filter so
  // the loaded slice is the FULL team's matching threads. Skip the very
  // first run — that's the SSR seed.
  const filterKey = filter
    ? filter.kind === "preset"
      ? `p:${filter.id}`
      : `s:${filter.stageId}`
    : "p:all";
  const lastFilterKeyRef = useRef<string | null>(null);
  useEffect(() => {
    // Skip the initial mount — SSR data is current, no refetch needed.
    if (lastFilterKeyRef.current === null) {
      lastFilterKeyRef.current = filterKey;
      return;
    }
    if (lastFilterKeyRef.current === filterKey) return;
    lastFilterKeyRef.current = filterKey;

    let cancelled = false;
    setRefreshing(true);
    const params = filterParams(filter);
    fetchWithSessionGuard(`/api/conversations?${params.toString()}`)
      .then((r) => (r.ok ? (r.json() as Promise<CursorPage<ConversationWithRefs>>) : null))
      .then((page) => {
        if (cancelled || !page) return;
        setConversations(page.items);
        setNextCursor(page.nextCursor);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filterKey, filter]);

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
        // Filter-aware resync: a reconnect under filter=Mine must come back
        // with only my threads, not the whole team. Tail-merge with the
        // existing local list to preserve any newer rows that arrived via
        // realtime between the resync request and its response.
        const params = filterParams(filterRef.current);
        const url = params.toString() ? `/api/conversations?${params}` : `/api/conversations`;
        const r = await fetchWithSessionGuard(url);
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

    // Debounced resync trigger for filter-eligibility-changing events.
    // Per-event mutations below handle the in-list rows snappily; this
    // catches the splice-IN case (a row that newly matches the filter
    // because of the event) which the in-handler logic can't synthesize
    // without the full ConversationWithRefs. Coalesces a burst of events
    // into a single fetch.
    let resyncTimer: number | null = null;
    function scheduleFilterResync() {
      // No-op when there's no filter narrowing — the unfiltered list is
      // already shown in full; per-event mutations cover it.
      if (!filterRef.current || filterRef.current.kind === "preset" && filterRef.current.id === "all") {
        return;
      }
      if (resyncTimer !== null) return;
      resyncTimer = window.setTimeout(() => {
        resyncTimer = null;
        void resyncOnce();
      }, 300);
    }

    const onConnect = () => {
      // Server auto-joins the team room on connect; no explicit subscribe needed.
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
      unreadCount,
      message,
      newConversation,
    }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) {
          // Brand-new thread (first contact, or first inbound after a closed
          // thread). The server sends the full row; splice it in at the top,
          // but only when it matches the current server-side filter — e.g.
          // a brand-new pending+unassigned thread doesn't belong in the
          // "Mine" view, and a closed-thread reopen doesn't belong in the
          // "Closed" view.
          if (!newConversation) return prev;
          const f = filterRef.current;
          // Stage view includes closed conversations on purpose — see
          // queries/conversations.ts. Presets (all/mine/unassigned) still
          // hide closed; "closed" preset shows only closed.
          const matches =
            !f
              ? true
              : f.kind === "stage"
                ? newConversation.contact.stageId === f.stageId
                : f.id === "closed"
                  ? newConversation.conversation.status === "closed"
                  : f.id === "mine"
                    ? newConversation.conversation.status !== "closed" &&
                      newConversation.conversation.assignedUserId === currentUserId
                    : f.id === "unassigned"
                      ? newConversation.conversation.status !== "closed" &&
                        newConversation.conversation.assignedUserId === null
                      : newConversation.conversation.status !== "closed"; // "all"
          if (!matches) return prev;
          return [newConversation, ...prev];
        }
        const existing = prev[idx]!;
        // If the user is currently viewing this thread, suppress the bump —
        // the server-side mark-read will follow but this avoids a 1-tick
        // badge flash on the conversation that's already on screen.
        //
        // The payload carries the ABSOLUTE team-wide unread count, so a
        // dropped event or out-of-order delivery can't drift the local
        // mirror — each frame replaces the value rather than adding to it.
        const isActive = activeIdRef.current === conversationId;
        const nextUnread =
          message.direction === "in" && !isActive
            ? unreadCount
            : existing.conversation.unreadCount;
        // Per-agent "I haven't seen this" — flip true on inbound for any
        // non-active thread (active = I'm viewing, so I'm reading it now).
        // Outbound never changes unreadForMe (matches the team-wide
        // semantics: only customer messages count as "unread").
        const nextUnreadForMe =
          message.direction === "in" && !isActive
            ? true
            : existing.conversation.unreadForMe;
        const updated: ConversationWithRefs = {
          ...existing,
          conversation: {
            ...existing.conversation,
            lastMessageAt,
            lastMessagePreview: preview,
            unreadCount: nextUnread,
            ...(nextUnreadForMe !== undefined ? { unreadForMe: nextUnreadForMe } : {}),
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
      const nextAssignedUserId = assignedUser?.id ?? null;
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        // With server-side filtering, an assignment change can knock the
        // row out of the current view (e.g. filter is "mine" and a teammate
        // took the thread). Splice OUT when the new assignment no longer
        // matches the filter. The matching-into-view case (filter "mine"
        // and assigned to me — but row not in list) is caught by the
        // scheduled resync below.
        const f = filterRef.current;
        const stillMatches =
          !f || f.kind === "stage"
            ? true
            : f.id === "mine"
              ? nextAssignedUserId === currentUserId
              : f.id === "unassigned"
                ? nextAssignedUserId === null
                : true; // "all" / "closed" don't filter on assignment
        if (!stillMatches) {
          const next = prev.slice();
          next.splice(idx, 1);
          return next;
        }
        const next = prev.slice();
        next[idx] = {
          ...existing,
          conversation: {
            ...existing.conversation,
            assignedUserId: nextAssignedUserId,
          },
          assignedUser,
        };
        return next;
      });
      // Splice-IN catcher: a teammate assigning the thread to me when my
      // filter is "mine" wouldn't be in the loaded list yet. Resync pulls
      // it in. Debounced + no-op'd for the unfiltered view.
      scheduleFilterResync();
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
        // Splice OUT when the new status no longer matches the filter
        // (e.g. preset "all"/"mine"/"unassigned" + status=closed, or
        // preset "closed" + status=open|pending). Stage filter keeps
        // closed conversations on purpose — stage is contact-lifecycle,
        // not chat status.
        const f = filterRef.current;
        const stillMatches =
          !f
            ? true
            : f.kind === "stage"
              ? true
              : f.id === "closed"
                ? status === "closed"
                : status !== "closed";
        if (!stillMatches) {
          const next = prev.slice();
          next.splice(idx, 1);
          return next;
        }
        const next = prev.slice();
        next[idx] = {
          ...existing,
          conversation: { ...existing.conversation, status },
        };
        return next;
      });
      scheduleFilterResync();
    };

    const onRead: Parameters<typeof socket.on<"conversation:read">>[1] = ({
      conversationId,
      readByUserId,
    }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        // Team-wide always clears; per-agent only clears if the reader
        // is me. A teammate reading doesn't mean I've seen it.
        const teamChange = existing.conversation.unreadCount !== 0;
        const myChange =
          readByUserId === currentUserId &&
          existing.conversation.unreadForMe === true;
        if (!teamChange && !myChange) return prev;
        const next = prev.slice();
        next[idx] = {
          ...existing,
          conversation: {
            ...existing.conversation,
            ...(teamChange ? { unreadCount: 0 } : {}),
            ...(myChange ? { unreadForMe: false } : {}),
          },
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
        const f = filterRef.current;
        const isStageFilter = f?.kind === "stage";
        let changed = false;
        const next: ConversationWithRefs[] = [];
        for (const c of prev) {
          if (c.contact.id !== contact.id) {
            next.push(c);
            continue;
          }
          // Splice OUT when this contact's stage no longer matches the
          // active stage filter (e.g. teammate moved the contact to a
          // different stage). The splice-IN case — a contact JUST entered
          // this stage but the row isn't in the list — is caught by the
          // scheduled resync below.
          if (isStageFilter && contact.stageId !== f.stageId) {
            changed = true;
            continue;
          }
          changed = true;
          next.push({ ...c, contact });
        }
        return changed ? next : prev;
      });
      scheduleFilterResync();
    };

    // Coalesced bulk version. Server fires this from bulk-tag / bulk-stage /
    // bulk-field operations to bound socket bandwidth (1 frame per N
    // contacts instead of N). The payload carries only ids — fetch the
    // fresh contact rows once and patch every affected conversation in a
    // single setConversations call.
    const onContactsBulkUpdated: Parameters<
      typeof socket.on<"contacts:bulk_updated">
    >[1] = ({ contactIds }) => {
      if (!contactIds?.length) return;
      const ids = contactIds.join(",");
      void fetchWithSessionGuard(
        `/api/contacts/lookup?ids=${encodeURIComponent(ids)}`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<{ contacts: typeof initialConversations[number]["contact"][] }>) : null))
        .then((body) => {
          if (!body?.contacts?.length) return;
          const byId = new Map(body.contacts.map((c) => [c.id, c]));
          setConversations((prev) => {
            let changed = false;
            const next = prev.map((c) => {
              const fresh = byId.get(c.contact.id);
              if (!fresh) return c;
              changed = true;
              return { ...c, contact: fresh };
            });
            return changed ? next : prev;
          });
        })
        .catch(() => {
          // Swallow — stale embedded contact is recoverable on next chat
          // switch (the cached thread is also evicted by inbox-shell's
          // bulk handler). No need to surface this transient miss.
        });
    };

    socket.on("message:new", onMessageNew);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:status", onStatus);
    socket.on("conversation:read", onRead);
    socket.on("conversation:deleted", onConversationDeleted);
    socket.on("contact:updated", onContactUpdated);
    socket.on("contacts:bulk_updated", onContactsBulkUpdated);

    return () => {
      if (resyncTimer !== null) {
        window.clearTimeout(resyncTimer);
        resyncTimer = null;
      }
      socket.off("connect", onConnect);
      socket.off("message:new", onMessageNew);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:status", onStatus);
      socket.off("conversation:read", onRead);
      socket.off("conversation:deleted", onConversationDeleted);
      socket.off("contact:updated", onContactUpdated);
      socket.off("contacts:bulk_updated", onContactsBulkUpdated);
    };
  }, [teamId, currentUserId]);

  return { conversations, hasMore: nextCursor !== null, loadingMore, loadMore, refreshing };
}
