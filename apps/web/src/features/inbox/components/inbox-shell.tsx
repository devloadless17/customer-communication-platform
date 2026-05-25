"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, ChevronLeft, Inbox as InboxIcon } from "lucide-react";

import type {
  Contact,
  ContactFieldDefinition,
  ContactPanelBuiltins,
  ContactStage,
  ConversationWithRefs,
  SnippetItem,
  Tag,
  Team,
  User,
} from "@ccp/shared/types";
import { useTeamEvents } from "@/features/team-chat/hooks/use-team-events";
import { useConnectionStatus } from "@/hooks/use-connection-status";
import { useConversationSearch } from "@/features/inbox/hooks/use-conversation-search";
import { useInboxFilter } from "@/features/inbox/contexts/inbox-filter-context";
import { dispatchLocalSocketEvent, getClientSocket } from "@/lib/socket-client";
import { ThreadCache, type CachedThread } from "@/features/inbox/lib/thread-cache";
import { THREAD_REDUCER_EVENTS } from "@/features/inbox/lib/thread-reducers";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";

import dynamic from "next/dynamic";

import { cn } from "@ccp/shared/utils";
import { ConnectionBanner } from "./connection-banner";
import { ConversationList } from "./conversation-list";
import { SnippetsProvider } from "./snippets-context";
import { MessageThread } from "./message-thread";
import { ContactPanel } from "./contact-panel";

// DevTools is dev-only — it bundles framer-motion + a handful of lucide
// icons just to render `null` when NODE_ENV === "production". Using
// `next/dynamic` here so the entire DevTools chunk is never sent to prod
// users. In dev, the chunk loads on demand the first time the shell
// renders. The `() => null` SSR stub stops the boot-time warning about
// non-deterministic SSR output.
const DevTools =
  process.env.NODE_ENV === "production"
    ? (function DevToolsStub(): null {
        return null;
      } as unknown as React.ComponentType<{
        conversations: ConversationWithRefs[];
        currentUser: User;
      }>)
    : dynamic(() => import("./dev-tools").then((m) => m.DevTools), {
        ssr: false,
        loading: () => null,
      });

const PREFETCH_TOP_N = 12;
// LRU cap. ~40 threads × ~30 messages × ~1.5KB per message ≈ 2MB heap budget,
// which is fine. Sized to comfortably cover an agent's hot-set across a long
// shift without unbounded growth.
const CACHE_MAX_ENTRIES = 40;
// In-flight fetches that never resolve (server hang, dropped TCP after-headers,
// browser tab throttling under battery saver) would otherwise leak their entry
// in fetchControllers forever. 30s is way past p99 for this endpoint and won't
// false-trip on a normal slow network.
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Single-page inbox workspace.
 *
 * Owns the active conversation id as internal state so chat switching is a
 * client-only state swap — no Next.js navigation, no segment unmount, no
 * loading skeleton flash.
 *
 * Selection is CLIENT-STATE ONLY — we do NOT push `?c=<id>` into the URL on a
 * chat switch. The URL stays at /inbox, so a HARD browser refresh lands on the
 * clean "pick a conversation" empty state (SSR sees no `?c=` → null thread),
 * while a SOFT refresh (`router.refresh()` from a mutation) preserves this
 * client state and keeps you on the thread — no bounce. Deliberate UX choice
 * (see [[project_nav_shell_ux_decisions_2026_05_23]]); the tradeoff is no
 * per-thread shareable URL and no browser back/forward between threads. A
 * direct /inbox?c=<id> link still opens that thread on first load (page.tsx
 * SSRs it), so external/bookmarked deep-links keep working on ENTRY.
 *
 * Per-thread data flow:
 *   1. SSR seeds the cache with `initialThread` (only when the inbound URL had
 *      ?c=<id>, e.g. a direct link). First paint = full thread visible.
 *   2. Clicking a chat in the list calls `openConversation(id)`:
 *        a. Internal state flips → the row's `active` style updates instantly.
 *        b. Cache lookup. Hit → render the new thread immediately. Miss →
 *           keep the previously-displayed thread on screen while a fetch
 *           lands in the background. If there's nothing to fall back to
 *           (first cold click), render a chat-shaped skeleton with the
 *           target contact's name pulled from the team-events list.
 *
 * Cache freshness for non-displayed threads: a shell-level socket listener
 * EVICTS the cached snapshot of any conversation that received a `message:new`
 * or `note:new` while the agent was looking at a different thread. The next
 * click on that conversation is a fresh fetch — slower by one round-trip but
 * never stale. Cheaper events (status / read / assigned / contact updates)
 * are absorbed by the team-events conversation-list state; the cached thread
 * gets refreshed the next time the agent opens it.
 */
export function InboxShell({
  currentUser,
  team,
  teamMembers,
  conversations: initialConversations,
  nextConversationCursor,
  snippets,
  stages,
  fieldDefinitions,
  contactPanelBuiltins,
  tags,
  canManageStages: canManageStagesPerm,
  canManageContactFields,
  initialActiveConversationId,
  initialThread,
}: {
  currentUser: User;
  team: Team;
  teamMembers: User[];
  conversations: ConversationWithRefs[];
  nextConversationCursor: string | null;
  snippets: SnippetItem[];
  stages: ContactStage[];
  fieldDefinitions: ContactFieldDefinition[];
  contactPanelBuiltins: ContactPanelBuiltins;
  tags: Tag[];
  canManageStages: boolean;
  canManageContactFields: boolean;
  initialActiveConversationId: string | null;
  initialThread: CachedThread | null;
}) {
  // Filter lives in the layout-level InboxFilterProvider so it's shared with
  // the sub-sidebar (which now renders in /inbox/layout.tsx and owns the
  // setter). Read-only here — the conversation list + live hook consume it.
  const { filter } = useInboxFilter();
  const [search, setSearch] = useState("");

  // -----------------------------------------------------------------
  // Active conversation + per-thread cache.
  //
  // Two separate ids: `activeId` is what the user CLICKED (drives URL,
  // list highlight, "current selection"); `displayedId` is what's
  // currently being rendered in the thread/panel area. They diverge only
  // during a cache miss — we keep the previous thread visible while the
  // new one's data is in flight, then swap the moment it lands. Selection
  // feedback stays instant because the list reads `activeId`.
  //
  // The cache itself is an LRU (mutated freely, no re-renders by itself);
  // `cacheTick` is the version counter that triggers re-renders when a
  // cache write affects the displayed thread. `errorId` and `pendingId`
  // surface fetch state to the row + thread pane.
  // -----------------------------------------------------------------
  const [activeId, setActiveId] = useState<string | null>(initialActiveConversationId);
  const [displayedId, setDisplayedId] = useState<string | null>(initialActiveConversationId);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [cacheTick, setCacheTick] = useState(0);

  // Refs for stable callback identity — see T1.5/T2.6/T2.7 in the plan.
  // openConversation and the popstate listener used to read these via
  // closures that captured each new render's value; with refs the callbacks
  // are referentially stable, ConversationList stops re-rendering on every
  // state change, and the popstate listener is installed exactly once.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const displayedIdRef = useRef(displayedId);
  displayedIdRef.current = displayedId;

  const fetchControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Tracks whether the socket "connect" listener has fired at least once
  // for the LIFETIME of this component instance (not just the current
  // effect run). Was a plain object inside the effect — if that effect
  // ever re-ran (deps change), the flag reset and the next reconnect was
  // wrongly classified as "first connect" → the cache.clearExcept call
  // was skipped → stale snapshots survived. With useRef the flag persists
  // across re-runs of the effect and the semantics actually hold.
  const hasConnectedOnceRef = useRef(false);

  // Cache is stable across renders — lazy-init via useState so we don't
  // reconstruct the LRU on every commit. The eviction callback aborts any
  // in-flight fetch for the evicted id so a late response doesn't write
  // back into the cache and immediately evict something useful.
  const [cache] = useState<ThreadCache>(() => {
    return new ThreadCache(CACHE_MAX_ENTRIES, (id) => {
      const ctrl = fetchControllersRef.current.get(id);
      if (ctrl) {
        ctrl.abort();
        fetchControllersRef.current.delete(id);
      }
    });
  });

  // Render-time prop sync. The "did the SSR'd value actually change" guard
  // is critical — openConversation() switches threads purely in client state
  // (no navigation, no `?c=`), so page.tsx doesn't re-run and
  // initialActiveConversationId stays stable across normal click navigation.
  // On the steady-state /inbox URL it's null, so this sync is a no-op on a
  // soft refresh (null === null) and the active thread is NOT reset — that's
  // what keeps soft-refresh on the thread while a hard refresh shows empty.
  // Sync only fires when something else (router.replace from
  // useConversationEvents on deletion, an external navigation / direct link to
  // /inbox with a new ?c=) actually changes the SSR'd value.
  const [lastSyncedInitialId, setLastSyncedInitialId] = useState(initialActiveConversationId);
  if (lastSyncedInitialId !== initialActiveConversationId) {
    setLastSyncedInitialId(initialActiveConversationId);
    setActiveId(initialActiveConversationId);
    setDisplayedId(initialActiveConversationId);
    setPendingId(null);
    setErrorId(null);
    if (initialThread && initialActiveConversationId) {
      cache.set(initialActiveConversationId, initialThread);
    }
  } else if (initialThread && initialActiveConversationId && !cache.has(initialActiveConversationId)) {
    // First-render cache seed for the SSR'd thread.
    cache.set(initialActiveConversationId, initialThread);
  }

  const displayedThread = displayedId ? cache.get(displayedId) ?? null : null;
  // Reading `cacheTick` here is what couples cache writes to renders.
  void cacheTick;

  // ---------------------------------------------------------------
  // Fetch
  // ---------------------------------------------------------------
  const fetchThread = useCallback(
    async (conversationId: string) => {
      if (cache.has(conversationId)) return;
      // Already in flight → don't dog-pile. The original requester's promise
      // will resolve and update state. Subsequent calls are no-ops.
      if (fetchControllersRef.current.has(conversationId)) return;

      const controller = new AbortController();
      fetchControllersRef.current.set(conversationId, controller);
      const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetchWithSessionGuard(`/api/inbox/conversation/${conversationId}`, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 404) {
            // Conversation doesn't exist (deleted, wrong team, typo'd id) —
            // drop the URL/state silently. No error banner; the empty state
            // is the right answer.
            if (activeIdRef.current === conversationId) {
              setActiveId(null);
              setDisplayedId(null);
              setPendingId(null);
              if (typeof window !== "undefined") {
                window.history.replaceState(null, "", "/inbox");
              }
            }
          } else {
            // 500 / 403 / something transient — surface a banner with Retry
            // instead of stranding the agent on the previous thread.
            if (activeIdRef.current === conversationId) {
              setErrorId(conversationId);
            }
          }
          return;
        }
        const payload = (await res.json()) as CachedThread;
        cache.set(conversationId, payload);

        // Only update render state if the agent is still targeting this id.
        // Otherwise: the fetch landed AFTER a newer click; their click's own
        // fetch will resolve next and win.
        if (activeIdRef.current === conversationId) {
          setDisplayedId(conversationId);
          setErrorId(null);
          setCacheTick((t) => t + 1);
        } else {
          // Cache was updated but we don't need an immediate re-render — the
          // next openConversation back to this id will hit the cache.
        }
      } catch (err) {
        // AbortError is expected on rapid replacement / unmount; quietly drop.
        const isAbort =
          err instanceof DOMException && err.name === "AbortError";
        if (!isAbort && activeIdRef.current === conversationId) {
          setErrorId(conversationId);
        }
      } finally {
        window.clearTimeout(timeoutId);
        // Only clear the controller if we're still the current one (a
        // replacement fetch might have installed a newer controller under
        // the same key).
        if (fetchControllersRef.current.get(conversationId) === controller) {
          fetchControllersRef.current.delete(conversationId);
        }
        setPendingId((curr) => (curr === conversationId ? null : curr));
      }
    },
    [cache],
  );

  // ---------------------------------------------------------------
  // openConversation — the click handler the list dispatches to.
  // Stable across renders thanks to refs (no `activeId` in deps).
  // ---------------------------------------------------------------
  const openConversation = useCallback(
    (conversationId: string) => {
      if (conversationId === activeIdRef.current) return;

      const cached = cache.has(conversationId);
      setActiveId(conversationId);
      setPendingId(cached ? null : conversationId);
      setErrorId(null);
      // Cache hit: swap the rendered thread synchronously so there's no
      // one-frame flash of the previous thread. Cache miss: leave
      // displayedId alone — fetchThread will update it when the data lands.
      if (cached) setDisplayedId(conversationId);

      // Intentionally NO `history.pushState("?c=<id>")` here — selection is
      // client-state only so a hard refresh lands on the empty state (see the
      // file header). The SSR sync block (initialActiveConversationId) is left
      // untouched: on the normal /inbox flow it stays null, so a soft refresh
      // never resets this selection.

      if (!cached) {
        void fetchThread(conversationId);
      }
    },
    [cache, fetchThread],
  );

  // popstate listener — handles browser back/forward AND the rare case where
  // useConversationEvents.replace fires (we adopt the URL change). Installed
  // exactly once because deps are stable.
  useEffect(() => {
    function onPopState() {
      const params = new URLSearchParams(window.location.search);
      const next = params.get("c");
      if (next === activeIdRef.current) return;
      if (!next) {
        setActiveId(null);
        setDisplayedId(null);
        setPendingId(null);
        setErrorId(null);
        return;
      }
      setActiveId(next);
      setErrorId(null);
      const cached = cache.has(next);
      if (cached) setDisplayedId(next);
      setPendingId(cached ? null : next);
      if (!cached) void fetchThread(next);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [cache, fetchThread]);

  // ---------------------------------------------------------------
  // Live team-wide list (preserved from the previous shell).
  // ---------------------------------------------------------------
  // Pass the displayed thread's full row so the team-events hook can
  // optimistically splice it INTO the filtered list when a local change
  // (status, assignment, stage) makes it newly match the active filter.
  // Without this the row only appeared after the resync fetch landed —
  // the visible "1 second lag" the user reported when changing a chat's
  // stage with a stage filter active, or closing a chat with the Closed
  // preset active. The hook only reads this when handling such an event;
  // a fresh ref on cache.patch doesn't cost extra re-renders.
  const live = useTeamEvents(
    team.id,
    initialConversations,
    nextConversationCursor,
    activeId,
    currentUser.id,
    filter,
    displayedThread?.data ?? null,
  );

  // Memoized lookup for the cache-miss skeleton (needs the contact for the
  // chat-shaped placeholder) and the cache-invalidation socket listener
  // (needs to know whether an id is one we care about). The ref shadow lets
  // the socket listener read the latest map without being a dep on the
  // listener effect.
  const conversationById = useMemo(() => {
    const map = new Map<string, ConversationWithRefs>();
    for (const c of live.conversations) {
      map.set(c.conversation.id, c);
    }
    return map;
  }, [live.conversations]);
  const conversationsByIdRef = useRef(conversationById);
  conversationsByIdRef.current = conversationById;

  // ---------------------------------------------------------------
  // Cache-miss skeleton metadata: when activeId is set but no thread is
  // displayed yet (first cold click before fetchThread lands), use whatever
  // we know from the team list to render a chat-shaped placeholder with the
  // contact's name. Much nicer than the empty "No conversation selected"
  // state, especially with a Retry button on error.
  const skeletonContact: Contact | null = useMemo(() => {
    if (!activeId || displayedThread) return null;
    return conversationById.get(activeId)?.contact ?? null;
  }, [activeId, displayedThread, conversationById]);

  // ---------------------------------------------------------------
  // Cache invalidation for non-displayed threads — T1.1.
  //
  // The thread the agent is actively viewing is kept fresh by
  // useConversationEvents inside MessageThread. But cached snapshots for OTHER
  // conversations don't see the active-thread reducers, so a `message:new` or
  // `note:new` arriving while the agent is on a different chat would leave the
  // cache stale. On next click back, the agent would see an out-of-date thread
  // until useConversationEvents' `?after=...` backfill fills the gap.
  //
  // Cheapest fix: evict the cached snapshot. The next click is then a fresh
  // fetch — one round trip slower, but never stale. The "previous thread
  // stays visible" pattern + skeleton with contact name keeps the UX smooth
  // even on that one-time miss.
  //
  // Every event that updates the LIVE displayed thread but isn't already
  // covered by message/note eviction is also patched into the cache below.
  // Without these patches, switching chats unmounts MessageThread, and on
  // chat-back the shell re-seeds it from a stale cached snapshot — visible
  // as: status reverting, assignment reverting, delivered checkmarks gone,
  // media stuck on "Downloading…", a teammate-deleted note reappearing,
  // or the unread badge surviving a teammate's read.
  // ---------------------------------------------------------------
  useEffect(() => {
    const socket = getClientSocket();

    type PayloadWithConversation = { conversationId: string };
    const evictIfBackground = (payload: PayloadWithConversation) => {
      if (!payload?.conversationId) return;
      if (payload.conversationId === displayedIdRef.current) return;
      cache.delete(payload.conversationId);
    };

    // Coalesced bulk version — server fires this from bulk-tag etc. instead
    // of N per-contact frames to bound socket bandwidth on big batches.
    // Per-contact `contact:updated` frames go through the reducer table
    // below (target: "all"). The bulk frame doesn't carry contact bodies,
    // so we still evict + force a refetch on next click.
    const onContactsBulkUpdated = (payload: { contactIds: string[] }) => {
      if (!payload?.contactIds?.length) return;
      const affected = new Set(payload.contactIds);
      for (const c of conversationsByIdRef.current.values()) {
        const id = c.conversation.id;
        if (id === displayedIdRef.current) continue;
        const cached = cache.peek(id);
        if (cached && affected.has(cached.data.contact.id)) {
          cache.delete(id);
        }
      }
    };
    const onConversationDeleted = (payload: { conversationId: string }) => {
      if (!payload?.conversationId) return;
      cache.delete(payload.conversationId);
    };

    // Patches below keep the cached snapshot in sync with what
    // useConversationEvents applies to the LIVE displayed thread, so a
    // chat-switch round-trip doesn't revert to stale data. Both consumers
    // share the same reducers from @/features/inbox/lib/thread-reducers — when a
    // new event needs per-thread state, add a reducer there once and call
    // it from both the hook and here.
    //
    // `patchData` adapts a (ConversationWithRefs) → ConversationWithRefs
    // reducer to ThreadCache's patch shape: returns null on identity-no-op
    // so the cache short-circuits and LRU order stays stable.
    const patchData = (
      conversationId: string,
      reducer: (data: ConversationWithRefs) => ConversationWithRefs,
    ) => {
      cache.patch(conversationId, (curr) => {
        const next = reducer(curr.data);
        return next === curr.data ? null : { ...curr, data: next };
      });
    };

    // Bind a patch handler per reducer entry. The wiring is driven by
    // THREAD_REDUCER_EVENTS so adding a new event + reducer in
    // thread-reducers.ts auto-wires both this side and the live hook in
    // useConversationEvents. `target: "conversation"` patches by id;
    // `target: "all"` (e.g. `contact:updated`, which carries no
    // conversationId) walks every cached thread and lets the reducer's
    // identity bail decide which entries actually mutate.
    const reducerHandlers = THREAD_REDUCER_EVENTS.map(({ event, apply, target }) => {
      const handler = (payload: { conversationId?: string } & Record<string, unknown>) => {
        // Reducer try/catch — without it, a malformed payload from a
        // version-skewed server (post-deploy) throws inside the
        // setState updater, leaving cache state half-applied and
        // breaking subsequent updates. Isolate failures to this event.
        try {
          if ((target ?? "conversation") === "all") {
            cache.patchAll((curr) => {
               
              const next = (apply as any)(curr.data, payload);
              return next === curr.data ? null : { ...curr, data: next };
            });
            return;
          }
          if (!payload?.conversationId) return;
           
          patchData(payload.conversationId, (d) => (apply as any)(d, payload));
        } catch (err) {
           
          console.error(`[inbox-shell] reducer for "${event}" threw`, err);
        }
      };
       
      socket.on(event as any, handler as any);
      return { event, handler };
    });

    // Reconnect-after-disconnect handler. Any socket-driven cache patch
    // (assignment, status, read, message:status, …) that fired during the
    // gap missed the cache, so non-displayed snapshots can hold stale state.
    // Drop them all and force a refetch on the next visit. The displayed
    // thread is left alone — useConversationEvents owns it and re-syncs its
    // own state through the `?after=...` backfill on the same reconnect.
    // First connect is skipped: server-seeded data is current. The flag
    // lives outside the effect (useRef) so a re-run of the effect doesn't
    // reset it and re-classify a reconnect as "first connect".
    const onConnect = () => {
      if (!hasConnectedOnceRef.current) {
        hasConnectedOnceRef.current = true;
        return;
      }
      cache.clearExcept(displayedIdRef.current);
    };

    socket.on("connect", onConnect);
    socket.on("message:new", evictIfBackground);
    socket.on("note:new", evictIfBackground);
    // Background send failures invalidate the cached snapshot too — if a
    // teammate's tab is parked on a different conversation when our send
    // worker reports a failure, the cache should drop its pending-bubble
    // copy. Active-thread updates happen inside useConversationEvents.
    socket.on("message:failed", evictIfBackground);
    // `contact:updated` is now handled by the THREAD_REDUCER_EVENTS table
    // above (target: "all"), so non-displayed cached threads get PATCHED
    // (not evicted) and the displayed thread's LRU snapshot finally stays
    // in sync. The bulk version below stays on the eviction path because
    // its payload only carries ids, not contact bodies.
    socket.on("contacts:bulk_updated", onContactsBulkUpdated);
    socket.on("conversation:deleted", onConversationDeleted);

    return () => {
      socket.off("connect", onConnect);
      socket.off("message:new", evictIfBackground);
      socket.off("note:new", evictIfBackground);
      socket.off("message:failed", evictIfBackground);
      socket.off("contacts:bulk_updated", onContactsBulkUpdated);
      socket.off("conversation:deleted", onConversationDeleted);
      for (const { event, handler } of reducerHandlers) {
         
        socket.off(event as any, handler as any);
      }
    };
  }, [cache, currentUser.id]);

  // ---------------------------------------------------------------
  // Mark-read local convergence — T2.1.
  //
  // useConversationEvents fires the mark-read POST when the agent opens a
  // thread with unread > 0 (and on inbound / backfill). On success it calls
  // this back. We DON'T just patch the cache here — we dispatch the same
  // `conversation:read` frame the server broadcasts, so every existing
  // subscriber converges in one pass:
  //   1. useTeamEvents.onRead         → clears the LIST badge
  //   2. inbox-shell reducer (cache)  → patches the cached snapshot to 0
  //   3. useConversationEvents reducer→ zeros the live thread's unreadCount
  //      (so snapshot-on-leave can't write a stale 1 back into the cache)
  //
  // Why this matters: the LIST badge previously cleared ONLY via the server's
  // one-shot `conversation:read` socket frame. Once the DB unread is zeroed,
  // the CAS in markRead never publishes that frame again — so a SINGLE missed
  // delivery (socket not yet joined to the team room on a fresh open, a
  // throttled/backgrounded tab, a transient drop) left the badge stuck at >0
  // forever, reappearing on every chat-switch / navigation even though the DB
  // said read. Dispatching locally makes the clear deterministic and frame-
  // independent — the real server frame arriving later is absorbed by each
  // reducer's identity bail. Mirrors the optimistic dispatch every other inbox
  // mutation (status / assignment / contact) already does.
  // ---------------------------------------------------------------
  const handleMarkRead = useCallback(
    (conversationId: string) => {
      dispatchLocalSocketEvent("conversation:read", {
        teamId: team.id,
        conversationId,
        readByUserId: currentUser.id,
      });
    },
    [team.id, currentUser.id],
  );

  // ---------------------------------------------------------------
  // Snapshot-on-leave cache write-back.
  //
  // While a thread is displayed, MessageThread owns the live message slice
  // (sends, inbound, status, loaded older pages) — but the cached snapshot the
  // shell holds is never updated with those messages (message:new only EVICTS
  // background threads; the displayed thread is skipped). So a chat-switch-back
  // re-seeded MessageThread from the stale snapshot, and the `?after=` backfill
  // popped the missing messages in 0–1.5s later — a visible flash, most obvious
  // on a short emoji bubble. On unmount we write the live slice + cursor back.
  //
  // `patch` no-ops if the entry was evicted (don't resurrect a dropped thread)
  // and writes silently (no cacheTick bump): the displayed thread renders from
  // MessageThread's own state, only the NEXT mount reads the cache.
  // ---------------------------------------------------------------
  const handleThreadSnapshot = useCallback(
    (data: ConversationWithRefs, nextOlderCursor: string | null) => {
      cache.patch(data.conversation.id, () => ({ data, nextOlderCursor }));
    },
    [cache],
  );

  // Search keeps its own server-fed list when active.
  const searchState = useConversationSearch(search);

  const conversationList = searchState.active ? searchState.results : live.conversations;
  const hasMore = searchState.active
    ? searchState.nextCursor !== null
    : live.hasMore;
  const loadingMore = searchState.active ? searchState.loadingMore : live.loadingMore;
  const loadMore = searchState.active ? searchState.loadMore : live.loadMore;

  // useConnectionStatus is mounted for its side effect only; ConnectionBanner
  // reads the same hook to surface disconnect state.
  //
  // Presence + the teammate roster moved to InboxSubSidebarLive (rendered by
  // /inbox/layout.tsx) along with the rest of the sub-sidebar — that component
  // owns `usePresence` now. The user still shows as online here because the
  // sub-sidebar is always mounted on /inbox.
  //
  // useCatalogSync is provided by the layout's CatalogSyncBoundary now;
  // mounting it here would fire two refreshes per catalog change.
  useConnectionStatus();

  // Warm the cache for the top N conversations on mount so the agent's first
  // click never hits a cold cache. The hover-prefetch on rows covers anything
  // below this slice on demand.
  useEffect(() => {
    const targets = initialConversations
      .slice(0, PREFETCH_TOP_N)
      .map((c) => c.conversation.id)
      .filter((id) => !cache.has(id));
    targets.forEach((id) => void fetchThread(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Abort all in-flight fetches when the shell unmounts (navigating away from
  // /inbox). Stops the "React state update on unmounted component" warning
  // and frees bandwidth.
  useEffect(() => {
    const controllers = fetchControllersRef.current;
    return () => {
      controllers.forEach((c) => c.abort());
      controllers.clear();
    };
  }, []);

  const totalUnread = useMemo(() => {
    return live.conversations.reduce(
      (acc, c) =>
        acc +
        (c.conversation.status === "closed" ? 0 : c.conversation.unreadCount),
      0,
    );
  }, [live.conversations]);

  useEffect(() => {
    const base = "Inbox · " + team.name;
    document.title = totalUnread > 0 ? `(${totalUnread}) ${base}` : base;
  }, [totalUnread, team.name]);

  const retryActive = useCallback(() => {
    if (!activeIdRef.current) return;
    setErrorId(null);
    void fetchThread(activeIdRef.current);
  }, [fetchThread]);

  // Below md we run a single-pane mode: either the conversation list OR the
  // thread is on screen. The hamburger (in MobileShellChrome) opens the
  // AppRail + InboxSubSidebar drawer. The "back to list" affordance is the
  // mobile back button rendered inside the thread (added separately).
  const onMobileBack = useCallback(() => {
    setActiveId(null);
    setDisplayedId(null);
    setPendingId(null);
    setErrorId(null);
    if (typeof window !== "undefined") {
      // replaceState (not push) — selection isn't URL-backed, so there's no
      // ?c= to strip and we don't want a stray /inbox history entry.
      window.history.replaceState(null, "", "/inbox");
    }
  }, []);

  return (
    <SnippetsProvider snippets={snippets}>
      {/* AppRail + the inbox sub-sidebar + mobile chrome all live in
          /inbox/layout.tsx now (via SectionShell). This island is just the
          conversation list + thread workspace, mounted inside the layout's
          <main>, so a rail click paints the stable sub-sidebar instantly and
          only this region streams in behind loading.tsx. */}
      <div className="relative flex h-svh w-full overflow-hidden bg-background text-foreground">
        <ConnectionBanner />
        <div className="flex min-w-0 flex-1 overflow-hidden">
          {/* Mobile: ConversationList takes full width when no thread is
              active; hidden when a thread is open. Desktop: always visible
              as a fixed-width column. */}
          <div
            className={cn(
              "flex min-h-0 flex-1 md:flex-none",
              activeId ? "hidden md:flex" : "flex",
            )}
          >
            <ConversationList
              conversations={conversationList}
              stages={stages}
              filter={filter}
              search={search}
              onSearchChange={setSearch}
              searching={searchState.active && searchState.loading}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadMore={loadMore}
              activeConversationId={activeId}
              pendingConversationId={pendingId}
              onOpenConversation={openConversation}
              onPrefetchConversation={fetchThread}
            />
          </div>
          {/* Mobile: main pane visible only when a thread is active.
              Desktop: always visible. */}
          <main
            className={cn(
              "min-w-0 flex-1 border-border bg-background md:flex md:border-l",
              activeId ? "flex" : "hidden md:flex",
            )}
          >
            {errorId && errorId === activeId ? (
              <ThreadError onRetry={retryActive} />
            ) : displayedId && displayedThread ? (
              <ThreadWorkspace
                key={displayedId}
                thread={displayedThread}
                teamMembers={teamMembers}
                currentUser={currentUser}
                stageCatalog={stages}
                canManageStages={canManageStagesPerm}
                fieldDefinitions={fieldDefinitions}
                contactPanelBuiltins={contactPanelBuiltins}
                canManageContactFields={canManageContactFields}
                tags={tags}
                onMarkRead={handleMarkRead}
                onThreadSnapshot={handleThreadSnapshot}
                onMobileBack={onMobileBack}
              />
            ) : activeId && skeletonContact ? (
              <ChatSkeleton contact={skeletonContact} onMobileBack={onMobileBack} />
            ) : (
              <EmptyInboxState />
            )}
          </main>
        </div>
        <DevTools conversations={live.conversations} currentUser={currentUser} />
      </div>
    </SnippetsProvider>
  );
}

/**
 * Renders the thread + side panel for a single conversation. The `key=
 * {displayedId}` on the parent keeps unmount/mount semantics intact on chat
 * switch — that's the boundary at which MessageThread's local state
 * (composer-local UI, scroll offset, selection) is intentionally reset.
 */
function ThreadWorkspace({
  thread,
  teamMembers,
  currentUser,
  stageCatalog,
  canManageStages,
  fieldDefinitions,
  contactPanelBuiltins,
  canManageContactFields,
  tags,
  onMarkRead,
  onThreadSnapshot,
  onMobileBack,
}: {
  thread: CachedThread;
  teamMembers: User[];
  currentUser: User;
  stageCatalog: ContactStage[];
  canManageStages: boolean;
  fieldDefinitions: ContactFieldDefinition[];
  contactPanelBuiltins: ContactPanelBuiltins;
  canManageContactFields: boolean;
  tags: Tag[];
  onMarkRead: (conversationId: string) => void;
  onThreadSnapshot: (
    data: ConversationWithRefs,
    nextOlderCursor: string | null,
  ) => void;
  onMobileBack: () => void;
}) {
  return (
    <>
      <MessageThread
        data={thread.data}
        teamMembers={teamMembers}
        currentUser={currentUser}
        nextOlderCursor={thread.nextOlderCursor}
        stageCatalog={stageCatalog}
        tags={tags}
        fieldDefinitions={fieldDefinitions}
        canManageStages={canManageStages}
        onMarkRead={onMarkRead}
        onSnapshot={onThreadSnapshot}
        onMobileBack={onMobileBack}
      />
      <ContactPanel
        data={thread.data}
        fieldDefinitions={fieldDefinitions}
        builtins={contactPanelBuiltins}
        canManageFields={canManageContactFields}
        tagCatalog={tags}
        teamMembers={teamMembers}
      />
      {/* Previously this slot held an inline `<script>` that ran during
          HTML parse and slammed `[data-thread-scroll-root]`'s viewport to
          scrollHeight, so the very first paint already showed the bottom
          of the thread. React 19's dev mode now warns about ANY `<script>`
          rendered inside a Client Component (which inbox-shell is) because
          they only fire on the SSR pass — never on client re-renders. The
          effect was already redundant with useChatScroll's first
          useLayoutEffect (keyed on conversationId, runs synchronously
          BEFORE browser paint on both first mount and chat-switch) — see
          `apps/web/src/features/inbox/hooks/use-chat-scroll.ts:158-169`.
          The visible difference is at most a few ms of post-hydration
          layout time on the very first SSR render; thereafter it's
          indistinguishable. If a regression appears, the right re-fix is
          to render an equivalent script from a SERVER component (the
          inbox page) as a sibling AFTER InboxShell — not to bring back the
          client-component `<script>` and silence the warning. */}
    </>
  );
}

/**
 * Renders while a cache-miss fetch is in flight and there's no previously-
 * displayed thread to keep on screen. Pulls the contact's name from the team
 * list so the agent immediately sees "this is the chat I clicked" rather than
 * a generic spinner. Bubble silhouettes alternate sides + width to read as a
 * conversation, not a grid of grey boxes.
 */
const SKELETON_BUBBLES: Array<{ side: "in" | "out"; width: number }> = [
  { side: "in", width: 220 },
  { side: "in", width: 140 },
  { side: "out", width: 180 },
  { side: "out", width: 280 },
  { side: "in", width: 260 },
  { side: "out", width: 160 },
  { side: "in", width: 200 },
];

function ChatSkeleton({
  contact,
  onMobileBack,
}: {
  contact: Contact;
  onMobileBack?: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        {onMobileBack && (
          <button
            type="button"
            onClick={onMobileBack}
            aria-label="Back to conversations"
            className="-ml-1 inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <ChevronLeft className="size-5" />
          </button>
        )}
        <div className="size-9 animate-pulse rounded-full bg-muted/50" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="truncate text-sm font-semibold">{contact.name}</div>
          <div className="h-2.5 w-24 animate-pulse rounded bg-muted/30" />
        </div>
        <div className="ml-auto h-7 w-20 animate-pulse rounded-md bg-muted/30" />
      </header>
      <div className="flex flex-1 flex-col gap-3 overflow-hidden px-6 py-5">
        {SKELETON_BUBBLES.map((b, i) => (
          <div
            key={i}
            className={
              b.side === "out"
                ? "ml-auto flex max-w-[70%] flex-col items-end gap-1.5"
                : "mr-auto flex max-w-[70%] flex-col items-start gap-1.5"
            }
          >
            <div
              className={
                b.side === "out"
                  ? "h-9 animate-pulse rounded-2xl rounded-br-md bg-primary/20"
                  : "h-9 animate-pulse rounded-2xl rounded-bl-md bg-muted/50"
              }
              style={{ width: b.width }}
            />
            <div className="h-2 w-10 animate-pulse rounded bg-muted/30" />
          </div>
        ))}
      </div>
      <div className="border-t border-border px-4 py-3">
        <div className="h-10 w-full animate-pulse rounded-md bg-muted/30" />
      </div>
    </div>
  );
}

function ThreadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-medium">Couldn't load conversation</h2>
          <p className="text-sm text-muted-foreground">
            Something went wrong fetching this thread. The rest of the inbox is fine —
            try again, or click a different chat.
          </p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:bg-foreground/90"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function EmptyInboxState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-muted text-muted-foreground">
          <InboxIcon className="size-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-medium">No conversation selected</h2>
          <p className="text-sm text-muted-foreground">
            Pick a conversation from the list to start replying. Your team's most recent
            customer threads are sorted by activity.
          </p>
        </div>
      </div>
    </div>
  );
}
