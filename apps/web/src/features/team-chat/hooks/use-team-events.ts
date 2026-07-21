"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import {
  onOptimisticListBump,
  onOptimisticListBumpRevert,
} from "@/features/inbox/lib/optimistic-list-bump";
import type { Contact, ConversationWithRefs, CursorPage } from "@ccp/shared/types";
import type { Filter } from "@/features/inbox/components/inbox-controls";

// Runs the effect BEFORE the browser paints (client), plain effect on the
// server (avoids the "useLayoutEffect does nothing on the server" warning
// during Next's SSR of this client component). Used for the filter-switch
// reconcile so the stale-slice frame never paints — see the filter-change
// effect below.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface TeamEventsState {
  conversations: ConversationWithRefs[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /**
   * True while a FILTER-SWITCH refetch is in flight. Lets the list show a
   * skeleton (not the "all caught up" empty state) during the ~50-400ms fetch
   * when the loaded slice has no rows for the new filter — otherwise Mine /
   * Unassigned / Closed / stage tabs flash the empty state before their data
   * lands, while All / Active (already in the loaded slice) don't.
   */
  refetching: boolean;
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
  } else if (filter.kind === "stage") {
    p.set("stageId", filter.stageId);
  }
  // calls view: no conversation-list filter params (the list is hidden).
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
  // Calls view replaces the conversation list — no conversation belongs to it.
  if (filter.kind === "calls") return false;
  if (filter.id === "all") return true; // truly everything, closed included
  if (filter.id === "closed") return row.conversation.status === "closed";
  // Flagged is checked BEFORE the closed bail, because unlike every other
  // working preset it deliberately spans open AND closed threads — an
  // unresolved complaint on a thread someone closed is exactly what must not
  // fall off the radar. Without this case it fell through to the final
  // `return true`, so any conversation receiving a message would splice itself
  // into the Flagged view.
  if (filter.id === "flagged") return (row.conversation.openFlagCount ?? 0) > 0;
  if (row.conversation.status === "closed") return false;
  if (filter.id === "mine") return row.conversation.assignedUserId === currentUserId;
  if (filter.id === "unassigned") return row.conversation.assignedUserId === null;
  return true; // "active"
}

/**
 * Bounded FIFO of `message:new` ids the list has already absorbed, so a
 * Socket.io connection-state-recovery REPLAY (or a late/out-of-order
 * re-delivery) of the same frame is a no-op instead of re-unshifting the row /
 * re-applying a stale absolute unreadCount. Mirrors the same dedupe the
 * notification-sound provider keeps. 400 ≫ the few seconds of frames the
 * recovery buffer can hold, so a genuine message is never evicted before its
 * own replay could arrive.
 */
const MESSAGE_DEDUP_CAP = 400;

/** Ceiling on conversations retained in the loaded slice — see `loadMore`. */
const MAX_LOADED_CONVERSATIONS = 3_000;

/** Cap for the latest-known-contact overlay (see `latestContactRef`). Large
 *  enough to cover any realistic loaded slice plus recent team activity, small
 *  enough that a day-long tab can't accumulate a tenant's contact book. */
const LATEST_CONTACT_CAP = 2_000;

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
   * Set when this org restricts agents to their own conversations
   * (`Team.agentConversationVisibility = "assigned"` and the viewer is an
   * agent). The SERVER is the security boundary — it already refuses to list,
   * fetch or emit anything else — but the client must still react correctly to
   * a live handover, which is a UI concern the server can't fix for it:
   *
   *   assigned AWAY from me → drop the row immediately, whatever the filter
   *   assigned TO me        → the row was never in my slice, so go fetch it
   *
   * Without this a reassigned thread would linger in the previous owner's list
   * until their next refetch, and the new owner wouldn't see it arrive at all.
   */
  restrictedToOwn?: boolean,
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
  // True only while a filter-switch refetch is in flight (see TeamEventsState).
  const [refetching, setRefetching] = useState(false);

  // Stable filter ref so socket handlers + resync can read the latest
  // without re-binding on every change. Sync-assigned during render (not
  // via useEffect) — same reasoning as activeThreadRef below: a
  // dispatchLocalSocketEvent fired from a click handler immediately
  // after a filter change would otherwise see the OLD filter through this
  // ref, because the post-commit useEffect hasn't run yet. The filter-
  // change effect later in this file owns the actual refetch.
  const filterRef = useRef<Filter | undefined>(filter);
  filterRef.current = filter;

  // Stable ref mirror of the current conversation list. Read by socket
  // handlers that must decide a side effect (e.g. "is this conversation in the
  // loaded slice?" for off-slice recovery) BEFORE entering the pure
  // setConversations updater — the handler closure is bound on [teamId,
  // currentUserId] and would otherwise read a stale `conversations` snapshot.
  // Synced during render (not useEffect) so a synchronous local dispatch sees
  // the latest list, same reasoning as activeThreadRef below.
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

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
  // so the latest write here reflects the latest commit.
  //
  // CAPPED (was grow-only). The original note here read "one small entry per
  // contact the agent touches — negligible", but the only writer is the
  // `contact:updated` handler and that frame is `emitToTeam`: this records a
  // contact for every edit by ANY teammate and every workflow tag/stage change,
  // on contacts this agent has never opened. In a 50k-contact tenant with 40
  // agents, an inbox tab left open all day accumulates tens of thousands of
  // FULL Contact objects (customFields, tags, socialProfile JSON) that nothing
  // can reclaim short of a reload.
  //
  // Every consumer (the two resync overlays and the row-merge below) is a
  // best-effort correction — a miss just means that row keeps the server's
  // value, which is the pre-overlay behaviour — so FIFO eviction is safe.
  // Same shape as `seenMessageIdsRef` below.
  const latestContactRef = useRef<{ map: Map<string, Contact>; queue: string[] }>({
    map: new Map(),
    queue: [],
  });

  // Replay-dedupe for `message:new` (see MESSAGE_DEDUP_CAP). Keyed by the stable
  // message id — NOT by lastMessageAt, which is second-granular for WhatsApp and
  // therefore identical across two messages sent in the same second. Lives in a
  // ref so it survives re-renders and any re-run of the socket effect.
  const seenMessageIdsRef = useRef<{ set: Set<string>; queue: string[] }>({
    set: new Set(),
    queue: [],
  });

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

    const f = filterRef.current;
    // `initialConversations` is ALWAYS the UNFILTERED team-recency head
    // (page.tsx calls listConversations() with no filter). For the default
    // views (no filter / "active" / "all") that head IS the authoritative
    // slice, so adopt it wholesale (pruned through the active predicate).
    //
    // For a NON-default filter (Mine / Unassigned / Closed / stage), the
    // current list was loaded server-side-FILTERED (the full team's matching
    // threads, possibly deeper than the unfiltered top-25). Replacing it with
    // `filter(unfiltered head)` would TRUNCATE it to just the matching rows
    // that happen to sit in the team-wide top-25 — visibly shrinking the list
    // on any router.refresh() (e.g. a contact-panel field save). Instead MERGE:
    // keep every row we already hold and overlay the fresher seed copy for any
    // matching id, so a refresh can't demote filtered rows behind Load-more.
    const isDefaultView =
      !f || (f.kind === "preset" && (f.id === "active" || f.id === "all"));
    if (isDefaultView) {
      setConversations(
        initialConversations.filter((row) =>
          rowMatchesFilterFor(f, currentUserId, row),
        ),
      );
      setNextCursor(initialNextCursor);
      return;
    }
    // Non-default: merge the matching seed rows over the existing list without
    // dropping rows the seed doesn't cover. Cursor is left untouched — the
    // filtered list owns its own keyset cursor; the unfiltered seed cursor
    // doesn't apply to it.
    setConversations((prev) => {
      const seedMatching = initialConversations.filter((row) =>
        rowMatchesFilterFor(f, currentUserId, row),
      );
      if (seedMatching.length === 0) return prev;
      const seedById = new Map(seedMatching.map((c) => [c.conversation.id, c]));
      // Overlay fresher seed copies onto existing rows...
      const merged = prev.map((c) => seedById.get(c.conversation.id) ?? c);
      // ...then append any seed rows not already present, recency-sorted.
      const haveIds = new Set(prev.map((c) => c.conversation.id));
      for (const row of seedMatching) {
        if (!haveIds.has(row.conversation.id)) merged.push(row);
      }
      merged.sort((a, b) =>
        a.conversation.lastMessageAt < b.conversation.lastMessageAt
          ? 1
          : a.conversation.lastMessageAt > b.conversation.lastMessageAt
            ? -1
            : 0,
      );
      return merged;
    });
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
  // FE-2: remember each row's pre-bump preview so a FAILED send can roll the
  // optimistic preview back instead of leaving a phantom on the list.
  const preBumpSnapshotRef = useRef<
    Map<
      string,
      {
        lastMessageAt: string;
        lastMessagePreview: string;
        lastMessageDirection: "in" | "out" | null;
        // minor#12: the optimistic bump values, so the revert can detect whether
        // a newer authoritative frame replaced our bump before clobbering it.
        bumpedLastMessageAt: string;
        bumpedPreview: string;
      }
    >
  >(new Map());
  useEffect(() => {
    return onOptimisticListBump(({ conversationId, preview, lastMessageAt }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        // Snapshot the CURRENT pre-bump preview/at/direction (FE-2). For
        // sequential sends this is the prior CONFIRMED preview (the previous
        // send's server frame already set it), so a revert restores the right
        // text. Rapid-fire before confirmation snapshots an optimistic preview —
        // a rare edge that self-corrects on the next authoritative frame.
        preBumpSnapshotRef.current.set(conversationId, {
          lastMessageAt: existing.conversation.lastMessageAt,
          lastMessagePreview: existing.conversation.lastMessagePreview,
          lastMessageDirection: existing.conversation.lastMessageDirection ?? null,
          // minor#12: remember what WE bumped the row to, so a later revert only
          // fires if the row still shows exactly this (i.e. nothing newer landed).
          bumpedLastMessageAt: lastMessageAt,
          bumpedPreview: preview,
        });
        const updated: ConversationWithRefs = {
          ...existing,
          conversation: {
            ...existing.conversation,
            lastMessageAt,
            lastMessagePreview: preview,
            // Optimistic bumps are always the agent's own outbound send.
            lastMessageDirection: "out",
          },
        };
        const next = [...prev];
        next.splice(idx, 1);
        next.unshift(updated);
        return next;
      });
    });
  }, []);

  // FE-2: a real server `message:new` confirms the send — drop the snapshot so a
  // later unrelated failure can't wrongly revert. A send FAILURE fires the
  // revert channel: restore the row's pre-bump preview (position self-corrects
  // on the next authoritative frame).
  useEffect(() => {
    return onOptimisticListBumpRevert((conversationId) => {
      const snap = preBumpSnapshotRef.current.get(conversationId);
      preBumpSnapshotRef.current.delete(conversationId);
      if (!snap) return;
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        // minor#12: only restore if the row STILL shows our optimistic bump. If a
        // genuine newer message (inbound, or another outbound) landed during the
        // send window it already overwrote the preview/at — reverting here would
        // clobber that newer preview with the stale pre-bump snapshot. (The
        // surrounding comment always claimed this guard; it was never actually
        // implemented until now.)
        if (
          existing.conversation.lastMessageAt !== snap.bumpedLastMessageAt ||
          existing.conversation.lastMessagePreview !== snap.bumpedPreview
        ) {
          return prev;
        }
        const next = [...prev];
        next[idx] = {
          ...existing,
          conversation: {
            ...existing.conversation,
            lastMessageAt: snap.lastMessageAt,
            lastMessagePreview: snap.lastMessagePreview,
            lastMessageDirection: snap.lastMessageDirection,
          },
        };
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
  // Mirrors conversations.length so loadMore can check the ceiling without
  // taking `conversations` as a dep (which would rebuild the callback on every
  // realtime frame, re-running every effect that lists it).
  const loadedCountRef = useRef(0);
  useEffect(() => {
    loadedCountRef.current = conversations.length;
  }, [conversations]);

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    // Ceiling on the retained slice. Paging appended without any bound, so an
    // agent triaging a 50k-conversation inbox for a few hours retained every
    // page as a full ConversationWithRefs (conversation + contact +
    // assignedUser). Beyond the heap, EVERY accepted realtime frame scans this
    // array, and in "longest waiting" sort — which persists to localStorage, so
    // it survives sessions — each change re-sorts a copy of it. At 40 online
    // agents that is several frames a second doing O(n log n) over a slice with
    // no ceiling.
    //
    // We stop ADDING rather than trimming what is already loaded: trimming the
    // head would make rows disappear underneath an agent who has scrolled into
    // that region and would shift the virtualizer's total height under them.
    // Refusing to grow past the cap has no such effect — the list simply stops
    // extending, and finding something older is what search and filters are
    // for. The inbox is the app's highest-quality surface; a bounded list is
    // worth more here than an unbounded one that eventually stutters.
    //
    // Dropping the cursor (rather than just returning) hides the Load-more
    // affordance instead of leaving a button that silently does nothing —
    // the same move the thread slice makes when it hits MAX_THREAD_SLICE.
    if (loadedCountRef.current >= MAX_LOADED_CONVERSATIONS) {
      cursorRef.current = null;
      setNextCursor(null);
      return;
    }
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
      .catch(() => {
        // Network failure paging the next page — silently degrade (the button
        // just does nothing) instead of throwing an unhandled rejection. The
        // cursor is untouched, so the next Load-more click retries cleanly.
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
      : filter.kind === "stage"
        ? `s:${filter.stageId}`
        : "calls"
    : "p:all";
  const lastFilterKeyRef = useRef<string | null>(null);
  // LAYOUT effect (not useEffect): the instant re-derive below must run BEFORE
  // the browser paints. On a switch from a NARROW filter to a disjoint one
  // (e.g. Active → Closed), the loaded slice has no matching rows, so a plain
  // post-paint effect let the stale/empty frame paint for ~1 frame before the
  // skeleton — the "bad flash" the user saw. Running it pre-paint means the
  // skeleton (or the kept rows, for All/Active supersets) is what actually
  // paints. The async fetch below is unchanged.
  useIsomorphicLayoutEffect(() => {
    // Skip the initial mount — SSR data is current, no refetch needed.
    if (lastFilterKeyRef.current === null) {
      lastFilterKeyRef.current = filterKey;
      return;
    }
    if (lastFilterKeyRef.current === filterKey) return;
    lastFilterKeyRef.current = filterKey;

    let cancelled = false;

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

    // Signal "loading" so the list shows a skeleton instead of the empty state
    // when the instant re-derive above pruned to zero (loaded slice had no rows
    // for this filter). Cleared when the fetch settles.
    setRefetching(true);

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
      .catch(() => {
        // Network-level rejection during a filter switch. The instant
        // client-side re-derive above already pruned the list to a (possibly
        // partial) local slice; we silently degrade and let the next
        // reconnect/visibility resync reconcile the full filtered page — same
        // convention every sibling recovery path follows. Swallowing also
        // prevents an unhandled-promise-rejection that would pollute error
        // triage.
      })
      .finally(() => {
        if (!cancelled) setRefetching(false);
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

    async function resyncOnce(dropStaleTail = false): Promise<boolean> {
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
          const overlay = latestContactRef.current.map;
          if (overlay.size > 0) {
            const pageStageByContact = new Map(
              page.items.map((c) => [c.contact.id, c.contact.stageId ?? null]),
            );
            for (const [contactId, c] of overlay) {
              const pageStage = pageStageByContact.get(contactId);
              if (pageStage !== undefined && pageStage === (c.stageId ?? null)) {
                overlay.delete(contactId);
                const q = latestContactRef.current.queue;
                const qi = q.indexOf(contactId);
                if (qi >= 0) q.splice(qi, 1);
              }
            }
          }
        }

        setConversations((prev) => {
          const freshIds = new Set(page.items.map((c) => c.conversation.id));
          const overlay = latestContactRef.current.map;

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
          // Tail = local rows the page didn't return.
          //
          // Two kinds live here: (a) NEWER realtime arrivals that landed
          // mid-fetch (their lastMessageAt is at/above the fresh head), and
          // (b) OLDER rows the agent paged into via loadMore BEFORE the offline
          // gap. The contact overlay corrects each row's embedded contact, but
          // status / assignedUserId / unreadCount / preview on (b) stay frozen
          // at whatever they showed before the drop — a teammate's
          // assign/close/read during the gap never reached us, so a deep-paged
          // row can show a stale assignee or status until something touches it.
          //
          // On a RECONNECT (dropStaleTail), drop the (b) rows — those older than
          // the fresh page's oldest row — and re-anchor the cursor to the fresh
          // page so loadMore re-pages them with CURRENT data. (a) rows (newer
          // than the page's tail) are kept: they're fresh socket arrivals, not
          // stale. On the cheap 50ms coalesced/visibility resync we DON'T drop
          // (no offline gap to recover from, and shrinking-then-repaging would
          // jank the list on every teammate edit).
          const oldestFresh =
            page.items.length > 0
              ? page.items[page.items.length - 1]!.conversation.lastMessageAt
              : null;
          const tail = prev
            .filter((c) => !freshIds.has(c.conversation.id))
            .filter((c) =>
              dropStaleTail && oldestFresh !== null
                ? c.conversation.lastMessageAt >= oldestFresh
                : true,
            )
            .map((c) => {
              const latest = overlay.get(c.contact.id);
              return latest ? { ...c, contact: latest } : c;
            });
          return [...reconciledPage, ...tail].filter(rowMatchesFilter);
        });
        // On a reconnect drop-tail, re-anchor pagination to the fresh head so
        // the dropped older rows re-page with current status/assignment.
        if (dropStaleTail) setNextCursor(page.nextCursor);
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
        // Reconnect path → drop stale tail rows so deep-paged rows recover
        // their status/assignment, not just their contact.
        if (await resyncOnce(true)) return;
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

    // Single-conversation recovery. A `message:new` (or call frame) can target
    // a conversation NOT in the loaded slice when the frame carries no full row
    // — e.g. an inbound to an existing OPEN conversation that fell below the
    // 25-row head page (the server only attaches `newConversation` for
    // brand-new threads + reopens). Without recovery the row never surfaces in
    // the list while the tab stays foregrounded (`connect`-resync only fires on
    // a real reconnect), so a live customer message effectively disappears even
    // though the ding + sidebar unread count bumped. Fetch the one row and
    // splice it in at its recency slot if it matches the active filter. Bounded:
    // recoveringRef dedupes concurrent fetches for the same id so a burst of
    // frames for an off-slice conversation triggers one GET, not N.
    const recoveringIds = new Set<string>();
    function recoverConversation(conversationId: string): void {
      if (recoveringIds.has(conversationId)) return;
      recoveringIds.add(conversationId);
      void fetchWithSessionGuard(`/api/inbox/conversation/${conversationId}`)
        .then((r) =>
          r.ok
            ? (r.json() as Promise<{ data: ConversationWithRefs }>)
            : null,
        )
        .then((res) => {
          if (!res?.data) return;
          const row = res.data;
          // Apply the latest-known contact overlay so a stage/name change that
          // landed via socket between request + response isn't clobbered by the
          // fetched copy (same authority rule resyncOnce uses).
          const latest = latestContactRef.current.map.get(row.contact.id);
          const reconciled = latest ? { ...row, contact: latest } : row;
          // Suppress the unread badge for the thread the agent is viewing — the
          // server markRead clears it a beat later, so without this it flashes.
          const next =
            reconciled.conversation.id === activeIdRef.current
              ? {
                  ...reconciled,
                  conversation: { ...reconciled.conversation, unreadCount: 0 },
                }
              : reconciled;
          setConversations((prev) => {
            if (!rowMatchesFilter(next)) {
              // No longer matches (filter changed mid-fetch, or the call left
              // it closed under an open-only preset) — drop a stale copy if one
              // somehow lingers, else no-op.
              const idx = prev.findIndex((c) => c.conversation.id === next.conversation.id);
              if (idx === -1) return prev;
              const out = prev.slice();
              out.splice(idx, 1);
              return out;
            }
            // Replace-or-insert at the recency slot. A call frame bumps
            // lastMessageAt server-side, so an ALREADY-loaded row must re-sort
            // to the top — insertByRecency alone bails on a dup, so drop the
            // existing copy first.
            const existingIdx = prev.findIndex(
              (c) => c.conversation.id === next.conversation.id,
            );
            const base = existingIdx === -1 ? prev : prev.filter((_, i) => i !== existingIdx);
            return insertByRecency(base, next);
          });
        })
        .catch(() => {
          // Silent — the row resurfaces on the next reconnect/visibility resync
          // or when lastMessageAt next advances into a loaded page.
        })
        .finally(() => {
          recoveringIds.delete(conversationId);
        });
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
      // Replay guard by message id — NOT by timestamp. Socket.io
      // connection-state-recovery REPLAYS buffered `message:new` frames on
      // reconnect, and a late/out-of-order delivery can re-arrive after the row
      // already absorbed that exact message. Dropping the re-delivery here is
      // what stops a replay from re-unshifting the row or re-applying a stale
      // ABSOLUTE unreadCount over a count the agent has since cleared — the
      // "unread reappears after I read it / row jumps to top" bug (fixed
      // 2026-05-23, originally with a strict `>` on lastMessageAt).
      //
      // The strict-`>` proxy was WRONG: WhatsApp timestamps are SECOND-granular
      // (meta.ts parses `ts*1000`, so the ms part is always .000), so two
      // genuinely-distinct messages sent in the SAME second carry an identical
      // lastMessageAt. `>` treated the 2nd/3rd of a same-second burst as a replay
      // and silently dropped the preview update, unread bump, sort-to-top AND the
      // new-message ding for the last message. An id is the only thing that tells
      // a real replay (same id) from a same-second new message (different id).
      const dedupeKey = message.id;
      if (dedupeKey) {
        const seen = seenMessageIdsRef.current;
        if (seen.set.has(dedupeKey)) return;
        seen.set.add(dedupeKey);
        seen.queue.push(dedupeKey);
        if (seen.queue.length > MESSAGE_DEDUP_CAP) {
          const evicted = seen.queue.shift();
          if (evicted !== undefined) seen.set.delete(evicted);
        }
      }

      // Off-slice recovery: this message targets a conversation NOT in the
      // loaded slice AND the server attached no full row (an inbound to an
      // existing OPEN conversation that sits below the head page). Trigger a
      // single-row recovery fetch so it surfaces — otherwise it's invisible in
      // every list view until the next reconnect/visibility resync. Decided in
      // the handler body (not the pure updater) and deduped by recoverConversation.
      if (
        !newConversation &&
        !conversationsRef.current.some((c) => c.conversation.id === conversationId)
      ) {
        recoverConversation(conversationId);
      }

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
                : f.kind === "calls"
                  ? false
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
          // Suppress the unread badge for a thread the agent is actively viewing
          // (e.g. a closed thread that reopens via inbound while it's open) —
          // markRead clears it a beat later anyway, so without this the row
          // splices in with a badge that flashes for ~200ms. Mirrors the
          // `isActive` suppression on the existing-row path below.
          const spliced =
            newConversation.conversation.id === activeIdRef.current
              ? {
                  ...newConversation,
                  conversation: { ...newConversation.conversation, unreadCount: 0 },
                }
              : newConversation;
          return [spliced, ...prev];
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
        // Recency guard — advance the preview / lastMessageAt / sort position /
        // unread when this frame is at least as recent as the row already shows.
        // `>=` (NOT `>`) is required for same-second messages: WhatsApp's
        // second-granular timestamps make the 2nd/3rd message of a burst share
        // lastMessageAt with the previous one, and they MUST still advance.
        // `>=` is only safe because the id-based replay guard at the top of this
        // handler already returned early for any re-delivered frame — so the only
        // way to reach here with `lastMessageAt === existing` is a genuinely NEW
        // same-second message (different id). An out-of-order OLDER inbound
        // carries an older lastMessageAt and is correctly left in place by `>=`.
        const advances = lastMessageAt >= existing.conversation.lastMessageAt;
        // The frame carries the ABSOLUTE team-wide unread count. Apply it for an
        // inbound frame the agent isn't viewing. Replays can't reach here (id
        // guard above), so this no longer needs `advances` to protect a cleared
        // count; still gated on `advances` so an out-of-order OLDER inbound
        // doesn't overwrite the count that a newer one already established.
        const nextUnread =
          message.direction === "in" && !isActive && advances
            ? unreadCount
            : existing.conversation.unreadCount;
        const updated: ConversationWithRefs = {
          ...existing,
          conversation: {
            ...existing.conversation,
            ...(advances
              ? {
                  lastMessageAt,
                  lastMessagePreview: preview,
                  lastMessageDirection: message.direction,
                }
              : {}),
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
      optimistic,
    }) => {
      const nextAssignedUserId = assignedUser?.id ?? null;
      // Restricted agent, handover TO me: the row can't be in my slice (the
      // server never sent it), so fetch it rather than trying to synthesize.
      // recoverConversation dedupes and filter-checks before splicing.
      if (restrictedToOwn && nextAssignedUserId === currentUserId) {
        recoverConversation(conversationId);
      }
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
        // Restricted agent, handover AWAY from me: drop it now, regardless of
        // the active filter. I can no longer open it, so leaving it visible
        // would only produce a row that 404s on click.
        if (restrictedToOwn && nextAssignedUserId !== currentUserId) {
          return prev.filter((c) => c.conversation.id !== conversationId);
        }
        // With server-side filtering, an assignment change can knock the
        // row out of the current view (e.g. filter is "mine" and a teammate
        // took the thread). Splice OUT when the new assignment no longer
        // matches the filter.
        const f = filterRef.current;
        const stillMatches =
          !f || f.kind === "stage" || f.kind === "calls"
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
      //
      // Skip on OPTIMISTIC local dispatches: the POST /assign hasn't
      // committed yet, so a re-fetch here can read PRE-change state and
      // (a) re-add a row we just spliced out, or (b) revert a row we just
      // patched. The post-commit server frame (optimistic absent) drives
      // convergence — same gate `onContactUpdated` already uses for stage.
      // Without this gate the user reports the list "vibrating" on every
      // assign as the row patches → reverts → patches again.
      if (!optimistic) scheduleFilterResync();
    };

    // A triage flag was raised / resolved / removed. The list cares about ONE
    // field — `openFlagCount`, which drives the row's flag badge and membership
    // of the "Flagged" preset. The frame carries the authoritative post-change
    // count, so there's nothing to recompute.
    const onFlag: Parameters<typeof socket.on<"message:flag">>[1] = ({
      conversationId,
      openFlagCount,
    }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) {
          // Not in the loaded slice. If it's the thread we're looking at and it
          // just became flagged while the Flagged filter is active, splice it
          // in — same courtesy onStatus does for a status change.
          const active = activeThreadRef.current;
          if (active && active.conversation.id === conversationId) {
            const nextRow: ConversationWithRefs = {
              ...active,
              conversation: { ...active.conversation, openFlagCount },
            };
            if (rowMatchesFilter(nextRow)) return insertByRecency(prev, nextRow);
          }
          return prev;
        }
        const existing = prev[idx]!;
        // Idempotent: a re-delivered frame with the same count is a no-op, and
        // returning `prev` by identity keeps the memoized rows from rerendering.
        if ((existing.conversation.openFlagCount ?? 0) === openFlagCount) return prev;
        const nextRow: ConversationWithRefs = {
          ...existing,
          conversation: { ...existing.conversation, openFlagCount },
        };
        // Resolving the last flag while viewing "Flagged" drops the row out of
        // the list, mirroring how a close drops it out of "Active".
        if (!rowMatchesFilter(nextRow)) {
          return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        }
        const next = prev.slice();
        next[idx] = nextRow;
        return next;
      });
    };

    const onStatus: Parameters<typeof socket.on<"conversation:status">>[1] = ({
      conversationId,
      status,
      optimistic,
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
            : f.kind === "stage" || f.kind === "calls"
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
      // Same skip-on-optimistic gate as onAssigned/onContactUpdated. See the
      // comment in onAssigned for the load-bearing rationale.
      if (!optimistic) scheduleFilterResync();
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
      {
        const overlay = latestContactRef.current;
        if (!overlay.map.has(contact.id)) overlay.queue.push(contact.id);
        overlay.map.set(contact.id, contact);
        if (overlay.queue.length > LATEST_CONTACT_CAP) {
          const evicted = overlay.queue.shift();
          if (evicted !== undefined) overlay.map.delete(evicted);
        }
      }
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
              // I-4: MERGE the fresh fields, don't REPLACE the embedded contact.
              // /api/contacts/lookup returns only {id,name,phoneNumber}, so a
              // replace wiped stageId/tags/customFields from every affected list
              // row — rowMatchesFilterFor's stage branch then dropped the row from
              // stage-filtered views (and per-stage counts) until a manual refetch.
              return { ...c, contact: { ...c.contact, ...fresh } };
            });
            return changed ? next : prev;
          });
          // I-4: the lightweight lookup can't carry the actually-changed fields
          // (the coalesced bulk path is tag add/remove), so converge to server
          // truth — resyncOnce refetches full conversation rows (incl. tags /
          // stageId / customFields) and self-heals filtered views.
          scheduleFilterResync();
        })
        .catch(() => {
          // Swallow — stale embedded contact is recoverable on next chat
          // switch (the cached thread is also evicted by inbox-shell's
          // bulk handler). No need to surface this transient miss.
        });
    };

    // Calls surface + reorder the inbox list. ingest-call.ts bumps
    // Conversation.lastMessageAt on call activity (so a missed/incoming call
    // rises for triage) and CREATES a brand-new conversation when a never-seen
    // number calls — but the thread-level reducers (call:incoming/ringing/
    // answered/ended) only patch the OPEN thread snapshot, never the LIST. So a
    // missed call from a new contact left NO visible trace in the list (no row
    // appears / reorders) until a manual refetch, and the list silently fell out
    // of server sort order. Route both lifecycle endpoints through
    // recoverConversation: it fetches the fresh row (correct lastMessageAt +
    // "📞 …" preview + status) and replace-or-inserts it at the recency slot,
    // surfacing a new call-conversation and re-sorting an existing one. Deduped
    // per id, so call:incoming followed by call:ended fires at most one in-flight
    // GET. (call:ringing/answered are mid-call transients that don't change the
    // list's sort key — skip them.)
    const onCallIncoming: Parameters<typeof socket.on<"call:incoming">>[1] = ({
      conversationId,
    }) => {
      if (conversationId) recoverConversation(conversationId);
    };
    const onCallEnded: Parameters<typeof socket.on<"call:ended">>[1] = ({
      conversationId,
    }) => {
      if (conversationId) recoverConversation(conversationId);
    };

    // Customer unsent / edited the thread's NEWEST message → the denormalized
    // list preview changed with no new message. Patch just the preview text in
    // place (no re-sort, no unread change). Guarded so an older correction can't
    // clobber a preview a newer message already advanced.
    const onConversationPreview: Parameters<
      typeof socket.on<"conversation:preview">
    >[1] = ({ conversationId, preview, lastMessageAt }) => {
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.conversation.id === conversationId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        if (
          lastMessageAt !== null &&
          existing.conversation.lastMessageAt > lastMessageAt
        ) {
          return prev; // a newer message already moved the preview forward
        }
        if (existing.conversation.lastMessagePreview === preview) return prev;
        const next = prev.slice();
        next[idx] = {
          ...existing,
          conversation: { ...existing.conversation, lastMessagePreview: preview },
        };
        return next;
      });
    };

    socket.on("message:flag", onFlag);
    socket.on("message:new", onMessageNew);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:status", onStatus);
    socket.on("conversation:read", onRead);
    socket.on("conversation:deleted", onConversationDeleted);
    socket.on("conversation:preview", onConversationPreview);
    socket.on("contact:updated", onContactUpdated);
    socket.on("contacts:bulk_updated", onContactsBulkUpdated);
    socket.on("call:incoming", onCallIncoming);
    socket.on("call:ended", onCallEnded);

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
      socket.off("message:flag", onFlag);
      socket.off("message:new", onMessageNew);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:status", onStatus);
      socket.off("conversation:read", onRead);
      socket.off("conversation:deleted", onConversationDeleted);
      socket.off("conversation:preview", onConversationPreview);
      socket.off("contact:updated", onContactUpdated);
      socket.off("contacts:bulk_updated", onContactsBulkUpdated);
      socket.off("call:incoming", onCallIncoming);
      socket.off("call:ended", onCallEnded);
    };
    // INVARIANT: this effect re-binds handlers ONLY on [teamId, currentUserId].
    // Every other value the handlers read (filter, activeThread, activeId, …) is
    // mirrored via a ref SYNCED DURING RENDER (filterRef/activeThreadRef/activeIdRef
    // above) — never in a useEffect — so the first event right after a chat-switch
    // already sees the fresh value. If you add a new handler dependency, mirror it
    // the SAME way; a useEffect-synced ref reintroduces the stale-first-event bug.
  }, [teamId, currentUserId]);

  return { conversations, hasMore: nextCursor !== null, loadingMore, loadMore, refetching };
}
