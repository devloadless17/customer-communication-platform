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
import { useLiveTeamName } from "@/hooks/use-live-team-name";
import { useInboxFilter } from "@/features/inbox/contexts/inbox-filter-context";
import { dispatchLocalSocketEvent, getClientSocket } from "@/lib/socket-client";
import { ThreadCache, type CachedThread } from "@/features/inbox/lib/thread-cache";
import {
  assertReducerCoverage,
  THREAD_REDUCER_EVENTS,
} from "@/features/inbox/lib/thread-reducers";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { apiFetch } from "@/lib/api/client-fetch";

import dynamic from "next/dynamic";

import { cn } from "@ccp/shared/utils";
import { ConnectionBanner } from "./connection-banner";
import { ConversationList } from "./conversation-list";
import { SnippetsProvider } from "./snippets-context";
import { MessageThread } from "./message-thread";
import { ContactPanel } from "./contact-panel";
import { CallPanel } from "@/features/calls/components/call-panel";
import { IncomingCallToast } from "@/features/calls/components/incoming-call-toast";
import { useCall } from "@/features/calls/hooks/use-call";
import { isBicAllowed } from "@ccp/shared/providers/calling-regions";
import { toast } from "@/lib/toast";

/**
 * Map a call-initiation 4xx reason to a one-line message for the call
 * panel. Centralised so every trigger surface (inbox header, future
 * contact-page Call button) shows the same copy.
 */
// Map a structured call-failure reason to human copy. Pure so the caller can
// BOTH set the in-panel error AND raise a toast — a pre-flight rejection tears
// down `liveCall` (which unmounts CallPanel, the only consumer of `callError`),
// so without the toast the message would never be seen.
function callReasonMessage(reason: string): string {
  switch (reason) {
    case "permission_required":
      return "Permission request sent to the customer. Try again once they accept.";
    case "bic_blocked_region":
      return "Outbound WhatsApp calls aren't supported in this customer's country.";
    case "permission_revoked":
      return "Calling permission was revoked. Wait for the customer to message you first.";
    case "rate_limited":
      return "WhatsApp limits how often you can request call permission from this customer (roughly once a day). Wait for them to accept the request or message you first.";
    case "daily_cap_reached":
      return "Daily limit reached: 5 connected calls per customer per 24 hours.";
    case "provider_not_configured":
      return "WhatsApp calling isn't configured for this team. Open Settings → WhatsApp.";
    case "provider_rejected":
      return "WhatsApp rejected the call. Make sure calling is enabled on your number.";
    case "mic_permission_denied":
      return "Allow microphone access in your browser to place calls.";
    case "rtc_setup_failed":
      return "Couldn't start the call. Check your microphone and try again.";
    case "network_error":
      return "Network problem. Check your connection and retry.";
    default:
      return "Couldn't start the call. Try again in a moment.";
  }
}

/**
 * True when Meta's calling permission for this contact is currently revoked
 * (revokedUntil is a future timestamp). Mirrors the backend initiateCall gate
 * so the Phone button is hidden up-front rather than surfacing a
 * `permission_revoked` 4xx after the click. Tolerant of null/undefined/bad
 * input — anything unparseable means "not revoked", matching the server's
 * conservative posture.
 */
function isCallPermissionRevoked(revokedUntil: string | null | undefined): boolean {
  if (!revokedUntil) return false;
  const t = new Date(revokedUntil).getTime();
  return Number.isFinite(t) && t > Date.now();
}

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
 * Selection lives in client state AND is mirrored into the URL as `?c=<id>`
 * via `history.replaceState` on every open (see openConversation). The chat
 * swap itself is still pure client state — no Next.js navigation, no segment
 * unmount, no skeleton flash — the URL write is a passive side-channel so a
 * HARD browser refresh re-SSRs the open thread (page.tsx reads `?c=`) and the
 * agent STAYS on the conversation instead of bouncing to the empty state. The
 * thread paints scrolled to the bottom on that refresh because useChatScroll
 * snaps to bottom on mount (see message-thread.tsx). A SOFT refresh
 * (`router.refresh()` from a mutation) re-runs page.tsx with the same `?c=`, so
 * initialActiveConversationId matches and the SSR sync block is a no-op — no
 * bounce either way. replaceState (not pushState) is deliberate: Back does NOT
 * walk through every chat clicked; one Back press leaves the inbox. A direct
 * /inbox?c=<id> link / bookmark still opens that thread on first load.
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
  canDeleteConversations,
  canMakeCalls,
  initialActiveConversationId,
  initialThread,
  initialContactPanelCollapsed,
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
  canDeleteConversations: boolean;
  /** Whether the agent can place outbound calls. Combined with channel +
   *  region check on a per-thread basis to decide whether to show the
   *  Phone button. */
  canMakeCalls: boolean;
  initialActiveConversationId: string | null;
  initialThread: CachedThread | null;
  /** Server-read cookie so the right panel SSRs in its persisted rail state. */
  initialContactPanelCollapsed: boolean;
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
  // One-shot deep-link target from a global-search "Messages" hit. Set when
  // the agent opens a message result; forwarded to MessageThread, which jumps
  // to it. Cleared as soon as the target conversation is the displayed one so
  // a later normal open doesn't re-jump. `{conversationId}` qualifies the id
  // so a stale target can't fire against the wrong thread.
  const [jumpTarget, setJumpTarget] = useState<{
    conversationId: string;
    messageId: string;
  } | null>(null);

  // Refs for stable callback identity — see T1.5/T2.6/T2.7 in the plan.
  // openConversation and the popstate listener used to read these via
  // closures that captured each new render's value; with refs the callbacks
  // are referentially stable, ConversationList stops re-rendering on every
  // state change, and the popstate listener is installed exactly once.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const displayedIdRef = useRef(displayedId);
  displayedIdRef.current = displayedId;

  // ---- WhatsApp voice calling ----
  // useCall owns the RTCPeerConnection lifecycle + subscribes to
  // call:sdp_offer / call:ended (call:sdp_offer carries BOTH the inbound offer
  // and the customer's answer SDP — trickle-ICE was removed since Meta uses
  // ICE-LITE, so there's no separate call:ice event). Mounted at the shell level so
  // a call survives thread switches. Side-effect (the IncomingCallToast +
  // CallPanel below) is rendered as a portal-like overlay; the inbox
  // layout doesn't shift when a call is in progress.
  const callApi = useCall();
  const [callError, setCallError] = useState<string | null>(null);

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

      // Any plain open clears a pending search-jump so a stale message target
      // can't re-fire on a later normal click. onOpenSearchResult re-sets it
      // immediately AFTER calling this when the open is a message hit.
      setJumpTarget(null);

      const cached = cache.has(conversationId);
      setActiveId(conversationId);
      setPendingId(cached ? null : conversationId);
      setErrorId(null);
      // Cache hit: swap the rendered thread synchronously so there's no
      // one-frame flash of the previous thread. Cache miss: leave
      // displayedId alone — fetchThread will update it when the data lands.
      if (cached) setDisplayedId(conversationId);

      // Mirror the selection into the URL with replaceState so a HARD refresh
      // re-SSRs this thread (page.tsx reads `?c=<id>`) and the agent stays on
      // the conversation instead of bouncing to the empty state. replaceState
      // (not pushState) keeps Back from walking through every chat clicked —
      // one Back press still leaves the inbox. The SSR sync block is unaffected
      // on a soft refresh: router.refresh() re-runs page.tsx with this same
      // `?c=`, so initialActiveConversationId matches and the sync is a no-op.
      if (typeof window !== "undefined") {
        window.history.replaceState(
          null,
          "",
          `/inbox?c=${encodeURIComponent(conversationId)}`,
        );
      }

      if (!cached) {
        void fetchThread(conversationId);
      }
    },
    [cache, fetchThread],
  );

  // ---------------------------------------------------------------
  // Global-search result handlers.
  // ---------------------------------------------------------------
  // onOpenSearchResult — open the hit's conversation, optionally jumping to a
  // specific message. Unlike openConversation it does NOT early-return when
  // the conversation is already active: a message hit in the open thread still
  // needs to set the jump target so the thread scrolls to that message.
  const onOpenSearchResult = useCallback(
    (target: { conversationId: string; messageId?: string }) => {
      // Order matters: openConversation clears any prior jump target, so set
      // ours AFTER it. Both setState calls batch into one render, and the
      // last write to jumpTarget wins — this one.
      openConversation(target.conversationId);
      setJumpTarget(
        target.messageId
          ? { conversationId: target.conversationId, messageId: target.messageId }
          : null,
      );
    },
    [openConversation],
  );

  // Jump to a message within the currently-displayed thread — used by the
  // contact panel's Files tab ("Jump" on an attachment row or "Go to
  // message" in the lightbox). Just re-uses jumpTarget; the thread's render
  // path already handles the scroll + flash.
  const goToMessageInActiveThread = useCallback(
    (messageId: string) => {
      const convId = displayedIdRef.current;
      if (!convId) return;
      setJumpTarget({ conversationId: convId, messageId });
    },
    [],
  );

  // onStartContactChat — a contact-tab hit with no conversation yet. Mirrors
  // the contact-drawer "Start chat" flow: get-or-create the conversation, then
  // open it. (POST /api/conversations/start re-chats a hard-deleted thread or
  // creates a fresh one; see project_start_conversation_endpoint.)
  const onStartContactChat = useCallback(
    async (contactId: string) => {
      try {
        const res = await apiFetch("/api/conversations/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId }),
        });
        if (!res.ok) return;
        const { conversationId } = (await res.json()) as {
          conversationId: string;
        };
        if (conversationId) openConversation(conversationId);
      } catch {
        // Non-fatal: the agent can retry; the contact directory still works.
      }
    },
    [openConversation],
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

    // Dev-only invariant: every event subscribed below (manual or via
    // THREAD_REDUCER_EVENTS) must be accounted for in thread-reducers.ts
    // — either in the iterated table or in REDUCER_EXCLUSIONS with a
    // load-bearing reason. Pairs with the same assertion in the live hook
    // so both sides of the "Realtime cache patch matrix" CLAUDE.md flags
    // get checked. No-op in production.
    const MANUAL_SHELL_EVENTS: readonly string[] = [
      "connect",
      "message:new",
      "note:new",
      "message:failed",
      "contacts:bulk_updated",
      "conversation:deleted",
    ];
    assertReducerCoverage([
      ...THREAD_REDUCER_EVENTS.map((e) => e.event as string),
      ...MANUAL_SHELL_EVENTS,
    ]);

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

  // The live conversation list is ALWAYS what the column renders. Search no
  // longer swaps the list out — the tabbed global search (InboxSearchPanel,
  // inside ConversationList) overlays it while a query is present. So the
  // list's pagination/load-more is purely the live list's now.
  const conversationList = live.conversations;
  const hasMore = live.hasMore;
  const loadingMore = live.loadingMore;
  const loadMore = live.loadMore;

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
  //
  // Released staggered (queue of 4 lanes) instead of mass-firing 12 fetches
  // at once. The latter was a thundering-herd against a freshly-booted api:
  // every tab refresh after a deploy fired N×12 parallel
  // `GET /api/inbox/conversation/:id` against the same process. With 4
  // lanes the first 4 fire immediately, the next 4 fire as those land
  // (typically ≤200ms apiece on the local network), and the agent's
  // first-click latency is functionally unchanged because the slot they
  // open is always in the first lane.
  useEffect(() => {
    const targets = initialConversations
      .slice(0, PREFETCH_TOP_N)
      .map((c) => c.conversation.id)
      .filter((id) => !cache.has(id));
    if (targets.length === 0) return;
    const PREFETCH_LANES = 4;
    let cancelled = false;
    const queue = targets.slice();
    const drainLane = async () => {
      while (!cancelled && queue.length > 0) {
        const id = queue.shift();
        if (!id) return;
        await fetchThread(id).catch(() => {
          // Per-thread failures are surfaced through fetchThread's own
          // setErrorId path; nothing to do here.
        });
      }
    };
    for (let i = 0; i < Math.min(PREFETCH_LANES, targets.length); i++) {
      void drainLane();
    }
    return () => {
      cancelled = true;
    };
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

  const liveTeamName = useLiveTeamName(team.name);
  useEffect(() => {
    const base = "Inbox · " + liveTeamName;
    document.title = totalUnread > 0 ? `(${totalUnread}) ${base}` : base;
  }, [totalUnread, liveTeamName]);

  const retryActive = useCallback(() => {
    if (!activeIdRef.current) return;
    setErrorId(null);
    void fetchThread(activeIdRef.current);
  }, [fetchThread]);

  // Outbound call initiator. Delegated to useCall — the hook does the
  // WebRTC SDP-offer dance (browser-generated) and the POST. We only need
  // to look up the displayed thread's contact name for the panel chrome
  // and surface any pre-flight rejection.
  const initiateCallForActiveThread = useCallback(async () => {
    const targetId = displayedIdRef.current;
    if (!targetId) return;
    setCallError(null);
    const snapshot = cache.get(targetId);
    const contactName = snapshot?.data.contact.name ?? "Customer";
    const result = await callApi.initiateOutbound(targetId, contactName);
    if (!result.ok) {
      const msg = callReasonMessage(result.reason);
      setCallError(msg);
      // Toast too — the pre-flight rejection already tore down `liveCall`, so
      // CallPanel (the only consumer of callError) is unmounted and wouldn't
      // show it. The toast guarantees the agent sees why the call didn't start.
      toast.error(msg);
    }
  }, [cache, callApi]);

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
      // Strip the `?c=` we wrote on open so a refresh from the mobile list view
      // stays on the list. replaceState (not push) keeps it off the back stack.
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
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadMore={loadMore}
              activeConversationId={activeId}
              pendingConversationId={pendingId}
              onOpenConversation={openConversation}
              onOpenSearchResult={onOpenSearchResult}
              onStartContactChat={onStartContactChat}
              onPrefetchConversation={fetchThread}
              canDeleteConversations={canDeleteConversations}
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
                canDeleteConversations={canDeleteConversations}
                canMakeCalls={
                  // Per-thread gate: capability + WhatsApp channel + region
                  // (BIC blocklist via contact country) + no fresh revocation.
                  // channel may be absent on legacy wire payloads; treat
                  // unknown as whatsapp (the only channel today). The revocation
                  // check mirrors the backend initiateCall gate so the button is
                  // hidden up-front instead of surfacing a permission_revoked
                  // 4xx after the agent clicks.
                  canMakeCalls &&
                  (displayedThread.data.conversation.channel ?? "whatsapp") ===
                    "whatsapp" &&
                  isBicAllowed(displayedThread.data.contact.countryCode ?? null) &&
                  !isCallPermissionRevoked(
                    displayedThread.data.contact.callPermissionRevokedUntil,
                  )
                }
                onInitiateCall={initiateCallForActiveThread}
                tags={tags}
                initialContactPanelCollapsed={initialContactPanelCollapsed}
                onMarkRead={handleMarkRead}
                onThreadSnapshot={handleThreadSnapshot}
                onMobileBack={onMobileBack}
                onGoToMessage={goToMessageInActiveThread}
                jumpToMessageId={
                  jumpTarget?.conversationId === displayedId
                    ? jumpTarget.messageId
                    : null
                }
              />
            ) : activeId && skeletonContact ? (
              <ChatSkeleton contact={skeletonContact} onMobileBack={onMobileBack} />
            ) : (
              <EmptyInboxState />
            )}
          </main>
        </div>
        <DevTools conversations={live.conversations} currentUser={currentUser} />

        {/* WhatsApp voice calling overlays — fixed-position, render
            independent of the thread that's open. The toast stack lives
            bottom-left, the in-call panel bottom-right; they never overlap
            with the inbox layout (no shift on mount). */}
        <IncomingCallToast
          onAnswer={(callId, contactName, conversationId) => {
            void callApi.answerIncoming(callId, contactName, conversationId);
          }}
          onReject={(callId) => {
            void callApi.reject(callId);
          }}
        />
        <CallPanel
          liveCall={callApi.liveCall}
          error={callError ?? callApi.error}
          onHangup={() => void callApi.hangup()}
          onSetMuted={callApi.setMuted}
          isMuted={callApi.isMuted}
        />
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
  canDeleteConversations,
  canMakeCalls,
  onInitiateCall,
  tags,
  initialContactPanelCollapsed,
  onMarkRead,
  onThreadSnapshot,
  onMobileBack,
  onGoToMessage,
  jumpToMessageId,
}: {
  thread: CachedThread;
  teamMembers: User[];
  currentUser: User;
  stageCatalog: ContactStage[];
  canManageStages: boolean;
  fieldDefinitions: ContactFieldDefinition[];
  contactPanelBuiltins: ContactPanelBuiltins;
  canManageContactFields: boolean;
  canDeleteConversations: boolean;
  canMakeCalls: boolean;
  onInitiateCall: () => void | Promise<void>;
  tags: Tag[];
  initialContactPanelCollapsed: boolean;
  onMarkRead: (conversationId: string) => void;
  onThreadSnapshot: (
    data: ConversationWithRefs,
    nextOlderCursor: string | null,
  ) => void;
  onMobileBack: () => void;
  /** Jump the displayed thread to a specific message id — wired to the
   *  contact-panel's Files tab so an attachment thumbnail / lightbox row
   *  can scroll-and-flash the source bubble. */
  onGoToMessage: (messageId: string) => void;
  /** Deep-link target from a global-search "Messages" hit; forwarded to
   *  MessageThread to scroll to that message. Null on a normal open. */
  jumpToMessageId: string | null;
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
        canDeleteConversations={canDeleteConversations}
        canMakeCalls={canMakeCalls}
        onInitiateCall={onInitiateCall}
        onMarkRead={onMarkRead}
        onSnapshot={onThreadSnapshot}
        onMobileBack={onMobileBack}
        jumpToMessageId={jumpToMessageId}
      />
      <ContactPanel
        data={thread.data}
        fieldDefinitions={fieldDefinitions}
        builtins={contactPanelBuiltins}
        canManageFields={canManageContactFields}
        tagCatalog={tags}
        teamMembers={teamMembers}
        currentUserName={currentUser.name}
        initialCollapsed={initialContactPanelCollapsed}
        onGoToMessage={onGoToMessage}
      />
      {/* No SSR bottom-snap script anymore: the thread viewport is
          `flex-direction: column-reverse` (message-thread.tsx), so the browser
          anchors at the bottom (newest) on first layout — the SSR'd thread paints
          at the latest message with zero JS, no hydration jump, no inline script,
          no CSP nonce. */}
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
