"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";

import { getClientSocket } from "@/lib/socket-client";
import { notificationSound } from "@/lib/notifications/notification-sound";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { apiFetch } from "@/lib/api/client-fetch";
import { useCoalescedAsync } from "@/features/inbox/lib/coalesce";
import {
  applyMessageStatus,
  assertReducerCoverage,
  COALESCED_LIVE_HOOK_EVENTS,
  THREAD_REDUCER_EVENTS,
} from "@/features/inbox/lib/thread-reducers";
import { isOptimisticActivityId } from "@/features/inbox/lib/optimistic-activity";
import { nextOptimisticSeq } from "@/features/inbox/lib/optimistic-seq";
import type {
  ConversationActivityEvent,
  ConversationWithRefs,
  CursorPage,
  Message,
} from "@ccp/shared/types";
import { mediaPreviewLabel } from "@ccp/shared/types";

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

/**
 * Drop optimistic pending OUT rows that a recovery fetch (backfill / full
 * refetch) is about to re-add as confirmed server rows. The live `onMessageNew`
 * reconciles an own-send optimistic by `clientTempId`, but recovery items don't
 * carry it — so when a disconnect swallowed the confirming frame, the
 * externalId dedupe alone leaves the optimistic bubble in place AND appends the
 * server copy: the message renders twice, and the 30s send watchdog then flips
 * the orphan to a phantom "failed" with a Retry button (an invitation to
 * double-send). We match the confirmation on (non-empty) body — the simplest
 * signal present on both sides. Empty bodies (media without caption) are skipped
 * so distinct attachments aren't collapsed.
 */
// A recovery refetch (runBackfill / runFullRefetch) reconciling an own optimistic
// send IS confirmation — fire the SAME cancel signal the live `message:new` frame
// fires (see onMessageNew) so the 30s send-watchdog (reply-box.tsx) can't LATER
// phantom-fail an already-delivered row and bait a Retry double-send (the exact
// trap the body/media branches below guard against). Idempotent: the watchdog
// listener is `{ once: true }` and self-removes, so a strict-mode updater re-run
// just no-ops. A benign window event (no setState), safe to fire from inside the
// setData updater where reconcileOptimisticAgainst runs.
function confirmOptimistic(m: Message): void {
  if (m.clientTempId && typeof window !== "undefined") {
    window.dispatchEvent(new Event(`ccp:optimistic-confirmed:${m.clientTempId}`));
  }
}

function reconcileOptimisticAgainst(
  existing: Message[],
  fresh: Message[],
): Message[] {
  // (1) Text confirmation: a pending OUT bubble whose body matches a fresh OUT
  // row is the same send. Empty bodies are skipped here (media-only) and
  // handled by (2). COUNT, not a Set: two pending OUT bubbles with the SAME body
  // must drop only when there are TWO confirmed server rows. A membership Set
  // dropped BOTH pending bubbles when only ONE confirmation had landed (partial
  // confirmation inside a reconnect window), briefly vanishing the second send.
  // FE-1: key the confirmation maps by (senderUserId, body) — NOT body alone.
  // A pending bubble is the CURRENT agent's own send (addOptimistic stamps
  // senderUserId). Matching on body alone let a TEAMMATE's identical "Thanks!"
  // confirm + consume this agent's pending bubble, vanishing their send and
  // tripping the watchdog into a phantom-failed Retry (a double-send trap).
  // Scoping by sender means only the agent's OWN confirmed row clears it.
  const senderKey = (senderUserId: string | null, suffix: string): string =>
    `${senderUserId ?? ""}\u0000${suffix}`;
  const freshBodyCounts = new Map<string, number>();
  for (const m of fresh) {
    if (m.direction !== "out" || !m.body) continue;
    const k = senderKey(m.senderUserId, m.body);
    freshBodyCounts.set(k, (freshBodyCounts.get(k) ?? 0) + 1);
  }

  // (2) Media confirmation: a caption-less media send (voice / image / video /
  // doc) has an EMPTY body, so (1) can't match it — and the server row never
  // carries clientTempId (it's a BullMQ jobId, not a Message column). Without
  // this branch the optimistic blob bubble survived a recovery refetch ALONGSIDE
  // the server copy → the message rendered twice and the 30s watchdog flipped
  // the orphan to a phantom "failed" with a Retry button (a double-send trap).
  // Match a pending OUT bubble whose media is a LOCAL blob: url to a fresh OUT
  // server media row of the SAME mediaKind, consuming each fresh row once so two
  // distinct same-kind sends in one window aren't collapsed into one.
  const freshMediaByKind = new Map<string, number>();
  for (const m of fresh) {
    if (m.direction !== "out") continue;
    const kind = m.media?.kind;
    // Server media rows have a real (non-blob) media url; an optimistic copy
    // that leaked into `fresh` would still carry blob: — exclude those.
    if (!kind || m.media?.url?.startsWith("blob:")) continue;
    const k = senderKey(m.senderUserId, kind);
    freshMediaByKind.set(k, (freshMediaByKind.get(k) ?? 0) + 1);
  }

  if (freshBodyCounts.size === 0 && freshMediaByKind.size === 0) return existing;

  return existing.filter((m) => {
    // Match pending OR failed OUT bubbles. The live `onMessageNew` path already
    // consumes a failed twin by clientTempId (a failed→succeeded retry); the
    // recovery path (runBackfill / runFullRefetch) reconciles by body/media
    // instead — without `|| m.failed` a send that flipped to `failed` (watchdog
    // fired, or message.send_failed before a retry succeeded) survived a refetch
    // ALONGSIDE the confirmed server row → duplicate bubble with a stale Retry
    // button (a double-send trap). A genuinely-failed send has no server row, so
    // its body/media won't be in the confirmed sets below and it stays put.
    if (!((m.pending || m.failed) && m.direction === "out")) return true;
    // Text optimistic confirmed by body — consume one per match so N pending
    // bubbles drop only when N confirmed rows exist (mirrors the media branch).
    if (m.body) {
      const k = senderKey(m.senderUserId, m.body);
      const remaining = freshBodyCounts.get(k) ?? 0;
      if (remaining > 0) {
        freshBodyCounts.set(k, remaining - 1);
        confirmOptimistic(m);
        return false;
      }
    }
    // Media optimistic (local blob) confirmed by a same-kind server row.
    const localKind = m.media?.url?.startsWith("blob:") ? m.media.kind : undefined;
    if (!m.body && localKind) {
      const k = senderKey(m.senderUserId, localKind);
      const remaining = freshMediaByKind.get(k) ?? 0;
      if (remaining > 0) {
        freshMediaByKind.set(k, remaining - 1);
        confirmOptimistic(m);
        return false;
      }
    }
    return true;
  });
}

/**
 * How long an optimistic activity stub may survive an authoritative refetch
 * before it's force-dropped. The trailing `refreshActivity` GET (~350ms after
 * the change) almost always already carries the real audit row, so this only
 * matters as a clock-skew safety net: if the client clock is far AHEAD of the
 * server, a stub's `at` could stay greater than its own persisted row's `at`
 * and linger as a duplicate. Bounding the stub's lifetime guarantees it can't
 * outlive a couple of reconcile cycles regardless of skew. Comfortably longer
 * than the audit write + GET round-trip; short enough that a stray duplicate
 * self-heals within a blink.
 */
const OPTIMISTIC_ACTIVITY_TTL_MS = 5_000;

/**
 * The only fields that distinguish one pill from another in `describe()`
 * (activity-entry.tsx). Two events with the same signature render an identical
 * line, so this is how we pair an optimistic stub to its authoritative server
 * row without an id (the server assigns a fresh uuid the client can't predict).
 */
function activitySignature(e: ConversationActivityEvent): string {
  switch (e.kind) {
    case "assigned":
      return `assigned:${e.assignedToName ?? ""}`;
    case "status_changed":
      return `status:${String(e.after?.status ?? "")}`;
    case "stage_changed":
      return `stage:${String(e.before?.stageName ?? "")}>${String(e.after?.stageName ?? "")}`;
    case "tag_added":
      return `tag+:${String(e.after?.tagName ?? "")}`;
    case "tag_removed":
      return `tag-:${String(e.before?.tagName ?? "")}`;
    default:
      return e.kind;
  }
}

/**
 * Cheap dirty-check so a no-op coalesced GET doesn't churn the timeline.
 *
 * Compares id AND `at` AND `optimisticPending` — NOT id alone. Reconcile keeps
 * the stub's id on the server-correct row (for React-key stability), so an
 * id-only check would see "same sequence" and return the stale optimistic array
 * — the row would stay client-timed and `optimisticPending`-pinned FOREVER,
 * defeating the settle-on-reconcile that fixes the ordering bugs. The `at` +
 * flag compare detects exactly the reconcile transition (client→server time,
 * pending→confirmed) while still short-circuiting a genuine no-op GET.
 */
function sameEventSequence(
  a: ConversationActivityEvent[],
  b: ConversationActivityEvent[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.at !== y.at || !!x.optimisticPending !== !!y.optimisticPending) {
      return false;
    }
  }
  return true;
}

// A stub and its authoritative row land within a few hundred ms (the
// leading/trailing GET fire ≤350ms apart, the audit write is ms behind the
// frame). The window must be wide enough to pair them through a load spike, yet
// TIGHT enough to never pair a fresh optimistic pill with a much-OLDER identical
// row. That second half is load-bearing for the generic-signature kinds
// (ai_paused / ai_resumed have NO distinguishing value in `activitySignature`,
// so EVERY past pause looks identical): at 120s, sending again within 2 minutes
// of a prior pause let the new send's optimistic pause pill pair with the OLD
// pause row, which then adopted the new send's group and jumped to the new
// message before the trailing GET corrected it — the "a 5:50 log shows at the
// bottom then settles" flicker. 8s is ~20× the real pairing latency but far
// below the multi-second cadence of distinct human actions, and well under the
// 5s stub TTL so a stub never lingers to mis-pair. (assign/status/stage/tag
// carry a value in the signature, so only an identical-value repeat within 8s
// could still collide — rare, and self-corrects on the trailing GET.)
const STUB_MATCH_WINDOW_MS = 8_000;

/**
 * Fold an authoritative server activity-log window over the current events,
 * reconciling any optimistic stub the agent already sees.
 *
 * The leading-edge `refreshActivity` GET can fire BEFORE the audit row is
 * written (audit runs at a lower bus priority than the realtime frame), so a
 * naive "replace events with the server response" would wipe the optimistic
 * pill the agent just saw, only for the trailing GET to re-add it — a flicker.
 *
 * Instead, pair each stub to its server row by SEMANTIC content + time
 * proximity (not by id — the server's uuid is unknowable client-side), and when
 * matched, keep the STUB's id on the server-correct row. That keeps the pill's
 * React key stable across the reconcile, so the node is updated in place rather
 * than unmount+remounted — no key-swap remount, no entrance re-fire, no twitch
 * when two pills reconcile together. Pairing by content (not by comparing
 * timestamps) also makes the old clock-skew duplicate structurally impossible.
 *
 * A stub with no matching row yet (the leading GET raced ahead of the audit
 * write) stays appended until its row lands or the TTL expires, so the pill
 * never blinks out and back. When matched, the row adopts the server `at` and
 * sheds `optimisticPending`, so it SETTLES into real-time order instead of
 * staying pinned to the bottom (see `sameEventSequence` for why the dirty-check
 * must notice that transition). Returns the prior array reference unchanged when
 * id + `at` + pending-flag are all identical, so a no-op GET triggers no
 * re-render.
 */
function mergeAuthoritativeEvents(
  prev: ConversationWithRefs["events"],
  server: ConversationWithRefs["events"],
): ConversationActivityEvent[] {
  const prevEvents = prev ?? [];
  const serverEvents = server ?? [];
  const stubs = prevEvents.filter((e) => isOptimisticActivityId(e.id));
  if (stubs.length === 0) {
    return sameEventSequence(prevEvents, serverEvents) ? prevEvents : serverEvents;
  }

  const consumed = new Set<string>();
  const relabeled = serverEvents.map((row) => {
    const rowAt = new Date(row.at).getTime();
    const rowSig = activitySignature(row);
    let best: ConversationActivityEvent | null = null;
    let bestGap = Infinity;
    for (const s of stubs) {
      if (consumed.has(s.id)) continue;
      if (activitySignature(s) !== rowSig) continue;
      const gap = Math.abs(new Date(s.at).getTime() - rowAt);
      if (gap < bestGap && gap <= STUB_MATCH_WINDOW_MS) {
        best = s;
        bestGap = gap;
      }
    }
    if (best) {
      consumed.add(best.id);
      // Carry the send-order seq from the stub onto the settled row. The pill
      // sheds `optimisticPending` here (settles), but if the agent's triggering
      // send is still pending the timeline keeps it pinned via the seq (so a
      // settled auto-pause pill can't float ABOVE a still-pending reply when the
      // server's conversation:ai frame beats message:new). Cleared from the pin
      // once no send is in flight. See message-thread.tsx pin logic.
      //
      // Carry the send GROUP id too: it's what keeps the auto-claim trio
      // (ai_paused + reopened + self-assigned) ordered by seq AFTER they un-pin,
      // so their racy server `at` can't swap them. Without carrying it the
      // settled rows would lose the grouping and re-sort by `at` — the exact
      // vibration. Only same-send pills carry it, so every other log is
      // untouched (see message-thread.tsx sort).
      return {
        ...row,
        id: best.id,
        ...(best.optimisticSeq != null ? { optimisticSeq: best.optimisticSeq } : {}),
        ...(best.optimisticGroupId != null
          ? { optimisticGroupId: best.optimisticGroupId }
          : {}),
      };
    }
    return row;
  });

  const cutoff = Date.now() - OPTIMISTIC_ACTIVITY_TTL_MS;
  const stillPending = stubs.filter(
    (s) => !consumed.has(s.id) && new Date(s.at).getTime() >= cutoff,
  );

  const next = stillPending.length
    ? [...relabeled, ...stillPending]
    : relabeled;
  return sameEventSequence(prevEvents, next) ? prevEvents : next;
}

export interface ConversationEventsState {
  data: ConversationWithRefs;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  /**
   * True ONLY when `loadOlder` stopped paging because the in-memory slice
   * hit MAX_THREAD_SLICE — i.e. the server had more pages but we capped
   * for scroll perf. Distinct from `!hasMoreOlder && !reachedSliceCap`
   * (the normal "nothing older to load"). Lets the UI surface a hint like
   * "Use search to find older messages" without false-positive on threads
   * that simply have <500 messages total.
   */
  reachedSliceCap: boolean;
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
/**
 * Schedule a `URL.revokeObjectURL` on the next macrotask. Used after an
 * optimistic media bubble reconciles with its server-confirmed twin:
 * the bubble is swapped to use the server's URL, so the optimistic
 * blob is no longer needed. The brief delay lets the React commit that
 * swapped `<img src>` settle before the blob handle goes away — some
 * browsers race the revoke against the second `<img>`'s initial load
 * when both happen in the same microtask.
 *
 * `revokedBlobs` tracks already-scheduled URLs so duplicate frames
 * (broadcast republish, reconnect refetch) don't double-schedule a
 * revoke. We also clear seen entries on a long-running cap to bound
 * the set under a busy session (a few hundred sends per agent per shift
 * × 30 chars per blob URL = trivial — but capped for hygiene).
 */
const revokedBlobs = new Set<string>();
const REVOKED_BLOBS_MAX = 1_000;
function scheduleBlobRevoke(url: string): void {
  if (typeof URL === "undefined" || revokedBlobs.has(url)) return;
  if (revokedBlobs.size >= REVOKED_BLOBS_MAX) {
    // LRU-ish: drop the oldest entry by iteration order to cap memory.
    const oldest = revokedBlobs.values().next().value;
    if (oldest !== undefined) revokedBlobs.delete(oldest);
  }
  revokedBlobs.add(url);
  // ~100ms gives a comfortable window for React commit + browser layout
  // to complete the `<img src>` swap before the blob handle disappears.
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Some browsers throw if the URL was never registered; harmless.
    }
  }, 100);
}

export function useConversationEvents(
  initial: ConversationWithRefs,
  initialNextOlderCursor: string | null,
  // Called after the mark-read POST resolves so the shell can patch its
  // cached thread snapshot (unreadCount → 0). Without this, switching back
  // to a thread already viewed this session would re-fire the POST every
  // time MessageThread re-mounts.
  onMarkRead?: (conversationId: string) => void,
  // Called on unmount (chat switch / mobile-back / leaving the inbox) with the
  // latest live data + older-cursor so the shell can write it back into its LRU
  // snapshot. Without this, the cache keeps the stale SSR/fetch snapshot and a
  // switch-back renders the thread missing every message sent/received this
  // visit — the `?after=` backfill then pops them in 0–1.5s later (the flash
  // the user sees, most noticeable on a short emoji-only bubble).
  onSnapshot?: (data: ConversationWithRefs, nextOlderCursor: string | null) => void,
  // True when `initial` came from a possibly-stale LRU snapshot (a cache-HIT
  // switch-back). While the thread sat backgrounded it wasn't subscribed to its
  // conversation room, so message:status (delivered/read) ticks for messages it
  // already holds never arrived, and the `?after=` delta can't carry them. When
  // set, first-connect runs the FULL refetch (which reconciles statuses) instead
  // of the lightweight delta, so stale checkmarks resolve on open. SSR-fresh /
  // cache-MISS opens pass false (their data is already current).
  initialMayBeStale = false,
): ConversationEventsState {
  const router = useRouter();
  const [data, setData] = useState<ConversationWithRefs>(initial);
  const [olderCursor, setOlderCursor] = useState<string | null>(initialNextOlderCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Set true ONLY when loadOlder hit the slice cap with a non-null server
  // cursor (i.e. the server had more, we chose not to load it). Reset on
  // conversation switch + on replaceWithContext (the window swap discards
  // the slice entirely). Drives the "use search for older" hint in the UI.
  const [reachedSliceCap, setReachedSliceCap] = useState(false);

  // True while the loaded slice ends at the live tail (initial load, sends,
  // inbound, load-older — all keep the bottom). Flipped false by a search-jump
  // (`replaceWithContext` swaps in a context window around an OLD message, and
  // the inbox has no load-newer), which gates the snapshot-on-leave below: we
  // must NOT persist a context window into the cache, or switch-back would
  // strand the agent at the old message instead of the recent tail.
  const tailAnchoredRef = useRef(true);

  // Render-time prop sync. Using useEffect for this leaves a paint cycle where
  // MessageThread renders the OLD conversation's messages under the NEW URL —
  // visible as a flash when switching chats. React processes state updates
  // dispatched during render in the same commit, so the swap is atomic.
  const [trackedId, setTrackedId] = useState(initial.conversation.id);
  if (trackedId !== initial.conversation.id) {
    setTrackedId(initial.conversation.id);
    setData(initial);
    setOlderCursor(initialNextOlderCursor);
    setReachedSliceCap(false);
    // Fresh conversation slice = tail-anchored again.
    tailAnchoredRef.current = true;
  }

  const conversationId = initial.conversation.id;

  // Tell the notification-sound engine which thread is on screen so the
  // app-wide new-message ding stays silent for the conversation you're actively
  // viewing in a focused tab. Re-runs on thread switch; cleared on unmount.
  useEffect(() => {
    notificationSound.setActiveThread(conversationId);
    return () => notificationSound.setActiveThread(null);
  }, [conversationId]);

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

  // Snapshot-on-leave. `dataRef`/`cursorRef` hold the most-recent committed
  // values, so on unmount we hand the shell the full live slice (every message
  // from this visit, plus any loaded older pages) + the current older-cursor.
  // Empty deps → the cleanup fires exactly once, at unmount, which is the only
  // moment the next visit will re-read the cache.
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  useEffect(() => {
    return () => {
      // Skip when the slice is a search-jump context window (not the tail) —
      // persisting it would land the next visit on an old message. Leaving the
      // cache's prior tail snapshot is the correct fallback (backfill reconciles
      // anything newer), matching pre-snapshot behavior for that rare path.
      if (!tailAnchoredRef.current) return;
      // Strip UN-reconciled optimistic activity stubs before persisting to the
      // LRU. If the agent changed status/stage/assign/tag and switched threads
      // BEFORE the trailing `refreshActivity` GET reconciled the stub, the
      // snapshot would otherwise carry a client-clocked `optimisticPending` pill
      // that re-surfaces pinned-to-bottom + OUT OF ORDER on switch-back — and no
      // /events GET runs on a cached remount to clear it, so on a quiet thread it
      // lingers. The authoritative row re-arrives on the next live frame /
      // reconnect; a briefly-absent recent pill is far better than a wrong-order
      // lingering one. (Steady state the GET wins the race, so there's nothing to
      // strip and this is a no-op that returns the same reference.)
      const snap = dataRef.current;
      const events = snap.events ?? [];
      const clean = events.filter(
        (e) => !isOptimisticActivityId(e.id) && e.optimisticPending !== true,
      );
      onSnapshotRef.current?.(
        clean.length === events.length ? snap : { ...snap, events: clean },
        cursorRef.current,
      );
    };
  }, []);

  // Set when a connect (or reconnect) fired while the tab was hidden — we
  // skipped the backfill at that moment to avoid joining the thundering
  // herd, and the visibility listener will fire it the moment the user
  // returns. Lives in a ref because the connect / visibility / unmount
  // closures all need to read the same flag without re-running the effect.
  const backfillNeededRef = useRef(false);

  // Set when an inbound landed while the tab was hidden. We deliberately do
  // NOT mark read in that case — a background tab parked on this thread must
  // not silently clear team-wide unread for a message nobody actually saw.
  // The visibility listener fires the deferred markRead when the agent returns.
  const sawInboundWhileHiddenRef = useRef(false);

  // First socket connect of THIS hook instance = thread open / SSR-hydration
  // gap, where the lightweight `?after=` delta is enough. A SUBSEQUENT connect
  // is a real reconnect after a drop, where arbitrary thread state (notes,
  // contact rename/tags/stage, message statuses, media) may have changed while
  // we were offline — the delta can't carry those, so we full-refetch the
  // thread instead. `reconnectRecoveryRef` carries that decision into the
  // deferred (hidden → visible) recovery path.
  const hasConnectedOnceRef = useRef(false);
  const reconnectRecoveryRef = useRef(false);
  // Constant per mount (the thread remounts on conversation switch), read in the
  // socket effect's onConnect without making it an effect dep.
  const initialMayBeStaleRef = useRef(initialMayBeStale);

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
          // Distinguish the two "no cursor" cases for the UI: server said
          // there's more (we capped) vs. server returned a null cursor on
          // its own (genuinely no more). reachedSliceCap drives the hint.
          const cappedOut =
            nextSliceLen >= MAX_THREAD_SLICE && page.nextCursor !== null;
          setOlderCursor(cappedOut ? null : page.nextCursor);
          if (cappedOut) setReachedSliceCap(true);
        });
        return added;
      } catch {
        // Network-level rejection paging older messages (flaky connection /
        // aborted fetch). Return 0 — the scroll-restore wrapper treats it as
        // "nothing prepended" and leaves the view put; the cursor is untouched
        // so the next scroll-to-top retries. Matches the silent-degrade
        // convention the sibling recovery paths follow, and stops an unhandled
        // rejection from bubbling out of the async callback.
        return 0;
      } finally {
        inFlightOlder.current = false;
        setLoadingOlder(false);
      }
    },
    [conversationId],
  );

  // Mark-read coordination. The shell tells us via `onMarkRead` to patch
  // the cached unreadCount=0 after the POST succeeds, so the list badge + LRU
  // snapshot converge without waiting on the server's one-shot read frame.
  // The mount effect below POSTs on every visible open regardless of the
  // cached count (see its comment) — the server short-circuits the already-read
  // case cheaply. Throttled via `useCoalescedAsync` — a burst of inbound
  // messages (or rapid chat switching) fires one POST instead of N; same util
  // backs the team-chat hook so the pattern stays consistent across surfaces.
  const onMarkReadRef = useRef(onMarkRead);
  onMarkReadRef.current = onMarkRead;
  const markRead = useCoalescedAsync(async () => {
    try {
      const res = await apiFetch(`/api/conversations/${conversationId}/read`, { method: "POST" });
      if (res.ok) onMarkReadRef.current?.(conversationId);
    } catch {
      // Silent — server state reconciles on the next call / page reload.
    }
  }, [conversationId]);

  // Mark read on mount when the agent is actually looking. The shell remounts
  // this hook on every chat switch (via key=displayedId).
  //
  // We deliberately do NOT gate on the cached `initial.conversation.unreadCount`
  // snapshot. On a client-side chat-switch that snapshot can be stale-LOW: it
  // predates inbound that landed while the thread sat in the inbox LRU, so the
  // DB counter is genuinely >0 while the snapshot reads 0. Trusting it skipped
  // the POST and left the team-wide counter stuck-high until a later
  // authoritative frame (e.g. a broadcast republishing the row's true count)
  // surfaced it as a sudden badge jump. Always POST instead — the server
  // markRead is a single cheap read when the counter is already 0 (and sends no
  // redundant Meta read-receipt), and `markRead` is coalesced, so the over-call
  // on an already-read thread is negligible. This makes convergence-on-open
  // independent of the fragile reconnect/backfill timing that's supposed to
  // catch the same case.
  useEffect(() => {
    // Still defer when hidden: a thread mounting into a background tab (cmd-click)
    // must not clear team-wide unread for a message nobody viewed. onVisibility
    // fires the deferred read on return, same rule as live inbounds.
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      void markRead();
    } else {
      sawInboundWhileHiddenRef.current = true;
    }
  }, [markRead]);

  useEffect(() => {
    const socket = getClientSocket();

    // Pending jittered-recovery timers scheduled by onConnect (a reconnect adds
    // a 0–1500ms jitter before firing runFullRefetch/runBackfill). MUST be
    // cleared on unmount: if the agent switches threads inside the jitter
    // window, the old hook unmounts but a leaked timer would still fire
    // runFullRefetch for the OLD conversationId — its setData is a harmless
    // no-op on the unmounted hook, but its markRead side-effect would clear
    // team-wide unread for a thread nobody is viewing (the project's
    // most-guarded invariant: never drop a customer message from triage).
    const recoveryTimers = new Set<number>();

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

      // First connect = open/hydration (delta is enough); later = real
      // reconnect (full refetch to recover state the delta can't carry).
      const isReconnect = hasConnectedOnceRef.current;
      hasConnectedOnceRef.current = true;

      // Skip the recovery when the tab isn't visible. A team of N agents
      // with M tabs each → N·M parallel queries on every Caddy bounce /
      // deploy — and most of those tabs are background or sleeping. The
      // visibility-change listener below picks it back up the moment the
      // user returns to the tab; `reconnectRecoveryRef` remembers whether
      // that deferred run should be a full refetch or a delta.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        backfillNeededRef.current = true;
        reconnectRecoveryRef.current = isReconnect;
        return;
      }
      // Skip while the browser reports offline. The Socket.io `connect` can
      // briefly fire on a flaky network (WS upgrade transient) when HTTP is
      // still down — the recovery GET would just hang to the 30s timeout
      // and pile up across tabs. Defer to `online`-event recovery instead;
      // it re-runs `onConnect`'s effect (the connect listener stays subscribed)
      // and the visibility/online listener below picks it back up.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        backfillNeededRef.current = true;
        reconnectRecoveryRef.current = isReconnect;
        return;
      }

      // (SSR-fresh skip was tried 2026-05-26 and reverted same day: the
      // 3s mount-time heuristic was measured against hook MOUNT, not SSR
      // RENDER, so on a slow handshake / slow hydration any webhook that
      // landed between Prisma's SSR read and the first `subscribe:conversation`
      // was silently lost until the next reconnect / chat switch. The
      // delta is a tiny indexed keyset query — the cost saving was real
      // but tiny, while the lost-message risk was silent. Always run the
      // delta on first-connect; reconnect-after-drop runs the full
      // refetch. See [[project_predeploy_p1_fixes_2026_05_26]].)

      // Random jitter (0–1500ms) breaks the synchronized reconnect storm
      // after a deploy. Without it, every open tab in the team fires its
      // recovery GET at the same instant, dog-piling Postgres.
      // First connect from a possibly-stale cache snapshot → full refetch so
      // message statuses (delivered/read ticks missed while backgrounded)
      // reconcile, not just the newer-messages delta.
      const recover =
        isReconnect || initialMayBeStaleRef.current ? runFullRefetch : runBackfill;
      // Jitter only matters for the reconnect STORM (every tab firing recovery
      // at once after a deploy/Caddy bounce). A first-connect open is a single
      // foreground thread the agent is watching — run it immediately so
      // status/new-message convergence isn't delayed up to 1.5s.
      const delay = isReconnect ? Math.floor(Math.random() * 1500) : 0;
      const timerId = window.setTimeout(() => {
        recoveryTimers.delete(timerId);
        recover();
      }, delay);
      recoveryTimers.add(timerId);
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
                  aiEnabled: boolean;
                  lastInboundAt: string | null;
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
            //
            // `lastInboundAt` is also re-synced — drives the 24h-window
            // composer lock. A reconnect during which an inbound landed
            // would otherwise leave the composer falsely greyed out.
            let next = prev;
            if (freshState) {
              const headerChanged =
                next.conversation.status !== freshState.status ||
                next.conversation.assignedUserId !== freshState.assignedUserId ||
                next.conversation.unreadCount !== freshState.unreadCount ||
                (next.conversation.aiEnabled ?? true) !== freshState.aiEnabled ||
                (next.assignedUser?.id ?? null) !==
                  (freshState.assignedUser?.id ?? null) ||
                next.lastInboundAt !== freshState.lastInboundAt;
              if (headerChanged) {
                next = {
                  ...next,
                  conversation: {
                    ...next.conversation,
                    status: freshState.status,
                    assignedUserId: freshState.assignedUserId,
                    unreadCount: freshState.unreadCount,
                    aiEnabled: freshState.aiEnabled,
                  },
                  assignedUser: freshState.assignedUser,
                  lastInboundAt: freshState.lastInboundAt,
                };
              }
            }
            if (freshItems.length === 0) return next;
            const have = new Set(next.messages.map((m) => m.externalId));
            const fresh = freshItems.filter((m) => !have.has(m.externalId));
            if (!fresh.length) return next;
            // Reconcile own optimistic sends whose confirming frame the gap
            // swallowed, so they don't duplicate + go phantom-failed.
            const reconciled = reconcileOptimisticAgainst(next.messages, fresh);
            return {
              ...next,
              messages: sortByTimestamp([...reconciled, ...fresh]),
              // Keep the contact-panel "Messages" tally in sync. onMessageNew
              // (+1) and runFullRefetch (adopts server count) both maintain it;
              // the delta backfill must too, or the tally drifts low by N after
              // an SSR/reconnect gap swallowed N inbound/outbound frames.
              ...(next.messageCount !== undefined
                ? { messageCount: next.messageCount + fresh.length }
                : {}),
            };
          });

          // runBackfill only runs while the tab is visible (see onConnect /
          // onVisibility), so reaching here means the user is actively viewing
          // this thread. Clear any unread that accumulated during the socket
          // gap / hydration window — mirrors the live onMessageNew markRead.
          // Without this, an inbound that lands during a reconnect blip (wifi
          // hop, laptop sleep) leaves the team-wide badge stuck at >0 until a
          // new message arrives or the user navigates away and back.
          if (freshState && freshState.unreadCount > 0) {
            void markRead();
          }
        })
        .catch(() => {
          // Silent — the next reconnect or thread navigation re-fetches
          // authoritatively via the server component. A noisy retry loop
          // here would just compound a real outage.
        });
    };

    // Full thread refetch — used on a real RECONNECT (vs the delta backfill
    // used on first connect). A drop can have missed arbitrary thread state
    // (notes, contact rename/tags/stage, message statuses, media) that the
    // `?after=` delta doesn't carry. We MERGE the fresh snapshot rather than
    // replace it: blindly swapping in the latest page would unmount any older
    // pages the user scrolled to and yank their scroll. Refetch, don't build a
    // replay layer (CLAUDE.md).
    //
    // When NOT anchored at the live tail (search-context window): we still
    // fetch the full snapshot, but skip the message-slice merge — the user's
    // older context window doesn't overlap the tail page the API returns, so
    // merging would just splice tail messages onto an unrelated slice. Header,
    // contact, notes, events are still applied (those are what the delta
    // CAN'T carry and what an offline gap most often invalidates). The user's
    // own scroll/slice is preserved untouched; the lightweight delta runs in
    // addition to top off any new-message gap from the offline period.
    const runFullRefetch = () => {
      backfillNeededRef.current = false;
      reconnectRecoveryRef.current = false;
      const headerOnly = !tailAnchoredRef.current;
      if (headerOnly) {
        // Still pull the lightweight delta so messages newer than our tail
        // get appended — the header-only path below doesn't touch messages.
        runBackfill();
      }
      void fetchWithSessionGuard(`/api/inbox/conversation/${conversationId}`)
        .then((r) =>
          r.ok
            ? (r.json() as Promise<{
                data: ConversationWithRefs;
                nextOlderCursor: string | null;
              }>)
            : null,
        )
        .then((res) => {
          if (!res) return;
          const fresh = res.data;
          setData((prev) => {
            // Header-only branch: agent is anchored to a search-context window,
            // not the live tail. Adopting fresh.messages would either splice
            // tail messages onto an unrelated slice or unmount their context.
            // Refresh only what the delta can't carry — header, contact, notes,
            // events. The runBackfill above already appended any new tail
            // messages that arrived after the user's slice (cursor = last
            // server-confirmed in the slice), so no gap on next scroll-back.
            if (headerOnly) {
              return {
                ...prev,
                conversation: fresh.conversation,
                contact: fresh.contact,
                assignedUser: fresh.assignedUser,
                notes: fresh.notes,
                events: mergeAuthoritativeEvents(prev.events, fresh.events),
                lastInboundAt: fresh.lastInboundAt,
                ...(fresh.messageCount !== undefined ? { messageCount: fresh.messageCount } : {}),
                ...(fresh.noteCount !== undefined ? { noteCount: fresh.noteCount } : {}),
              };
            }
            // Keep the user's loaded message slice (incl. older pages they
            // scrolled to → preserves scroll position). Reconcile server-owned
            // fields (status/media) for messages we already have, append any
            // fresh ones we're missing, and replace the rest of the snapshot
            // (header, contact, notes) which the delta can't carry. olderCursor
            // is left untouched — prev may hold pages deeper than fresh's
            // window, so its cursor is the correct "load older" anchor.
            const freshById = new Map(fresh.messages.map((m) => [m.id, m]));
            const have = new Set(prev.messages.map((m) => m.externalId));
            const reconciled = prev.messages.map((m) => {
              const f = freshById.get(m.id);
              if (!f) return m; // optimistic, or older than fresh's window
              // Reconcile server-owned fields the live frames could have missed
              // while this thread was cached/backgrounded: status, media, AND
              // reaction (a customer (un-)react on a non-displayed thread is
              // otherwise stale until reload). Sync `reaction` to the server's
              // value authoritatively so an un-react (f.reaction null) clears it.
              const reactionChanged = (f.reaction ?? null) !== (m.reaction ?? null);
              return f.status !== m.status || (f.media && !m.media) || reactionChanged
                ? { ...m, status: f.status, ...(f.media ? { media: f.media } : {}), reaction: f.reaction }
                : m;
            });
            const appended = fresh.messages.filter((m) => !have.has(m.externalId));
            // Same optimistic-vs-recovery reconcile as runBackfill: a refetch
            // can re-add our own send (missed live frame) as a confirmed row
            // while the pending optimistic still sits in `reconciled`. Drop the
            // pending OUT twin so it doesn't duplicate + go phantom-failed.
            const deduped = reconcileOptimisticAgainst(reconciled, appended);
            const messages = appended.length
              ? sortByTimestamp([...deduped, ...appended])
              : deduped;
            return {
              ...prev,
              conversation: fresh.conversation,
              contact: fresh.contact,
              assignedUser: fresh.assignedUser,
              notes: fresh.notes,
              // Authoritative refetch — adopt the server's activity log (it can
              // carry changes that happened while we were offline, which the
              // delta backfill can't). Keep any not-yet-persisted optimistic
              // stub so an in-flight local change isn't wiped mid-flight.
              events: mergeAuthoritativeEvents(prev.events, fresh.events),
              messages,
              lastInboundAt: fresh.lastInboundAt,
              ...(fresh.messageCount !== undefined ? { messageCount: fresh.messageCount } : {}),
              ...(fresh.noteCount !== undefined ? { noteCount: fresh.noteCount } : {}),
            };
          });
          // Same visibility guarantee as runBackfill (only reached while the
          // tab is visible) — clear any unread the gap left behind.
          if (
            (typeof document === "undefined" ||
              document.visibilityState === "visible") &&
            fresh.conversation.unreadCount > 0
          ) {
            void markRead();
          }
        })
        .catch(() => {
          // Silent — next reconnect / navigation re-fetches authoritatively.
        });
    };

    // Shared deferred-recovery dispatch. Called when ANY of the gating
    // conditions clears (tab becomes visible OR browser comes back online).
    // Re-checks all gates — the recovery is still skipped if the OTHER gate
    // is still red.
    const runDeferredRecoveryIfReady = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return;
      }
      if (backfillNeededRef.current && socket.connected) {
        sawInboundWhileHiddenRef.current = false;
        if (reconnectRecoveryRef.current) {
          runFullRefetch();
        } else {
          runBackfill();
        }
      } else if (sawInboundWhileHiddenRef.current) {
        // Socket stayed connected, but inbound(s) arrived while the tab was
        // hidden and we deferred the read. The agent is looking now — clear it.
        sawInboundWhileHiddenRef.current = false;
        void markRead();
      }
    };

    // If a connect happened while the tab was hidden / offline, re-run the
    // recovery when conditions clear. This is what makes "open laptop after
    // lunch" recover the gap without forcing a manual reload.
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      runDeferredRecoveryIfReady();
    };
    const onOnline = () => {
      runDeferredRecoveryIfReady();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
    }
    socket.on("connect", onConnect);
    if (socket.connected) onConnect();

    const onMessageNew: Parameters<typeof socket.on<"message:new">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      // Reconcile against any optimistic bubble we put up for this send.
      // Match by clientTempId when present; otherwise just append.
      const tempId = payload.clientTempId;
      // Notify the reply-box's stuck-watchdog that the confirming frame arrived
      // (else it flips the bubble to "failed" after 30s despite a confirmed
      // send). Fired in the handler body — NOT inside the setData updater below —
      // so the updater stays a pure reducer (CLAUDE.md flags side effects in
      // setState updaters). The watchdog listener is once:true, so a duplicate
      // webhook frame re-firing this is a harmless no-op.
      if (tempId && typeof window !== "undefined") {
        try {
          window.dispatchEvent(new Event(`ccp:optimistic-confirmed:${tempId}`));
        } catch {
          // Synthetic events can't fail under normal conditions; ignore.
        }
      }
      setData((prev) => {
        // Dedupe by externalId — webhook retries can fire the same wamid twice.
        if (prev.messages.some((m) => m.externalId === payload.message.externalId)) {
          return prev;
        }

        const messages = tempId
          ? prev.messages.map((m) => {
              // Match pending OR failed optimistic rows. The background send
              // worker publishes `message.send_failed` (→ failed bubble) BEFORE
              // BullMQ retries; when a retry then succeeds, `message:new` carries
              // the SAME clientTempId and must CONSUME the failed bubble. Gating
              // on `!m.pending` alone left the failed row in place → a duplicate
              // bubble with a stale Retry button on every failed→succeeded send.
              if (m.clientTempId !== tempId || (!m.pending && !m.failed)) return m;
              // Swap the optimistic row with the server's authoritative
              // copy so the bubble's id, externalId, status, etc. line up
              // with reality. Preserve clientTempId so the React key stays
              // stable — otherwise the DOM node unmounts and the entrance
              // animation re-fires.
              //
              // Media-url swap: when the server returns a media URL,
              // SWAP to it (don't preserve the blob:). The /api/media/<id>
              // path 302s to UploadThing's CDN with
              // `Cache-Control: immutable, max-age=31536000`, so the
              // browser fetches the redirect target once and caches it
              // forever — back-navigation, page reload, snapshot replay
              // all hit the disk cache. Preserving the blob URL across
              // reconcile pinned the underlying File bytes in V8 heap
              // for the lifetime of the LRU cache snapshot (~hours);
              // earlier we patched that with a 5s delayed revoke, but
              // that broke back-navigation within the 5s window because
              // the LRU snapshot held a now-dangling blob URL. Swapping
              // to the server URL on reconcile is the cleanest fix:
              // memory is released immediately AND back-nav always works.
              //
              // If the server DROPPED media entirely (blob upload failed
              // server-side but Meta delivery succeeded), keep the
              // optimistic blob — the customer got the image, we just
              // can't render across reloads in this session, so don't
              // yank it from the current agent's view.
              const optimisticMedia = m.media;
              const serverMedia = payload.message.media;
              let media = serverMedia;
              if (!serverMedia && optimisticMedia) {
                media = optimisticMedia;
              }
              // Revoke the optimistic blob URL once we've swapped to the
              // server URL — small microtask delay so the React commit
              // that swaps `<img src>` has a chance to settle before the
              // blob handle goes away. Without the delay, the same render
              // commit holds two refs to the same blob URL briefly; some
              // browsers race the revoke against the second `<img>`'s
              // initial load.
              if (
                serverMedia &&
                optimisticMedia?.url.startsWith("blob:") &&
                optimisticMedia.url !== serverMedia.url
              ) {
                scheduleBlobRevoke(optimisticMedia.url);
              }
              return {
                ...payload.message,
                clientTempId: tempId,
                // Preserve the send-order seq across reconcile (like
                // clientTempId): the timeline keeps this confirmed row pinned in
                // send order until earlier-seq siblings also confirm, so an
                // out-of-order message:new can't flash it above a still-pending
                // earlier send. Cleared naturally once no sibling is pending.
                ...(m.optimisticSeq != null ? { optimisticSeq: m.optimisticSeq } : {}),
                // Preserve the send's group key too, so the auto-claim pills keep
                // anchoring to this confirmed message (sorting under it in send
                // order) instead of floating up to their own audit `at`. See
                // message-thread.tsx anchor sort + Message.optimisticGroupId.
                ...(m.optimisticGroupId != null
                  ? { optimisticGroupId: m.optimisticGroupId }
                  : {}),
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
            lastMessageDirection: payload.message.direction,
          },
          messages: reconciled,
          lastInboundAt: nextLastInbound,
          ...(prev.messageCount !== undefined
            ? { messageCount: prev.messageCount + 1 }
            : {}),
        };
      });

      // Bounce unread back to zero so other clients clear their badge too —
      // but ONLY when the agent is actually looking. A hidden tab parked on
      // this thread must not clear team-wide unread for a message nobody saw;
      // defer to onVisibility, which fires the read when the tab returns.
      // Inbound only; outbound doesn't bump unread.
      if (payload.message.direction === "in") {
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          void markRead();
        } else {
          sawInboundWhileHiddenRef.current = true;
        }
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

    // Optimistic activity pill (client-only; see socket events.ts +
    // optimistic-activity.ts). The agent who changed status / assignment /
    // stage / tag fans a synthetic ConversationActivityEvent so the timeline
    // pill appears in the SAME frame as the header, not a GET behind it.
    // `event` present → append (dedupe by id); `removeId` → splice (rollback on
    // a failed PATCH). The trailing authoritative `refreshActivity` GET replaces
    // the whole `events` array with server rows, transparently reconciling the
    // stub away (its `optimistic-…` id never matches a server row).
    const onActivity: Parameters<typeof socket.on<"conversation:activity">>[1] = (payload) => {
      if (payload.conversationId !== conversationId) return;
      setData((prev) => {
        const events = prev.events ?? [];
        if (payload.removeId) {
          const next = events.filter((e) => e.id !== payload.removeId);
          return next.length === events.length ? prev : { ...prev, events: next };
        }
        if (!payload.event) return prev;
        if (events.some((e) => e.id === payload.event!.id)) return prev;
        return { ...prev, events: [...events, payload.event] };
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
      // findIndex+slice instead of a blanket .map(): on a 1k-message thread
      // the failure event was reallocating the whole array even when no row
      // matched (common under broadcast-failure storms — the failing message
      // sits on a different conversation but the event still fires once per
      // listener). Mirrors the pattern in `applyMessageStatus` at
      // thread-reducers.ts:112.
      setData((prev) => {
        const idx = prev.messages.findIndex(
          (m) => m.clientTempId === payload.clientTempId && m.pending,
        );
        if (idx === -1) return prev;
        const target = prev.messages[idx]!;
        const next = prev.messages.slice();
        next[idx] = { ...target, pending: false, failed: true };
        return { ...prev, messages: next };
      });
    };

    // Coalesced bulk contact fanout. A teammate's bulk tag / stage / field
    // operation that includes THIS thread's contact fires one
    // `contacts:bulk_updated` frame (ids only, no contact bodies — so the
    // per-contact `contact:updated` reducer can't carry it). Without a handler
    // here the displayed thread's contact panel, header stage stepper and
    // snippet token resolution stayed stale until the agent switched chats and
    // back (the cache-hit full refetch finally reconciled) or reconnected.
    // Converge by full-refetching the thread when the bulk frame touches our
    // contact — runFullRefetch pulls the fresh full ConversationWithRefs (the
    // /api/contacts/lookup endpoint only returns id/name/phone, too thin to
    // patch stage/tags/customFields). The fetch is gated to the matching id so
    // an unrelated team-wide bulk op doesn't refetch every open thread.
    const onContactsBulkUpdated: Parameters<
      typeof socket.on<"contacts:bulk_updated">
    >[1] = (payload) => {
      const ids = payload?.contactIds;
      if (!ids?.length) return;
      if (!ids.includes(dataRef.current.contact.id)) return;
      runFullRefetch();
    };

    // Dev-only invariant: every event we subscribe to here must be
    // accounted for in thread-reducers.ts (either in THREAD_REDUCER_EVENTS
    // for auto-wiring, or in REDUCER_EXCLUSIONS with a load-bearing reason).
    // Surfaces the "missed reducer wiring" class CLAUDE.md flags as the root
    // cause of stuck/stale per-thread state at decision-tree time. No-op
    // in production.
    const MANUAL_LIVE_HOOK_EVENTS: readonly string[] = [
      "message:new",
      "message:status",
      "message:failed",
      "note:new",
      "conversation:activity",
      "conversation:deleted",
      "contacts:bulk_updated",
      "connect",
    ];
    assertReducerCoverage([
      ...THREAD_REDUCER_EVENTS.map((e) => e.event as string),
      ...MANUAL_LIVE_HOOK_EVENTS,
    ]);

    socket.on("message:new", onMessageNew);
    // message:status is in COALESCED_LIVE_HOOK_EVENTS — the live hook RAF-
    // coalesces it (sent/delivered/read transitions cascade in bursts and a
    // React render per arrival pinned the inbox CPU during broadcasts). The
    // reducer itself is still shared via THREAD_REDUCER_EVENTS so the
    // cached-shell consumer applies the same logic without RAF batching.
    socket.on("message:status", onMessageStatus);
    socket.on("message:failed", onMessageFailed);
    socket.on("note:new", onNoteNew);
    socket.on("conversation:activity", onActivity);
    socket.on("conversation:deleted", onConversationDeleted);
    socket.on("contacts:bulk_updated", onContactsBulkUpdated);

    // Activity-log live refresh. The audit row for a status / assign / stage /
    // tag / note-delete change is written server-side AFTER the realtime frame
    // fans out (audit runs at a lower bus priority than realtime), so when one
    // of those frames lands we re-pull the events-only window and merge it in.
    // This keeps pills fully server-attributed (correct actor + id) with no
    // client-side guessing. Debounced + coalesced so a burst (e.g. bulk
    // tag-add fanning several contact:updated) makes one request, and a
    // trailing self-cancelling guard drops a response that arrives after the
    // user switched threads.
    //
    // Events that imply an audit row exists for THIS thread. (note:deleted is
    // handled by its own reducer for the card removal AND triggers a refresh
    // here for the "deleted a note" pill.)
    const ACTIVITY_REFRESH_EVENTS = new Set([
      "conversation:status",
      "conversation:assigned",
      "conversation:ai",
      "contact:updated",
      "note:deleted",
    ]);
    const runActivityFetch = () => {
      void fetchWithSessionGuard(`/api/conversations/${conversationId}/events`)
        .then((r) => (r && r.ok ? (r.json() as Promise<{ events: ConversationWithRefs["events"] }>) : null))
        .then((body) => {
          if (!body) return;
          // Drop a late response for a thread we've since left.
          if (dataRef.current.conversation.id !== conversationId) return;
          setData((prev) => {
            const events = mergeAuthoritativeEvents(prev.events, body.events);
            // mergeAuthoritativeEvents returns the prior reference when nothing
            // changed — skip the state write entirely so a coalesced no-op GET
            // doesn't re-render the timeline.
            return events === prev.events ? prev : { ...prev, events };
          });
        })
        .catch(() => {
          // Non-fatal: the next thread open / reconnect refetch carries the
          // authoritative events anyway.
        });
    };

    // Leading-edge + trailing coalesce. The pill for a SINGLE change (one
    // status / assign / note-delete — the dominant case) used to wait a full
    // 350ms trailing debounce before the GET even fired, so the pill lagged the
    // rest of the realtime patch by a third of a second. Fire the GET
    // IMMEDIATELY on the first frame instead, then suppress refires for the
    // debounce window and run ONE trailing fetch if more frames landed during
    // it. The trailing pass still matters because (a) bursts like a bulk
    // tag-add fan several contact:updated frames and (b) the audit row is
    // written AFTER the realtime frame (lower bus priority), so a leading fetch
    // can race ahead of its own row — the trailing fetch backstops that. The
    // leading fetch on its own also self-corrects on the next change or the
    // reconnect/open refetch, so a one-off race just means the pill lands a beat
    // later, never wrong.
    let activityRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let activitySawTrailing = false;
    const refreshActivity = () => {
      if (activityRefreshTimer !== null) {
        // Inside the window — a leading fetch already fired; remember to do one
        // trailing pass so burst/late-audit rows get picked up.
        activitySawTrailing = true;
        return;
      }
      runActivityFetch();
      activityRefreshTimer = setTimeout(() => {
        activityRefreshTimer = null;
        if (activitySawTrailing) {
          activitySawTrailing = false;
          runActivityFetch();
        }
      }, 350);
    };

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
    const reducerHandlers = THREAD_REDUCER_EVENTS.filter(
      (e) => !COALESCED_LIVE_HOOK_EVENTS.has(e.event),
    ).map(({ event, apply, target }) => {
      const handler = (payload: { conversationId?: string } & Record<string, unknown>) => {
        // Reducer try/catch — a malformed payload from a version-skewed
        // server (post-deploy) would throw inside the setState updater
        // and break the React tree for the displayed thread. Isolate to
        // this event so the rest of the inbox keeps working.
        try {
          const targetsThisThread =
            (target ?? "conversation") === "all" ||
            payload?.conversationId === conversationId;
          if ((target ?? "conversation") === "conversation") {
            if (payload?.conversationId !== conversationId) return;
          }

          setData((prev) => (apply as any)(prev, payload));
          // After applying the header/contact patch, pull the matching audit
          // entry so the inline pill appears live — but only when the change
          // is actually for THIS thread AND it's the authoritative
          // (non-optimistic) frame:
          //   - `contact:updated` is target:"all" and carries no
          //     conversationId, so `targetsThisThread` is always true for it.
          //     Narrow to this thread's contact id; otherwise every team-wide
          //     contact edit fires a GET on every agent's open thread.
          //   - Optimistic dispatches land BEFORE the PATCH commits + the
          //     audit row is written, so a refresh then returns a stale window
          //     with no new pill. The authoritative server frame fires a
          //     second refresh that finds the row — so we skip the optimistic
          //     one entirely (same guard the list hook uses for resync).
          const isOptimistic =
            (payload as { optimistic?: boolean }).optimistic === true;
          const refreshTargetsThisThread =
            event === "contact:updated"
              ? (payload as { contact?: { id?: string } }).contact?.id ===
                dataRef.current.contact.id
              : targetsThisThread;
          if (
            refreshTargetsThisThread &&
            !isOptimistic &&
            ACTIVITY_REFRESH_EVENTS.has(event)
          ) {
            refreshActivity();
          }
        } catch (err) {

          console.error(`[use-conversation-events] reducer for "${event}" threw`, err);
        }
      };

      socket.on(event as any, handler as any);
      return { event, handler };
    });

    return () => {
      // Cancel any in-flight jittered-recovery timer. Without this a leaked
      // runFullRefetch could fire after the agent left this thread and markRead
      // it — silently clearing team-wide unread for a message nobody saw.
      for (const t of recoveryTimers) window.clearTimeout(t);
      recoveryTimers.clear();
      // Drop any pending coalesced status flush — the next mount will
      // backfill anything we missed via the `?after=...` GET.
      if (statusFlushRaf !== null) {
        cancelAnimationFrame(statusFlushRaf);
        statusFlushRaf = null;
      }
      if (activityRefreshTimer !== null) {
        clearTimeout(activityRefreshTimer);
        activityRefreshTimer = null;
      }
      pendingStatuses.clear();
      socket.emit("unsubscribe:conversation", { conversationId });
      socket.off("connect", onConnect);
      socket.off("message:new", onMessageNew);
      socket.off("message:status", onMessageStatus);
      socket.off("message:failed", onMessageFailed);
      socket.off("note:new", onNoteNew);
      socket.off("conversation:activity", onActivity);
      socket.off("conversation:deleted", onConversationDeleted);
      socket.off("contacts:bulk_updated", onContactsBulkUpdated);
      for (const { event, handler } of reducerHandlers) {
         
        socket.off(event as any, handler as any);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
    };
  }, [conversationId, markRead, router]);

  // -------------------------------------------------------------------------
  // Optimistic helpers — exposed to ReplyBox so a click-to-send paints the
  // bubble before the network call returns.
  // -------------------------------------------------------------------------

  const addOptimistic = useCallback((message: Message) => {
    // Stamp a send-order seq if the caller didn't (reply-box assigns it
    // synchronously so it orders before the auto-pause pill it dispatches next;
    // this fallback covers any other optimistic-add path). See optimistic-seq.ts.
    const stamped =
      message.optimisticSeq != null
        ? message
        : { ...message, optimisticSeq: nextOptimisticSeq() };
    setData((prev) => ({
      ...prev,
      conversation: {
        ...prev.conversation,
        lastMessageAt: stamped.timestamp,
        // Media-only sends (notably caption-less voice notes) have an empty
        // body — fall back to the same "🎤 Voice message" / "📷 Photo" label
        // the server writes, so the snapshot this thread leaves in the LRU
        // cache doesn't carry a blank preview that would flash a stale row.
        lastMessagePreview: (
          stamped.body || (stamped.media ? mediaPreviewLabel(stamped.media.kind) : "")
        ).slice(0, 200),
        lastMessageDirection: stamped.direction,
      },
      // Sort pins pending bubbles at the bottom (sortKey = ∞) regardless of
      // their local-clock timestamp, so a slow-system-clock or rapid-fire
      // send doesn't shove the new bubble above an earlier real message.
      messages: sortByTimestamp([...prev.messages, stamped]),
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
      // GUARD on pending/failed — NOT clientTempId alone. When a send is
      // reconciled by `message:new`, the server-confirmed row KEEPS its
      // clientTempId for React-key stability (see onMessageNew). So a confirmed,
      // already-delivered message still matches this clientTempId. If the HTTP
      // POST then rejects (timeout / 502) AFTER the socket confirm already
      // landed, reply-box's catch path calls onOptimisticRetry (= this) — and a
      // clientTempId-only filter would DELETE the confirmed bubble + restore its
      // text into the composer, inviting a double-send (a fresh clientTempId on
      // resend defeats server idempotency, so the customer gets it twice). Only
      // drop rows that are still pending OR failed (the legit dismiss/retry
      // targets); a confirmed twin is left untouched. Mirrors the same
      // `m.pending || m.failed` guard markOptimisticFailed and
      // reconcileOptimisticAgainst already use.
      const toDrop = prev.messages.find(
        (m) => m.clientTempId === clientTempId && (m.pending || m.failed),
      );
      if (!toDrop) return prev;
      // Free any blob: URL attached to the optimistic media before dropping
      // the row. createObjectURL'd URLs persist until revokeObjectURL is
      // called or the document is unloaded — without this revoke, dismissing
      // a failed 100MB video send and clicking Retry would leak the file
      // bytes for the lifetime of the tab. Net change is zero when the row
      // had no media or wasn't a blob: URL (e.g. an already-reconciled real
      // /api/media path).
      const mediaUrl = toDrop.media?.url;
      if (mediaUrl && mediaUrl.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(mediaUrl);
        } catch {
          // Ignore — already-revoked URLs throw, which is fine.
        }
      }
      return {
        ...prev,
        messages: prev.messages.filter(
          (m) => !(m.clientTempId === clientTempId && (m.pending || m.failed)),
        ),
      };
    });
  }, []);

  const replaceWithContext = useCallback(
    (input: { messages: Message[]; nextOlderCursor: string | null }) => {
      setData((prev) => ({ ...prev, messages: input.messages }));
      setOlderCursor(input.nextOlderCursor);
      // Slice was replaced with a window — the previous "we capped" signal
      // no longer applies (this is a fresh slice around a search hit).
      setReachedSliceCap(false);
      // Slice is now a window around an old message, not the live tail — gate
      // the snapshot-on-leave so we don't cache a non-tail slice.
      tailAnchoredRef.current = false;
    },
    [],
  );

  return {
    data,
    hasMoreOlder: olderCursor !== null,
    reachedSliceCap,
    loadingOlder,
    loadOlder,
    addOptimistic,
    markOptimisticFailed,
    removeOptimistic,
    replaceWithContext,
  };
}
