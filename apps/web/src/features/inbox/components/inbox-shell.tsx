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
  Channel,
  Contact,
  ContactFieldDefinition,
  ContactPanelBuiltins,
  ContactStage,
  ConversationWithRefs,
  MessageFlagDefinition,
  SnippetItem,
  Tag,
  Team,
  User,
} from "@ccp/shared/types";
import { useTeamEvents } from "@/features/team-chat/hooks/use-team-events";
import { useConnectionStatus } from "@/hooks/use-connection-status";
import { useLiveTeamName } from "@/hooks/use-live-team-name";
import { useInboxFilter } from "@/features/inbox/contexts/inbox-filter-context";
import { useInboxViews } from "@/features/inbox/contexts/inbox-views-context";
import { dispatchLocalSocketEvent, getClientSocket } from "@/lib/socket-client";
import { ThreadCache, type CachedThread } from "@/features/inbox/lib/thread-cache";
import {
  assertReducerCoverage,
  THREAD_REDUCER_EVENTS,
} from "@/features/inbox/lib/thread-reducers";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { apiFetch } from "@/lib/api/client-fetch";
import { usePanelResize } from "@/features/inbox/hooks/use-panel-resize";
import { INBOX_LIST_WIDTH_COOKIE } from "@/features/inbox/lib/panel-cookies";

import dynamic from "next/dynamic";

import { cn } from "@ccp/shared/utils";
import { ConnectionBanner } from "./connection-banner";
import { ConversationList } from "./conversation-list";
import { SnippetsProvider } from "./snippets-context";
import { MessageFlagsProvider } from "./message-flags-context";
import { ConversationViewersProvider } from "@/features/inbox/contexts/conversation-viewers-context";
import { MessageThread } from "./message-thread";
import { ContactPanel } from "./contact-panel";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { CallsHistory } from "@/features/calls/components/calls-history";
import { useCallApi } from "@/features/calls/call-provider";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
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
function callReasonMessage(reason: string, channel?: Channel | null): string {
  // Channel-aware copy — the same call flow serves WhatsApp AND Messenger
  // (Messenger Calling is GA), so a Messenger rejection must not read "WhatsApp".
  const label = channel === "messenger" ? "Messenger" : channel === "instagram" ? "Instagram" : "WhatsApp";
  const settings = channel === "messenger" ? "Settings → Messenger" : "Settings → WhatsApp";
  switch (reason) {
    case "permission_required":
      return "Permission request sent to the customer. Try again once they accept.";
    case "permission_pending":
      return "Waiting on the customer to accept your call-permission request. Try again once they do.";
    case "bic_blocked_region":
      // Eligibility follows OUR business number's country, not the customer's.
      return `Outbound ${label} calls aren't available for your business number's country. You can still receive calls from customers.`;
    case "calling_restricted":
      return `${label} has temporarily paused calling on your number. Check ${settings} for when it lifts.`;
    case "permission_revoked":
      return "Calling permission was revoked. Wait for the customer to message you first.";
    case "rate_limited":
      return `You've reached ${label}'s call limit for this customer. Try again later.`;
    case "daily_cap_reached":
      return `You've reached ${label}'s daily connected-call limit for this customer.`;
    case "provider_not_configured":
      return `${label} calling isn't configured for this team. Open ${settings}.`;
    case "provider_rejected":
      return channel === "messenger"
        ? "Messenger rejected the call — your Page's call settings aren't enabled. Turn on calling in your Facebook Page / Meta Business Suite settings (Inbox → Calling), then try again."
        : `${label} rejected the call. Make sure calling is enabled on your number.`;
    case "call_in_progress":
      return "You're already on a call. End it before starting another.";
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
// Minimum width (px) the message thread column must keep on desktop. Both
// resizers (list + details) clamp against this at drag-time so neither can be
// dragged wide enough to squish the thread header/composer out of bounds. Sized
// so the composer header (Reply/Note toggle + Window badge + Send template) all
// fit on one line with breathing room — that's the "nothing overlaps" cap.
// Applied as a CSS min-width on the thread too (window-resize case). Keep the
// JS constant and the Tailwind `lg:min-w-140` (message-thread.tsx) in sync.
const MIN_THREAD_WIDTH = 560;

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
  messageFlagDefinitions,
  initialJumpMessageId,
  initialJumpNonce,
  stages,
  fieldDefinitions,
  contactPanelBuiltins,
  tags,
  canManageStages: canManageStagesPerm,
  canManageContactFields,
  canDeleteConversations,
  canMakeCalls,
  canAssignOthers,
  restrictedToOwnConversations,
  initialActiveConversationId,
  initialThread,
  initialContactPanelCollapsed,
  initialListWidth,
  initialDetailsWidth,
}: {
  currentUser: User;
  team: Team;
  teamMembers: User[];
  conversations: ConversationWithRefs[];
  nextConversationCursor: string | null;
  snippets: SnippetItem[];
  /** Team-wide triage-flag catalog (live definitions), for the bubble picker. */
  messageFlagDefinitions: MessageFlagDefinition[];
  /**
   * `?m=` — open the thread anchored on this MESSAGE rather than at the bottom.
   * Emitted by the flags queue ("open this complaint"). Everything downstream
   * already handles a target deep in history: the thread fetches a context
   * window, swaps the slice in, then scrolls + flashes it.
   */
  initialJumpMessageId: string | null;
  /** `?n=` — bumped by the producer so re-opening the SAME message re-fires. */
  initialJumpNonce: string | null;
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
  /** `conversations:assignOthers` — may hand a conversation to a TEAMMATE.
   *  Everyone can always claim one for themselves. */
  canAssignOthers: boolean;
  /** Org restricts agents to their own conversations AND the viewer is an
   *  agent. Server-enforced; the client uses it to react to live handovers. */
  restrictedToOwnConversations: boolean;
  initialActiveConversationId: string | null;
  initialThread: CachedThread | null;
  /** Server-read cookie so the right panel SSRs in its persisted rail state. */
  initialContactPanelCollapsed: boolean;
  /** Persisted drag-resize widths, SSR'd from cookies so the list + details
   *  columns paint at their saved size on first render (no post-refresh jump).
   *  Null = no cookie yet → the hook's CSS default applies. */
  initialListWidth: number | null;
  initialDetailsWidth: number | null;
}) {
  // Filter lives in the layout-level InboxFilterProvider so it's shared with
  // the sub-sidebar (which now renders in /inbox/layout.tsx and owns the
  // setter). Read-only here — the conversation list + live hook consume it.
  const { filter, setFilter, accountId } = useInboxFilter();
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
  // True when the displayed thread was served from a pre-existing LRU snapshot
  // (a cache HIT), which can be stale: while it sat backgrounded, conversation-
  // room-scoped events it wasn't subscribed to (message:status — delivered/read
  // ticks) never reached it. SSR seeds and cache-MISS fetches are fresh → false.
  // useConversationEvents reads this to run a full status reconcile on open
  // instead of the lightweight delta. (Initial SSR thread is fresh.)
  const [displayedFromCache, setDisplayedFromCache] = useState(false);
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
    // Bumped on every jump request so re-jumping to the SAME message (re-click
    // "Go to message" / Files "Jump" / the same search hit) still re-triggers
    // the thread scroll. The messageId alone is unchanged on a repeat, so
    // without this the thread's handled-guard treats it as already-done and the
    // click is a dead no-op.
    nonce: number;
  } | null>(null);
  const jumpSeqRef = useRef(0);

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
  // The call API (single useCall instance) now lives in the app-wide
  // CallProvider, so the incoming-call toast + active-call panel render on
  // EVERY page (not just the inbox). The inbox only needs the API to PLACE an
  // outbound call from the thread header; failures surface via toast.
  const callApi = useCallApi();

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
  // One-shot guard for the SSR seed. The seed must run EXACTLY once per SSR
  // value — not "whenever the entry is missing". `initialThread` /
  // `initialActiveConversationId` are constant for the whole client session
  // (page.tsx doesn't re-run on client-side chat switches), so an
  // entry-missing condition re-fires on every render after the shell's own
  // freshness machinery (evictIfBackground / clearExcept) drops that snapshot —
  // resurrecting the SSR-era thread (potentially hours stale) until the
  // initialMayBeStale full refetch converges. Gating on the ref makes the seed
  // truly first-render-only; the lastSyncedInitialId block below resets it when
  // a GENUINELY new SSR value arrives (direct-link / deletion redirect).
  const seededInitialRef = useRef(false);
  if (lastSyncedInitialId !== initialActiveConversationId) {
    setLastSyncedInitialId(initialActiveConversationId);
    setActiveId(initialActiveConversationId);
    setDisplayedId(initialActiveConversationId);
    // SSR re-rendered this thread fresh → no stale-status reconcile needed.
    setDisplayedFromCache(false);
    setPendingId(null);
    setErrorId(null);
    if (initialThread && initialActiveConversationId) {
      cache.set(initialActiveConversationId, initialThread);
      seededInitialRef.current = true;
    } else {
      // New SSR value with no thread payload (e.g. redirect to bare /inbox) —
      // allow a future genuine seed for the next SSR'd thread.
      seededInitialRef.current = false;
    }
  } else if (
    !seededInitialRef.current &&
    initialThread &&
    initialActiveConversationId &&
    !cache.has(initialActiveConversationId)
  ) {
    // First-render cache seed for the SSR'd thread — runs ONCE. After an
    // eviction we must NOT re-seed the stale SSR snapshot; the next open
    // re-fetches it fresh (cache miss) instead.
    cache.set(initialActiveConversationId, initialThread);
    seededInitialRef.current = true;
  }

  // ── `?m=` message anchor (the flags queue's "open this complaint") ──────
  //
  // Seeded from the URL rather than a click, so it has to survive the SSR sync
  // above (which sets activeId/displayedId for the `?c=`). Keyed on the `?n=`
  // nonce so re-opening the SAME message from the queue re-fires — the
  // messageId alone is unchanged on a repeat, and the thread's handled-guard
  // would treat it as already done.
  //
  // Deliberately NOT routed through openConversation: that early-returns when
  // the conversation is already active AND nulls jumpTarget, so a queue click
  // on the thread you're already viewing would clear the jump it just asked
  // for. onOpenSearchResult sidesteps the same trap by setting jumpTarget
  // AFTER the open; here the SSR sync has already done the opening.
  const jumpKey =
    initialJumpMessageId && initialActiveConversationId
      ? `${initialActiveConversationId}:${initialJumpMessageId}:${initialJumpNonce ?? ""}`
      : null;
  // Seeded in an EFFECT, not during render. On a fresh mount the thread pins
  // itself to the bottom (useChatScroll) as part of first paint; a jump target
  // set during render is consumed before that pin and gets scrolled straight
  // back off-screen. Running after paint puts the jump on the correct side of
  // the pin. `jumpKey` carries the `?n=` nonce, so re-opening the SAME message
  // from the queue still re-fires.
  useEffect(() => {
    if (!jumpKey || !initialJumpMessageId || !initialActiveConversationId) return;
    jumpSeqRef.current += 1;
    setJumpTarget({
      conversationId: initialActiveConversationId,
      messageId: initialJumpMessageId,
      nonce: jumpSeqRef.current,
    });
  }, [jumpKey, initialJumpMessageId, initialActiveConversationId]);

  // Strip `m`/`n` once consumed so a later hard refresh (or a Back press onto
  // this entry) doesn't silently re-yank the thread to an old message. `?c=`
  // stays — that's what keeps a refresh on this conversation. replaceState,
  // not the router, so this costs no RSC round-trip.
  useEffect(() => {
    if (!jumpKey || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("m") && !url.searchParams.has("n")) return;
    url.searchParams.delete("m");
    url.searchParams.delete("n");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, [jumpKey]);

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
          // Just fetched from the server → fresh, no stale-status reconcile needed.
          setDisplayedFromCache(false);
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

  // Refresh the DISPLAYED thread's cached snapshot in place (overwrite, not
  // evict) and bump cacheTick so its render-from-cache consumers (notably the
  // sibling ContactPanel) re-render with fresh data WITHOUT remounting. Used
  // by the coalesced `contacts:bulk_updated` path when the open contact is in
  // the batch — the bulk frame carries no contact body, so a refetch is the
  // only way to pull the canonical contact for the panel. No AbortController /
  // pending UI: this is a silent background reconcile of an already-rendered
  // thread, not a chat-switch fetch. A 404 (deleted mid-flight) is left to the
  // conversation:deleted path; any other failure self-heals on next open.
  const refreshDisplayedSnapshot = useCallback(
    async (conversationId: string) => {
      try {
        const res = await fetchWithSessionGuard(
          `/api/inbox/conversation/${conversationId}`,
          { credentials: "same-origin" },
        );
        if (!res.ok) return;
        const payload = (await res.json()) as CachedThread;
        // Only write if it's STILL the displayed thread (the agent may have
        // switched chats during the round-trip) and still cached (not evicted).
        if (
          displayedIdRef.current === conversationId &&
          cache.has(conversationId)
        ) {
          cache.set(conversationId, payload);
          setCacheTick((t) => t + 1);
        }
      } catch {
        // Silent — stale contact panel recovers on next chat-switch-and-back.
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
      if (cached) {
        setDisplayedId(conversationId);
        setDisplayedFromCache(true);
      }

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

  // ── Calls view ⇄ thread reconciliation ────────────────────────────────
  // The calls filter replaces the list + thread with the calls history. Two
  // edges so a thread is never hijacked by (or stranded behind) it:
  //   1. Opening a conversation (deep-link ?c= / "Open chat" from a call row)
  //      while the persisted filter is calls → switch to the default list
  //      filter so the thread shows. Keyed on the requested id (re-fires on a
  //      soft-nav to a new ?c=); reads `filter` via ref so clicking the Calls
  //      filter afterwards doesn't bounce straight back out.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    if (initialActiveConversationId && filterRef.current.kind === "calls") {
      setFilter({ kind: "preset", id: "active" });
    }
  }, [initialActiveConversationId, setFilter]);
  //   2. Switching TO the calls filter at runtime clears any open thread + its
  //      ?c= so the view is clean and a refresh stays on Calls (not bounced
  //      back into the thread by (1)). Skips the first effect run (mount) —
  //      that case is owned by (1).
  const callsStripArmedRef = useRef(false);
  useEffect(() => {
    if (!callsStripArmedRef.current) {
      callsStripArmedRef.current = true;
      return;
    }
    if (filter.kind !== "calls") return;
    setActiveId(null);
    setDisplayedId(null);
    if (typeof window !== "undefined" && window.location.search) {
      window.history.replaceState(null, "", "/inbox");
    }
  }, [filter.kind]);

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
          ? {
              conversationId: target.conversationId,
              messageId: target.messageId,
              nonce: (jumpSeqRef.current += 1),
            }
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
      setJumpTarget({
        conversationId: convId,
        messageId,
        nonce: (jumpSeqRef.current += 1),
      });
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
        if (!res.ok) {
          // Surface the failure instead of swallowing it — a silent no-op
          // after the agent picked a contact reads as a broken button.
          toast.error("Couldn't start the conversation. Please try again.");
          return;
        }
        const { conversationId } = (await res.json()) as {
          conversationId: string;
        };
        if (conversationId) {
          openConversation(conversationId);
        } else {
          toast.error("Couldn't start the conversation. Please try again.");
        }
      } catch {
        // Non-fatal: the agent can retry; the contact directory still works.
        toast.error("Couldn't start the conversation. Please try again.");
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
      if (cached) {
        setDisplayedId(next);
        setDisplayedFromCache(true);
      }
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
  // Saved-view criteria, so a live row can be evaluated against the active
  // view without a refetch (the `Filter` object carries only the id).
  const { filtersById: viewFiltersById } = useInboxViews();

  const live = useTeamEvents(
    team.id,
    initialConversations,
    nextConversationCursor,
    activeId,
    currentUser.id,
    filter,
    restrictedToOwnConversations,
    displayedThread?.data ?? null,
    viewFiltersById,
    accountId,
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
    //
    // The DISPLAYED thread is special: it can't just be evicted (that would
    // blank the rendered thread). Its cached snapshot feeds the sibling
    // ContactPanel (ThreadWorkspace renders ContactPanel from `thread.data`,
    // not from MessageThread's live hook), so a bulk op touching the OPEN
    // contact would otherwise leave the contact panel / its custom-field rows
    // stale until a chat-switch-and-back. (MessageThread's own internals —
    // header stage stepper, snippet token resolution — converge separately via
    // useConversationEvents' contacts:bulk_updated refetch.) Re-fetch the
    // displayed thread's snapshot in place + bump cacheTick so ContactPanel
    // re-renders fresh without remounting (key={displayedId} stays stable).
    const onContactsBulkUpdated = (payload: { contactIds: string[] }) => {
      if (!payload?.contactIds?.length) return;
      const affected = new Set(payload.contactIds);
      const displayed = displayedIdRef.current;
      for (const c of conversationsByIdRef.current.values()) {
        const id = c.conversation.id;
        if (id === displayed) continue;
        const cached = cache.peek(id);
        if (cached && affected.has(cached.data.contact.id)) {
          cache.delete(id);
        }
      }
      // Displayed thread: refresh its cache snapshot in place if its contact
      // was in the batch, so the contact panel converges live.
      if (displayed) {
        const cached = cache.peek(displayed);
        if (cached && affected.has(cached.data.contact.id)) {
          void refreshDisplayedSnapshot(displayed);
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
  }, [cache, currentUser.id, refreshDisplayedSnapshot]);

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
        workspaceId: team.id,
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
  const listRefetching = live.refetching;
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

  // Filtered-slice sum — used only as the first-paint fallback until the
  // authoritative team-wide count lands (and if it ever fails to load).
  const totalUnreadFallback = useMemo(() => {
    return live.conversations.reduce(
      (acc, c) =>
        acc +
        (c.conversation.status === "closed" ? 0 : c.conversation.unreadCount),
      0,
    );
  }, [live.conversations]);
  // Authoritative team-wide non-closed unread (server-computed over ALL
  // conversations — same source the AppRail badge uses), so the tab title is
  // correct under EVERY filter. The filtered slice undercounts on
  // Mine/Unassigned/stage views. `unread.active` = open+pending (non-closed),
  // matching the closed-excluded fallback.
  //
  // We DON'T mount our own useConversationCounts here — InboxSubSidebar (always
  // mounted on /inbox via the layout) already owns one, and a second mount
  // doubles every `GET /api/conversations/counts` + its full socket-listener set
  // per tab. Instead the sub-sidebar bridges its team-wide non-closed unread
  // across the layout/island boundary via the `ccp:inbox-unread-total`
  // CustomEvent (same window-event bridge as `ccp:contact-stage-delta`); we
  // listen and fall back to the loaded-slice sum until the first value lands.
  const [serverUnreadActive, setServerUnreadActive] = useState<number | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onUnreadTotal = (e: Event) => {
      const detail = (e as CustomEvent<{ active?: number }>).detail;
      if (detail && typeof detail.active === "number") {
        setServerUnreadActive(detail.active);
      }
    };
    window.addEventListener("ccp:inbox-unread-total", onUnreadTotal);
    // Ask the sub-sidebar to re-emit its latest value in case it fired its
    // initial emit before this listener was installed (mount-order race across
    // the two component trees). The sub-sidebar answers by re-dispatching.
    window.dispatchEvent(new Event("ccp:inbox-unread-request"));
    return () => window.removeEventListener("ccp:inbox-unread-total", onUnreadTotal);
  }, []);
  const totalUnread = serverUnreadActive ?? totalUnreadFallback;

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
    const snapshot = cache.get(targetId);
    const contactName = snapshot?.data.contact.name ?? "Customer";
    const result = await callApi.initiateOutbound(
      targetId,
      contactName,
      // The thread owns the account — this call goes out the number the
      // customer already messaged, and the live panel should say which.
      snapshot?.data.conversation.channel ?? null,
      snapshot?.data.conversation.channelConnectionId ?? null,
    );
    if (!result.ok) {
      // A pre-flight rejection tore down `liveCall`, so the global CallPanel
      // won't show it — a toast guarantees the agent sees why it didn't start.
      // Pass the thread's channel so the copy names the right product.
      toast.error(callReasonMessage(result.reason, snapshot?.data.conversation.channel));
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

  // Desktop drag-to-resize for the conversation-list column. `width` is null
  // until mount (CSS default applies, no hydration mismatch); after that it's
  // the persisted px width, fed to the column via the `--inbox-lw` CSS var.
  const {
    width: listWidth,
    onHandleDown,
    onHandleKeyDown,
  } = usePanelResize({
    storageKey: INBOX_LIST_WIDTH_COOKIE,
    initial: initialListWidth,
    min: 260,
    max: 560,
    def: 320,
    // Don't let dragging the list so wide that the thread (inside the thread
    // <section>, which also holds the details panel) drops below a usable
    // width. Measured live from the handle's siblings so it adapts to window
    // size + details width.
    getDragMax: (handle) => {
      const listCol = handle.previousElementSibling as HTMLElement | null;
      const main = handle.nextElementSibling as HTMLElement | null;
      if (!listCol || !main) return Infinity;
      const aside = main.querySelector("aside");
      const detailsTotal = aside
        ? aside.getBoundingClientRect().width + 4 /* details handle */
        : 0;
      const listW = listCol.getBoundingClientRect().width;
      const mainW = main.getBoundingClientRect().width;
      return listW + Math.max(0, mainW - detailsTotal - MIN_THREAD_WIDTH);
    },
  });

  return (
    <SnippetsProvider snippets={snippets}>
      <MessageFlagsProvider definitions={messageFlagDefinitions}>
      {/* One workspace-wide "who is reading what" subscription, feeding BOTH
          the list rows' eye and the thread header's. Mounted here because it is
          the lowest node that owns both surfaces. */}
      <ConversationViewersProvider
        workspaceId={team.id}
        currentUserId={currentUser.id}
        teamMembers={teamMembers}
      >
      {/* AppRail + the inbox sub-sidebar + mobile chrome all live in
          /inbox/layout.tsx now (via SectionShell). This island is just the
          conversation list + thread workspace, mounted inside the layout's
          <main>, so a rail click paints the stable sub-sidebar instantly and
          only this region streams in behind loading.tsx. */}
      <div className="relative flex h-svh w-full overflow-hidden bg-background text-foreground">
        <ConnectionBanner />
        <div className="flex min-w-0 flex-1 overflow-hidden">
          {filter.kind === "calls" ? (
            // Calls view — team-wide call history rendered INSIDE the inbox
            // ("Calls must stay in the inbox like others"). Replaces the
            // list + thread panes; the sub-sidebar stays so switching back to
            // Active/etc. is one click. Same component the /calls route uses.
            <div className="min-w-0 flex-1 overflow-y-auto bg-background">
              <div className="mx-auto max-w-3xl px-6 py-6">
                <CallsHistory canCall={canMakeCalls} />
              </div>
            </div>
          ) : (
            <>
          {/* Mobile: ConversationList takes full width when no thread is
              active; hidden when a thread is open. Desktop: always visible
              as a fixed-width column. */}
          <div
            className={cn(
              // Multi-pane (list + thread side-by-side) starts at lg, NOT md.
              // The 768–1023 (md) band is single-pane — the list OR the active
              // thread, full-width — because at md the AppRail + a 260px list +
              // the thread left the thread column too cramped (~115px worst
              // case, expanded rail). Below lg the list is full-width (flex-1);
              // at lg+ it's the fixed-width drag-resizable column (--inbox-lw,
              // clamped [260,560]). The var is always set (320 until the
              // persisted width loads) so first paint agrees — no hydration
              // mismatch.
              "flex min-h-0 flex-1 lg:w-(--inbox-lw) lg:min-w-65 lg:max-w-140 lg:flex-initial",
              activeId ? "hidden lg:flex" : "flex",
            )}
            style={
              { "--inbox-lw": `${listWidth ?? 320}px` } as React.CSSProperties
            }
          >
            <ConversationList
              conversations={conversationList}
              stages={stages}
              filter={filter}
              search={search}
              onSearchChange={setSearch}
              hasMore={hasMore}
              loadingMore={loadingMore}
              listRefetching={listRefetching}
              onLoadMore={loadMore}
              activeConversationId={activeId}
              pendingConversationId={pendingId}
              onOpenConversation={openConversation}
              onOpenSearchResult={onOpenSearchResult}
              onStartContactChat={onStartContactChat}
              onPrefetchConversation={fetchThread}
              canDeleteConversations={canDeleteConversations}
              tags={tags}
              currentUserId={currentUser.id}
            />
          </div>
          {/* Drag-to-resize handle between the list and the thread. Only in the
              lg+ multi-pane layout (md and below are single-pane). The 1px
              visual line sits inside a wider hit area so it's easy to grab;
              arrows resize when focused. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize conversation list"
            aria-valuemin={260}
            aria-valuemax={560}
            aria-valuenow={listWidth ?? 320}
            tabIndex={0}
            onPointerDown={onHandleDown}
            onKeyDown={onHandleKeyDown}
            className="group relative hidden w-1 shrink-0 cursor-col-resize touch-none select-none border-l border-border outline-none lg:block"
          >
            {/* Wide invisible grab zone so the thin indicator is still easy to grab. */}
            <span className="absolute inset-y-0 -left-1.5 -right-1.5 z-10" />
            {/* Thin, subtle resize indicator — transparent until hover / keyboard
                focus, so it never reads as a big translucent green bar. */}
            <span className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-transparent transition-[background-color,width] group-hover:w-1 group-hover:bg-primary/75 group-focus-visible:w-1 group-focus-visible:bg-primary" />
          </div>
          {/* Single-pane (md and below): thread visible only when a thread is
              active. Multi-pane (lg+): always visible beside the list. This is a
              <section> (NOT <main>) — the layout's SectionShell already renders
              the page-level <main>, and two nested <main> landmarks is an a11y
              violation. The aria-label names the region for SR landmark nav. */}
          <section
            aria-label="Conversation"
            className={cn(
              // No lg:border-l here — the resize handle (above) is the
              // list/thread separator in the lg+ multi-pane layout now.
              "relative min-w-0 flex-1 bg-background lg:flex",
              activeId ? "flex" : "hidden lg:flex",
            )}
          >
            {/* Delay-gated loading bar for the conversation pane only. A thread
                FETCH (cache miss / reconnect refetch) that runs longer than
                ~180ms reveals a thin top bar; a fast fetch (cache-warm / good
                network) resolves first, so the bar never shows and the switch
                stays visually instant. This is the `?c=` chat-switch equivalent
                of NavProgress, which deliberately fires only on a real
                route/pathname change. */}
            <ThreadLoadingBar
              pending={pendingId !== null && pendingId === activeId}
            />
            {errorId && errorId === activeId ? (
              <ThreadError onRetry={retryActive} />
            ) : displayedId && displayedThread ? (
              <ThreadWorkspace
                key={displayedId}
                thread={displayedThread}
                initialMayBeStale={displayedFromCache}
                teamMembers={teamMembers}
                currentUser={currentUser}
                stageCatalog={stages}
                canManageStages={canManageStagesPerm}
                fieldDefinitions={fieldDefinitions}
                contactPanelBuiltins={contactPanelBuiltins}
                canManageContactFields={canManageContactFields}
                canDeleteConversations={canDeleteConversations}
                canAssignOthers={canAssignOthers}
                canMakeCalls={
                  // Per-thread gate: capability + WhatsApp channel + region
                  // (BIC blocklist via contact country) + no fresh revocation.
                  // Calling is gated on the channel's declared capability
                  // (WhatsApp: true; Messenger/Instagram: false) rather than a
                  // hardcoded channel check — a future calling-capable channel
                  // lights the button up with no edit here. channel may be
                  // absent on legacy wire payloads; treat unknown as whatsapp.
                  //
                  // Region eligibility is a TEAM-level fact (it follows our own
                  // business number's country, not the customer's), so it comes
                  // from the team payload. Gating it per-contact — as this once
                  // did — hides the button for customers we may legitimately
                  // call and shows it for teams that can't call at all.
                  //
                  // The revocation check mirrors the backend gate so the button
                  // is hidden up-front instead of surfacing a 4xx after a click.
                  canMakeCalls &&
                  CHANNEL_CAPABILITIES[
                    displayedThread.data.conversation.channel ?? "whatsapp"
                  ].calling &&
                  team.outboundCallingAvailable !== false &&
                  !isCallPermissionRevoked(
                    displayedThread.data.contact.callPermissionRevokedUntil,
                  )
                }
                aiAutopilotEnabled={team.aiAutopilotEnabled ?? false}
                onInitiateCall={initiateCallForActiveThread}
                tags={tags}
                initialContactPanelCollapsed={initialContactPanelCollapsed}
                initialDetailsWidth={initialDetailsWidth}
                onMarkRead={handleMarkRead}
                onThreadSnapshot={handleThreadSnapshot}
                onMobileBack={onMobileBack}
                onGoToMessage={goToMessageInActiveThread}
                jumpToMessageId={
                  jumpTarget?.conversationId === displayedId
                    ? jumpTarget.messageId
                    : null
                }
                jumpNonce={
                  jumpTarget?.conversationId === displayedId
                    ? jumpTarget.nonce
                    : 0
                }
              />
            ) : activeId && skeletonContact ? (
              <ChatSkeleton contact={skeletonContact} onMobileBack={onMobileBack} />
            ) : (
              <EmptyInboxState />
            )}
          </section>
            </>
          )}
        </div>
        <DevTools conversations={live.conversations} currentUser={currentUser} />
        {/* The incoming-call toast + active-call panel are now app-wide (see
            CallProvider in the (app) layout) so a call rings through on every
            page, not just here. */}
      </div>
      </ConversationViewersProvider>
      </MessageFlagsProvider>
    </SnippetsProvider>
  );
}

/**
 * Renders the thread + side panel for a single conversation. The `key=
 * {displayedId}` on the parent keeps unmount/mount semantics intact on chat
 * switch — that's the boundary at which MessageThread's local state
 * (composer-local UI, scroll offset, selection) is intentionally reset.
 */
/**
 * Delay-gated loading bar for the conversation pane. Driven by the thread-fetch
 * pending flag: when a cache-miss / reconnect refetch is in flight, a ~180ms
 * timer arms; only if the fetch is STILL pending when it fires does the thin top
 * bar reveal (easing toward 90% to imply progress). A fast fetch resolves before
 * the timer, so the bar never appears — the chat-switch stays visually instant,
 * which is the whole point. On resolve, a bar that DID show snaps to 100% and
 * fades; one that never showed is a no-op. Scoped to the pane (absolute,
 * pointer-events-none) so it can never block interaction; mirrors NavProgress's
 * width/opacity-only technique with no new CSS. Holds the previously-displayed
 * thread (or the chat-shaped skeleton) underneath — no teardown/skeleton flash.
 */
function ThreadLoadingBar({ pending }: { pending: boolean }) {
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const timersRef = useRef<number[]>([]);
  const shownRef = useRef(false);
  useEffect(() => {
    const clear = () => {
      for (const t of timersRef.current) window.clearTimeout(t);
      timersRef.current = [];
    };
    clear();
    if (pending) {
      // Reveal only after the slow-threshold so fast fetches stay invisible.
      timersRef.current.push(
        window.setTimeout(() => {
          shownRef.current = true;
          setVisible(true);
          setWidth(8);
          timersRef.current.push(window.setTimeout(() => setWidth(90), 90));
        }, 180),
      );
    } else if (shownRef.current) {
      // Was visible (slow fetch) and now resolved → complete + fade out.
      shownRef.current = false;
      setWidth(100);
      timersRef.current.push(window.setTimeout(() => setVisible(false), 160));
      timersRef.current.push(window.setTimeout(() => setWidth(0), 340));
    }
    return clear;
  }, [pending]);
  return (
    <div
      aria-hidden
      data-thread-loading-bar=""
      className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 transition-opacity duration-150 ease-out motion-reduce:transition-none"
      style={{ opacity: visible ? 1 : 0 }}
    >
      <div
        className="h-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function ThreadWorkspace({
  thread,
  initialMayBeStale,
  teamMembers,
  currentUser,
  stageCatalog,
  canManageStages,
  fieldDefinitions,
  contactPanelBuiltins,
  canManageContactFields,
  canDeleteConversations,
  canMakeCalls,
  canAssignOthers,
  aiAutopilotEnabled,
  onInitiateCall,
  tags,
  initialContactPanelCollapsed,
  initialDetailsWidth,
  onMarkRead,
  onThreadSnapshot,
  onMobileBack,
  onGoToMessage,
  jumpToMessageId,
  jumpNonce,
}: {
  thread: CachedThread;
  /** True when `thread` came from a possibly-stale LRU snapshot (cache hit), so
   *  the thread should reconcile message statuses on open. See inbox-shell. */
  initialMayBeStale: boolean;
  teamMembers: User[];
  currentUser: User;
  stageCatalog: ContactStage[];
  canManageStages: boolean;
  fieldDefinitions: ContactFieldDefinition[];
  contactPanelBuiltins: ContactPanelBuiltins;
  canManageContactFields: boolean;
  canDeleteConversations: boolean;
  canMakeCalls: boolean;
  canAssignOthers: boolean;
  /** Team-level AI Autopilot opt-in — gates the header AI toggle visibility. */
  aiAutopilotEnabled: boolean;
  onInitiateCall: () => void | Promise<void>;
  tags: Tag[];
  initialContactPanelCollapsed: boolean;
  /** SSR-read persisted details-panel width (cookie); forwarded to ContactPanel
   *  so the right rail paints at its saved width on first render. */
  initialDetailsWidth: number | null;
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
  /** Bumped on every jump request so re-jumping to the same message re-fires
   *  (see the jumpTarget state). 0 when no jump is targeted at this thread. */
  jumpNonce: number;
}) {
  // Mobile/tablet contact-details Sheet (below lg the desktop right rail is
  // hidden). Opened by the Info button in ThreadHeader.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Stabilize the two props MessageThread's React.memo compares by reference so
  // an unrelated shell re-render (a team frame for another conversation, a
  // search keystroke) doesn't defeat the memo and re-run the whole thread
  // subtree. Every other prop forwarded below is already stable (shell
  // useCallbacks / server-constant arrays).
  const onOpenContactDetails = useCallback(() => setDetailsOpen(true), []);
  const rightPanel = useMemo(
    () => (
      <ContactPanel
        data={thread.data}
        fieldDefinitions={fieldDefinitions}
        builtins={contactPanelBuiltins}
        canManageFields={canManageContactFields}
        tagCatalog={tags}
        teamMembers={teamMembers}
        currentUserName={currentUser.name}
        initialCollapsed={initialContactPanelCollapsed}
        initialDetailsWidth={initialDetailsWidth}
        onGoToMessage={onGoToMessage}
        canMakeCalls={canMakeCalls}
      />
    ),
    [
      thread.data,
      fieldDefinitions,
      contactPanelBuiltins,
      canManageContactFields,
      tags,
      teamMembers,
      currentUser.name,
      initialContactPanelCollapsed,
      initialDetailsWidth,
      onGoToMessage,
      canMakeCalls,
    ],
  );
  return (
    <>
      <MessageThread
        data={thread.data}
        initialMayBeStale={initialMayBeStale}
        teamMembers={teamMembers}
        currentUser={currentUser}
        nextOlderCursor={thread.nextOlderCursor}
        stageCatalog={stageCatalog}
        tags={tags}
        fieldDefinitions={fieldDefinitions}
        canManageStages={canManageStages}
        canDeleteConversations={canDeleteConversations}
        canMakeCalls={canMakeCalls}
        canAssignOthers={canAssignOthers}
        aiAutopilotEnabled={aiAutopilotEnabled}
        onInitiateCall={onInitiateCall}
        onMarkRead={onMarkRead}
        onSnapshot={onThreadSnapshot}
        onMobileBack={onMobileBack}
        onOpenContactDetails={onOpenContactDetails}
        jumpToMessageId={jumpToMessageId}
        jumpNonce={jumpNonce}
        // Details panel rendered INSIDE the thread, to the right of the
        // messages, so the thread header/action bar spans full-width above
        // both columns (the details sits under the name/status bar).
        rightPanel={rightPanel}
      />
      {/* Mobile/tablet (below lg): same panel content in a right-side Sheet.
          Only mounted while open so it doesn't double-run the panel's live
          listeners. "Go to message" closes the sheet so the agent sees the
          thread scroll/flash. */}
      {detailsOpen && (
        <Sheet
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          side="right"
          // Hide the whole overlay at lg+ too (in case the viewport grows while
          // open) — at lg the desktop rail takes over.
          className="lg:hidden"
          contentClassName="w-80 max-w-[85vw] bg-sidebar text-sidebar-foreground"
        >
          <ContactPanel
            data={thread.data}
            fieldDefinitions={fieldDefinitions}
            builtins={contactPanelBuiltins}
            canManageFields={canManageContactFields}
            tagCatalog={tags}
            teamMembers={teamMembers}
            currentUserName={currentUser.name}
            initialCollapsed={false}
            initialDetailsWidth={initialDetailsWidth}
            onGoToMessage={(id) => {
              setDetailsOpen(false);
              onGoToMessage(id);
            }}
            canMakeCalls={canMakeCalls}
            variant="sheet"
          />
        </Sheet>
      )}
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
            className="-ml-1 inline-flex size-8 pointer-coarse:size-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
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
                  ? "h-9 animate-pulse rounded-2xl rounded-br-md bg-outbound-bg/60"
                  : "h-9 animate-pulse rounded-2xl rounded-bl-md bg-inbound-bg"
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
      <div className="surface flex max-w-sm flex-col items-center gap-3 px-8 py-7 text-center">
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
        <Button onClick={onRetry} className="mt-1">
          Try again
        </Button>
      </div>
    </div>
  );
}

function EmptyInboxState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/8 to-primary/5 text-primary">
          <InboxIcon className="size-6" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-tight">No conversation selected</h2>
          <p className="text-sm text-muted-foreground">
            Pick a conversation from the list to start replying. Your team's most recent
            customer threads are sorted by activity.
          </p>
        </div>
      </div>
    </div>
  );
}
