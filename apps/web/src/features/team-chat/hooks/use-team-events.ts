"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { onOptimisticListBump } from "@/features/inbox/lib/optimistic-list-bump";
import type { Contact, ConversationWithRefs, CursorPage } from "@ccp/shared/types";
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
 * Pure predicate: does this conversation row belong in the given filter view?
 * Mirrors the server-side WHERE in queries/conversations.ts so the client can
 * filter the already-loaded slice instantly (e.g. on a tab switch, before the
 * server refetch lands) without showing a stale or wrong-filter snapshot.
 *
 * Module-scope so BOTH the filter-change effect (instant re-derive) and the
 * socket effect's local `rowMatchesFilter` (splice-in gating) share one
 * definition — they must agree or a row could appear in one path and not the
 * other.
 */
export function rowMatchesFilterFor(
  filter: Filter | undefined,
  currentUserId: string,
  row: ConversationWithRefs,
): boolean {
  if (!filter) return true; // no filter == "active" — matches "all" minus closed
  if (filter.kind === "stage") {
    // Stage is contact-lifecycle, orthogonal to chat status (closed included).
    return row.contact.stageId === filter.stageId;
  }
  if (filter.id === "all") return true; // truly everything, closed included
  if (filter.id === "closed") return row.conversation.status === "closed";
  if (row.conversation.status === "closed") return false;
  if (filter.id === "mine") return row.conversation.assignedUserId === currentUserId;
  if (filter.id === "unassigned") return row.conversation.assignedUserId === null;
  return true; // "active"
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
   * Signed-in agent id. Used to evaluate the `mine` preset filter (rows
   * where assignedUserId === me). Unread itself is team-wide only.
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
  /**
   * Full ConversationWithRefs for the conversation the user is currently
   * viewing (from the LRU thread cache). Used by the per-event handlers
   * below for OPTIMISTIC splice-IN: when the user changes a field on the
   * displayed thread (status, assignment, stage) and that change makes
   * the thread newly match the active filter, we synthesize the row
   * locally from this data instead of waiting on
   * `scheduleFilterResync()` → fetch round-trip.
   *
   * Without this, the row would only appear after the (300ms debounce +
   * ~200-400ms /api/conversations fetch) the user reported as "1 second
   * lag" when changing a chat's stage with a stage filter active, or
   * closing a chat with the "Closed" preset active.
   *
   * Null on first paint or when nothing is selected; in that case the
   * fallback resync path still works, just at the slower cadence.
   */
  activeThread: ConversationWithRefs | null = null,
): TeamEventsState {
  // SSR ships the team-wide unfiltered feed (the sub-sidebar's first-paint
  // preset counts depend on having closed rows in the seed too). The LIST
  // surface, though, has an active client-side filter ("Active" by default)
  // which excludes closed — so prune the seed through the same predicate
  // the filter-change effect uses, applied on first paint. Lazy initializer
  // keeps it synchronous: zero flicker, no closed row ever renders under
  // "Active" on a hard refresh.
  const [conversations, setConversations] = useState<ConversationWithRefs[]>(
    () => initialConversations.filter((row) => rowMatchesFilterFor(filter, currentUserId, row)),
  );
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Stable filter ref so socket handlers + resync can read the latest
  // without re-binding on every change. Sync-assigned during render (not
  // via useEffect) — same reasoning as activeThreadRef below: a
  // dispatchLocalSocketEvent fired from a click handler immediately
  // after a filter change would otherwise see the OLD filter through this
  // ref, because the post-commit useEffect hasn't run yet. The filter-
  // change effect later in this file owns the actual refetch.
  const filterRef = useRef<Filter | undefined>(filter);
  filterRef.current = filter;

  // Stable ref for the displayed thread's full row. Read by the splice-IN
  // branches in the socket handlers below.
  //
  // **Synced during render, not via useEffect — load-bearing.** A
  // dispatchLocalSocketEvent call from a click handler fires socket
  // listeners SYNCHRONOUSLY (before the post-commit useEffect runs). If
  // this ref were synced in a useEffect, the listener would see a stale
  // value on EXACTLY the first click after the displayed thread changes
  // — which is the most common case (user clicks a chat, then immediately
  // changes its status). Don't "fix" this by moving to useEffect; the
  // tradeoff (theoretical inconsistency during a discarded concurrent
  // render) doesn't apply to click-driven flows wrapped in flushSync (see
  // dispatchLocalSocketEvent in apps/web/src/lib/socket-client.ts).
  // Same pattern inbox-shell.tsx uses for activeIdRef / displayedIdRef.
  const activeThreadRef = useRef(activeThread);
  activeThreadRef.current = activeThread;

  // Last-known contact overlay, keyed by contactId. Updated on EVERY
  // `contact:updated` frame (optimistic + server). Read during a resync to
  // correct a STALE HTTP page's embedded contact — even for a row that was
  // optimistically spliced OUT of the list (so it's no longer in the live
  // `conversations` state to reconcile against). Without this, a stale resync
  // page that still lists a just-moved contact under its OLD stage re-adds the
  // row to the wrong stage filter — the "changed stage fast 2-3 times, header
  // right but sidebar wrong" bug. Server frames are in-order + version-CAS'd,
  // so the latest write here reflects the latest commit. Grow-only within a
  // session; one small entry per contact the agent touches — negligible.
  const latestContactRef = useRef<Map<string, Contact>>(new Map());

  // Re-seed when the server hands us a MEANINGFULLY different initial list.
  // Gating on raw array identity blew away every realtime update on any
  // `router.refresh()` (notably TimezoneProvider's first-visit refresh) —
  // a fresh server render produces a new array reference even when the
  // underlying data is unchanged. Compare by team + the set of conversation
  // ids instead: only re-seed when the team switches or the served list
  // actually changes. The seed is pruned through the active filter on the
  // way in for the same "no closed under All open on refresh" reason the
  // initial useState lazy initializer above guards against.
  const lastSeedKeyRef = useRef<string>("");
  useEffect(() => {
    const key = `${teamId}|${initialConversations.map((c) => c.conversation.id).join(",")}|${initialNextCursor ?? ""}`;
    if (key === lastSeedKeyRef.current) return;
    lastSeedKeyRef.current = key;
    setConversations(
      initialConversations.filter((row) =>
        rowMatchesFilterFor(filterRef.current, currentUserId, row),
      ),
    );
    setNextCursor(initialNextCursor);
  }, [teamId, initialConversations, initialNextCursor, currentUserId]);

  // Optimistic LIST bump for the sender's OWN send. Every send site (reply
  // box text/media/voice, template, interactive) fires this so the row jumps
  // to the top with the right preview INSTANTLY, independent of the server
  // `message:new` round-trip — the half of the optimistic story the list was
  // missing (the thread bubble was already optimistic via addOptimistic).
  // Mirrors onMessageNew's outbound branch: overwrite preview + lastMessageAt
  // and re-sort. Bails when the row isn't in the loaded slice (idx === -1) —
  // the server frame will splice it in. The real frame that follows is
  // idempotent here (absolute overwrite, not a delta).
  useEffect(() => {
    return onOptimisticListBump(({ conversationId, preview, lastMessageAt }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        const updated: ConversationWithRefs = {
          ...existing,
          conversation: {
            ...existing.conversation,
            lastMessageAt,
            lastMessagePreview: preview,
          },
        };
        const next = [...prev];
        next.splice(idx, 1);
        next.unshift(updated);
        return next;
      });
    });
  }, []);

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

    // INSTANT re-derive: filter the rows we ALREADY have (which carry the
    // freshest lastMessagePreview / assignee / status from live socket updates
    // + optimistic bumps) down to the new filter, synchronously, BEFORE the
    // server fetch lands. Without this the previous filter's slice stayed on
    // screen during the ~50-400ms fetch — showing a stale preview ("older
    // message") until the refetch overwrote it. Now the switch paints correct,
    // fresh rows immediately; the fetch below only ADDS matching rows that
    // weren't in the loaded slice yet and prunes any that no longer match.
    setConversations((prev) =>
      prev.filter((row) => rowMatchesFilterFor(filter, currentUserId, row)),
    );

    const params = filterParams(filter);
    fetchWithSessionGuard(`/api/conversations?${params.toString()}`)
      .then((r) => (r.ok ? (r.json() as Promise<CursorPage<ConversationWithRefs>>) : null))
      .then((page) => {
        if (cancelled || !page) return;
        // Reconcile the authoritative page with any fresher rows we already
        // hold. The server page can be a beat behind a live preview the agent
        // just saw (a `message:new` that landed between fetch-start and
        // resolve), so prefer the local row's preview/recency when it's newer.
        setConversations((prev) => {
          const localById = new Map(prev.map((c) => [c.conversation.id, c]));
          return page.items.map((row) => {
            const local = localById.get(row.conversation.id);
            // Keep the server row by default, but if our local copy has a
            // strictly-newer lastMessageAt (a live frame the page missed),
            // keep the local preview + recency so the row doesn't regress.
            if (
              local &&
              local.conversation.lastMessageAt > row.conversation.lastMessageAt
            ) {
              return {
                ...row,
                conversation: {
                  ...row.conversation,
                  lastMessageAt: local.conversation.lastMessageAt,
                  lastMessagePreview: local.conversation.lastMessagePreview,
                },
              };
            }
            return row;
          });
        });
        setNextCursor(page.nextCursor);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filterKey, filter, currentUserId]);

  // Mirror activeConversationId into a ref so the message:new handler reads
  // the latest value without re-subscribing on every navigation. Sync-
  // assigned during render so a click that switches conversation + fires
  // an immediate inbound message (server echo for own send, teammate's
  // typing-then-sending, etc.) reads the new id, not the previous one.
  const activeIdRef = useRef(activeConversationId);
  activeIdRef.current = activeConversationId;

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
    // Skip-window for the visibility-triggered resync after a recent
    // reconnect resync. Without this, a laptop opening on a fresh network
    // fires `connect` (→ resyncWithBackoff → resyncOnce) AND `visibilitychange`
    // within milliseconds, and the visibility handler bypasses the in-flight
    // queue (it runs through `runCoalescedResync`, the reconnect path runs
    // `resyncOnce` directly), so two parallel /api/conversations fire. 5s is
    // long enough to cover the reconnect resync's full backoff sequence in
    // the success case (~0–500ms) and well below any human-noticeable
    // refresh lag.
    let lastResyncCompletedAt = 0;
    const RESYNC_SKIP_WINDOW_MS = 5000;

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

        // Self-heal the overlay: once the fetched page AGREES with the overlay
        // on a contact's stage, the server has caught up and the overlay entry
        // is redundant — drop it. This bounds overlay staleness to the rapid-
        // change window: if we DIDN'T clear it, a later legitimate change we
        // missed (e.g. a teammate's move while this tab was backgrounded) would
        // be silently reverted by an outdated overlay entry. Disagreement means
        // the page is still stale mid-burst, so the entry is KEPT and keeps
        // correcting. Drop also when the page omits the contact entirely yet
        // its rows are all accounted for — handled by the next clean resync.
        {
          const overlay = latestContactRef.current;
          if (overlay.size > 0) {
            const pageStageByContact = new Map(
              page.items.map((c) => [c.contact.id, c.contact.stageId ?? null]),
            );
            for (const [contactId, c] of overlay) {
              const pageStage = pageStageByContact.get(contactId);
              if (pageStage !== undefined && pageStage === (c.stageId ?? null)) {
                overlay.delete(contactId);
              }
            }
          }
        }

        setConversations((prev) => {
          const freshIds = new Set(page.items.map((c) => c.conversation.id));
          const overlay = latestContactRef.current;

          // The HTTP resync can be STALE — it may have started before a
          // stage/assign/status change committed server-side, so its rows can
          // carry the OLD contact stage. Socket `contact:updated` frames, by
          // contrast, arrive IN ORDER and the server's version-CAS means the
          // last one we saw reflects the last commit — so `latestContactRef`
          // is authoritative for a contact's stage over any page copy.
          //
          // Overlay every page row's embedded contact with the latest-known
          // one (keyed by contactId, so it corrects even a row the page lists
          // under the wrong stage), THEN prune the whole merged list by the
          // SAME `rowMatchesFilter` the splice branches use. This kills the
          // "changed stage fast 2-3 times → header right, sidebar still shows
          // the old stage" bug: a stale page can no longer resurrect or retain
          // a row that the latest contact data says doesn't match the filter.
          const reconciledPage = page.items.map((row) => {
            const latest = overlay.get(row.contact.id);
            return latest ? { ...row, contact: latest } : row;
          });
          // Tail = local rows the page didn't return (newer realtime arrivals
          // mid-fetch). Overlay their contact too, then prune below.
          const tail = prev
            .filter((c) => !freshIds.has(c.conversation.id))
            .map((c) => {
              const latest = overlay.get(c.contact.id);
              return latest ? { ...c, contact: latest } : c;
            });
          return [...reconciledPage, ...tail].filter(rowMatchesFilter);
        });
        lastResyncCompletedAt = Date.now();
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

    // Tight-debounced + coalesced resync trigger for filter-eligibility-
    // changing events. Per-event mutations below handle the in-list rows
    // snappily AND optimistically splice IN the displayed thread (using
    // `activeThreadRef.current`) when the event makes it newly match the
    // filter — so the common "user changed the chat they're viewing" case
    // is instant without a fetch. This resync is the fallback for the
    // case we DON'T have data for: a teammate's change to an unrelated
    // conversation that now matches our filter.
    //
    // Two layers of coalescing:
    //   1. The 50ms timer collapses a burst of events that arrive BEFORE
    //      the timer fires (typical case during user input).
    //   2. The in-flight / queued flags collapse events that arrive AFTER
    //      the timer fires but BEFORE the GET returns (typical case during
    //      a teammate's bulk operation, where contact:updated frames can
    //      land mid-fetch). Without this second layer, those late events
    //      would each schedule a fresh 50ms timer, each one firing its own
    //      resyncOnce in parallel — N parallel fetches per burst.
    //
    // The window used to be 300ms; the user reported the resulting ~1s
    // total lag (debounce + fetch + render) on stage / closed-preset
    // changes. 50ms is enough to coalesce a burst but invisible to the eye
    // for a single change.
    let resyncTimer: number | null = null;
    let resyncInFlight = false;
    let resyncQueued = false;
    async function runCoalescedResync(): Promise<void> {
      if (resyncInFlight) {
        resyncQueued = true;
        return;
      }
      resyncInFlight = true;
      try {
        await resyncOnce();
      } finally {
        resyncInFlight = false;
        if (resyncQueued) {
          resyncQueued = false;
          // Re-enter so any events that landed mid-fetch are reconciled.
          // No recursion depth concern: each call awaits a network round-
          // trip, so at most one trailing run per actual event burst.
          void runCoalescedResync();
        }
      }
    }
    function scheduleFilterResync() {
      // No-op for the broad inbox views ("active" = open+pending, "all" =
      // everything). Per-event splice handlers above already mutate the
      // visible slice for the displayed thread, and for off-screen rows the
      // broad view will surface them whenever `lastMessageAt` next advances.
      // Running a /api/conversations refetch on every assign / status / stage
      // event from any teammate while the agent is on the default view
      // re-renders the entire list and visibly flickers it — the issue the
      // user reported as "the whole inbox is vibrating".
      const f = filterRef.current;
      if (!f) return;
      if (f.kind === "preset" && (f.id === "active" || f.id === "all")) return;
      if (resyncTimer !== null) return;
      resyncTimer = window.setTimeout(() => {
        resyncTimer = null;
        void runCoalescedResync();
      }, 50);
    }

    // Shared filter-match check used by all three splice-IN branches below.
    // Centralized so the rules stay in one place — adding a new filter kind
    // or preset means updating this function, not three call sites.
    //
    // `nextRow` is the (locally synthesized) row that would land in the
    // list. We check whether it matches the active filter; if so, the
    // splice-IN branch inserts it at the recency-sorted slot.
    function rowMatchesFilter(nextRow: ConversationWithRefs): boolean {
      // Delegates to the module-scope predicate so the splice-in gating here
      // and the instant filter-switch re-derive can't drift apart.
      return rowMatchesFilterFor(filterRef.current, currentUserId, nextRow);
    }

    // Inserts `row` into the recency-sorted list at the position its
    // `lastMessageAt` belongs. The conversation list is sorted
    // descending (most recent at index 0); a status/assignment/stage
    // change doesn't bump `lastMessageAt`, so a naive prepend would
    // place the row at the top even if it's actually older than other
    // rows in the filter. ISO-8601 timestamps sort correctly as strings.
    //
    // Bails (returns prev unchanged) if the row is already present — the
    // splice-IN callers already guard against this, but keeping the check
    // local makes the helper safe to call in any future context.
    function insertByRecency(
      list: ConversationWithRefs[],
      row: ConversationWithRefs,
    ): ConversationWithRefs[] {
      if (list.some((c) => c.conversation.id === row.conversation.id)) return list;
      const rowTs = row.conversation.lastMessageAt;
      const idx = list.findIndex((c) => c.conversation.lastMessageAt < rowTs);
      if (idx === -1) return [...list, row];
      return [...list.slice(0, idx), row, ...list.slice(idx)];
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
          // queries/conversations.ts. "all" preset includes closed; "active"
          // (and mine/unassigned) hide closed; "closed" preset shows only
          // closed.
          const matches =
            !f
              ? true
              : f.kind === "stage"
                ? newConversation.contact.stageId === f.stageId
                : f.id === "all"
                  ? true
                  : f.id === "closed"
                    ? newConversation.conversation.status === "closed"
                    : f.id === "mine"
                      ? newConversation.conversation.status !== "closed" &&
                        newConversation.conversation.assignedUserId === currentUserId
                      : f.id === "unassigned"
                        ? newConversation.conversation.status !== "closed" &&
                          newConversation.conversation.assignedUserId === null
                        : newConversation.conversation.status !== "closed"; // "active"
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
        // Recency guard — only advance the preview / lastMessageAt / sort
        // position / unread when this frame is STRICTLY newer than what the row
        // already shows. The server sends the effective-newest summary, but
        // Socket.io connection-state-recovery can REPLAY buffered frames on
        // reconnect, and a late/out-of-order delivery can re-arrive after the
        // row already absorbed that exact message. Must be `>` not `>=`: a
        // replay of the SAME message carries `lastMessageAt === row.lastMessageAt`
        // (the row was set from that very frame the first time), so `>=` would
        // treat the replay as "new" — re-unshifting the row to the top AND
        // re-applying the frame's stale ABSOLUTE unreadCount (e.g. 1) on top of
        // a count the agent has since cleared to 0. That's the "unread reappears
        // after I already read it / row jumps to top" bug. `>` makes a replay a
        // no-op for position + unread; the count below stays at the row's value.
        const advances = lastMessageAt > existing.conversation.lastMessageAt;
        // The frame carries the ABSOLUTE team-wide unread count. Apply it only
        // for a strictly-newer inbound frame the agent isn't viewing — gating on
        // `advances` is what stops a replay from regressing a cleared count.
        const nextUnread =
          message.direction === "in" && !isActive && advances
            ? unreadCount
            : existing.conversation.unreadCount;
        const updated: ConversationWithRefs = {
          ...existing,
          conversation: {
            ...existing.conversation,
            ...(advances ? { lastMessageAt, lastMessagePreview: preview } : {}),
            unreadCount: nextUnread,
          },
          // Inbound messages reset the 24h customer-service window. The
          // conversation list uses this for its window chip; outbound
          // messages don't move the clock. Don't let an older replayed frame
          // rewind the window either.
          lastInboundAt:
            message.direction === "in" && advances
              ? lastMessageAt
              : existing.lastInboundAt,
        };
        // Re-sort by recency: a newer frame jumps the row to the top; an
        // older replayed frame keeps its current slot.
        const next = [...prev];
        next.splice(idx, 1);
        if (advances) next.unshift(updated);
        else next.splice(idx, 0, updated);
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
        if (idx === -1) {
          // Row isn't in the loaded slice. If this is the conversation the
          // user is currently viewing AND the new assignment makes it match
          // the active filter (e.g. they just assigned themselves while on
          // filter=Mine), synthesize the row from the cached active thread
          // so it appears INSTANTLY. Resync below catches the same case
          // for teammate-driven changes where we don't hold the data.
          const active = activeThreadRef.current;
          if (active && active.conversation.id === conversationId) {
            const nextRow: ConversationWithRefs = {
              ...active,
              conversation: {
                ...active.conversation,
                assignedUserId: nextAssignedUserId,
              },
              assignedUser,
            };
            if (rowMatchesFilter(nextRow)) {
              return insertByRecency(prev, nextRow);
            }
          }
          return prev;
        }
        const existing = prev[idx]!;
        // With server-side filtering, an assignment change can knock the
        // row out of the current view (e.g. filter is "mine" and a teammate
        // took the thread). Splice OUT when the new assignment no longer
        // matches the filter.
        const f = filterRef.current;
        const stillMatches =
          !f || f.kind === "stage"
            ? true
            : f.id === "mine"
              ? nextAssignedUserId === currentUserId
              : f.id === "unassigned"
                ? nextAssignedUserId === null
                : true; // "active" / "all" / "closed" don't filter on assignment
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
      // Splice-IN catcher for the non-displayed case (teammate's change
      // to a row we don't hold). Tight debounce so the gap between
      // optimistic above and canonical reconciliation here is invisible.
      scheduleFilterResync();
    };

    const onStatus: Parameters<typeof socket.on<"conversation:status">>[1] = ({
      conversationId,
      status,
    }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) {
          // Row isn't in the loaded slice. If this is the displayed thread
          // and the new status moves it INTO the active filter (e.g.
          // closing a chat while filter=Closed, or reopening while on
          // any of the open-leaning presets), splice it in instantly.
          const active = activeThreadRef.current;
          if (active && active.conversation.id === conversationId) {
            const nextRow: ConversationWithRefs = {
              ...active,
              conversation: { ...active.conversation, status },
            };
            if (rowMatchesFilter(nextRow)) {
              return insertByRecency(prev, nextRow);
            }
          }
          return prev;
        }
        const existing = prev[idx]!;
        // Status-already-current → bail. Saves a re-render when the same
        // status arrives twice (e.g. a stale tab re-fires after reconnect).
        if (existing.conversation.status === status) return prev;
        // Splice OUT when the new status no longer matches the filter
        // (e.g. preset "active"/"mine"/"unassigned" + status=closed, or
        // preset "closed" + status=open|pending). "all" keeps closed rows
        // in place; stage filter also keeps closed on purpose — stage is
        // contact-lifecycle, not chat status.
        const f = filterRef.current;
        const stillMatches =
          !f
            ? true
            : f.kind === "stage"
              ? true
              : f.id === "all"
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
    }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        // Unread is team-wide only — any member's read zeroes the counter
        // for everyone.
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
      optimistic,
    }) => {
      // Record the latest-known contact so a later (possibly stale) resync can
      // correct its page rows even for a contact whose row we just spliced OUT.
      // In-order socket frames mean the last write wins = latest commit.
      latestContactRef.current.set(contact.id, contact);
      setConversations((prev) => {
        const f = filterRef.current;
        const isStageFilter = f?.kind === "stage";
        let changed = false;
        let foundInList = false;
        const next: ConversationWithRefs[] = [];
        for (const c of prev) {
          if (c.contact.id !== contact.id) {
            next.push(c);
            continue;
          }
          foundInList = true;
          // Splice OUT when this contact's stage no longer matches the
          // active stage filter (e.g. teammate moved the contact to a
          // different stage).
          if (isStageFilter && contact.stageId !== f.stageId) {
            changed = true;
            continue;
          }
          changed = true;
          next.push({ ...c, contact });
        }
        // Splice-IN: contact wasn't in any row, but on a stage filter the
        // contact's new stageId may have JUST moved into the filtered view.
        // If it's the contact behind the displayed thread, synthesize from
        // the cached thread data so the row appears in the same frame as
        // the click — no fetch.
        if (!foundInList && isStageFilter) {
          const active = activeThreadRef.current;
          if (
            active &&
            active.contact.id === contact.id &&
            contact.stageId === f.stageId
          ) {
            const nextRow: ConversationWithRefs = { ...active, contact };
            // Insert at the recency-sorted slot rather than prepending —
            // a stage change doesn't bump lastMessageAt, so the row
            // shouldn't jump to the top of the filtered view.
            return insertByRecency(prev, nextRow);
          }
        }
        return changed ? next : prev;
      });
      // Skip the server re-sync for OPTIMISTIC local dispatches: the PATCH that
      // persists the change hasn't committed yet, so a re-fetch here can read
      // the PRE-change state and re-add a row we just spliced out — leaving it
      // stuck in (e.g.) a stage filter. resyncOnce merges-without-pruning, so
      // that stale row then survives even the later post-commit re-sync. The
      // optimistic splice in/out above is already correct; the post-commit
      // SERVER frame (optimistic absent) drives convergence.
      if (!optimistic) scheduleFilterResync();
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

    // Foreground resync. A backgrounded / throttled tab can miss live frames
    // (most importantly a teammate reading a thread → `conversation:read`)
    // while the socket stays nominally connected, so `connect` never re-fires
    // and the reconnect resync above never runs — leaving a stale unread badge
    // on the list until a new message lands or the page reloads. Pull a fresh
    // (filter-aware, tail-merged) head page the moment the tab returns to the
    // foreground, mirroring the active-thread backfill in useConversationEvents.
    // Since unread is team-wide, this is how another agent's "read" disappears
    // here even though we never saw the frame.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // Skip when a reconnect just resynced — they collapse to the same GET
      // and the reconnect path bypasses runCoalescedResync's in-flight queue,
      // so without this gate the visibility-driven resync would fire as a
      // PARALLEL fetch. The lastResyncCompletedAt timestamp is stamped only
      // on success, so a failed reconnect doesn't suppress the recovery.
      if (Date.now() - lastResyncCompletedAt < RESYNC_SKIP_WINDOW_MS) return;
      void runCoalescedResync();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (resyncTimer !== null) {
        window.clearTimeout(resyncTimer);
        resyncTimer = null;
      }
      document.removeEventListener("visibilitychange", onVisible);
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
