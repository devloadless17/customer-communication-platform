import type {
  ActiveCallState,
  CallSnapshot,
  Contact,
  ConversationStatus,
  ConversationWithRefs,
  MediaAttachment,
  MessageStatus,
  User,
} from "@ccp/shared/types";
import type { ServerToClientEvents } from "@ccp/shared/socket/events";

/**
 * Pure reducers: apply a socket event to a per-thread snapshot and return
 * a new snapshot, or the same reference when nothing changed (callers
 * short-circuit on identity).
 *
 * Single source of truth for:
 *   - `useConversationEvents` (live state of the displayed thread)
 *   - `inbox-shell.tsx` (ThreadCache snapshot for chat-switch round-trips)
 *
 * To wire a new per-thread field-mutating socket event: write the reducer
 * here and add one entry to `THREAD_REDUCER_EVENTS` below. Both consumers
 * iterate that array and bind handlers in a loop — they auto-pick-up the
 * new event with no edits required at either call site.
 *
 * Each entry declares a `target`:
 *   - "conversation" (default) — patch only the thread whose id matches
 *     `payload.conversationId`. Used for status / assigned / read / etc.
 *   - "all" — payload has no conversationId; the consumer must walk every
 *     cached thread and apply the reducer to each. The reducer itself
 *     bails (returns prev) on non-matching rows. Used for `contact:updated`
 *     which can affect any thread sharing the contact.
 *
 * Exclusions (handled outside the iterated array):
 *   - `message:new` / `note:new`     — list-mutating: live hook appends with
 *                                       dedupe, cached shell evicts.
 *   - `contacts:bulk_updated`        — coalesced fanout; cached shell evicts
 *                                       affected ids, contact pages refetch.
 *   - `conversation:deleted`         — navigation side-effect, not a patch.
 *   - `message:failed`               — touches optimistic-only rows on live
 *                                       side; cached shell evicts.
 */

export function applyConversationStatus(
  prev: ConversationWithRefs,
  payload: { status: ConversationStatus },
): ConversationWithRefs {
  if (prev.conversation.status === payload.status) return prev;
  return {
    ...prev,
    conversation: { ...prev.conversation, status: payload.status },
  };
}

export function applyConversationAssignment(
  prev: ConversationWithRefs,
  payload: { assignedUser: User | null },
): ConversationWithRefs {
  const nextId = payload.assignedUser?.id ?? null;
  if (prev.conversation.assignedUserId === nextId) return prev;
  return {
    ...prev,
    conversation: { ...prev.conversation, assignedUserId: nextId },
    assignedUser: payload.assignedUser,
  };
}

/**
 * Apply a `contact:updated` socket frame to a thread snapshot. Replaces
 * the embedded contact wholesale when the ids match, otherwise no-op.
 *
 * Targeted at `target: "all"` because the payload doesn't carry a
 * conversationId — the consumer (live hook or LRU walker) iterates every
 * cached thread and lets this reducer pick the matching one. Prior to
 * adding this, the live hook patched the displayed thread but the LRU's
 * snapshot was either evicted (non-displayed) or left UNTOUCHED for the
 * displayed thread — the latter caused stale contact data to re-appear
 * on chat-switch-back.
 */
export function applyContactUpdate(
  prev: ConversationWithRefs,
  payload: { contact: Contact },
): ConversationWithRefs {
  if (prev.contact.id !== payload.contact.id) return prev;
  if (prev.contact === payload.contact) return prev;
  return { ...prev, contact: payload.contact };
}

export function applyConversationRead(
  prev: ConversationWithRefs,
  _payload: { conversationId: string; readByUserId: string; teamId: string },
): ConversationWithRefs {
  // Unread is team-wide only — any member marking read zeroes the counter
  // and it clears for everyone. There is no per-agent read state.
  if (prev.conversation.unreadCount === 0) return prev;
  return {
    ...prev,
    conversation: { ...prev.conversation, unreadCount: 0 },
  };
}

// All three reducers below use findIndex-then-splice instead of map/filter.
// map/filter allocate a fresh array on every call, even when nothing
// changes — for a thread with 500 messages loaded, a status update for an
// out-of-slice message walks all 500 + allocates 500 slots just to return
// `prev`. findIndex bails on no-match before any allocation. Same pattern
// the socket-event hooks adopted in the re-render audit.

export function applyMessageStatus(
  prev: ConversationWithRefs,
  payload: { messageId: string; status: MessageStatus },
): ConversationWithRefs {
  const idx = prev.messages.findIndex((m) => m.id === payload.messageId);
  if (idx === -1) return prev;
  const existing = prev.messages[idx]!;
  if (existing.status === payload.status) return prev;
  const nextMessages = prev.messages.slice();
  nextMessages[idx] = { ...existing, status: payload.status };
  return { ...prev, messages: nextMessages };
}

export function applyMessageMediaReady(
  prev: ConversationWithRefs,
  payload: { messageId: string; media?: MediaAttachment },
): ConversationWithRefs {
  const idx = prev.messages.findIndex((m) => m.id === payload.messageId);
  if (idx === -1) return prev;
  const existing = prev.messages[idx]!;
  const nextMessages = prev.messages.slice();
  if (payload.media) {
    nextMessages[idx] = { ...existing, media: payload.media, mediaPending: false };
  } else {
    // Download failed / dropped — strip media block, keep row as text.
    const { media: _media, mediaPending: _p, ...rest } = existing;
    nextMessages[idx] = rest;
  }
  return { ...prev, messages: nextMessages };
}

export function applyNoteDeleted(
  prev: ConversationWithRefs,
  payload: { noteId: string },
): ConversationWithRefs {
  const idx = prev.notes.findIndex((n) => n.id === payload.noteId);
  if (idx === -1) return prev;
  const next = prev.notes.slice();
  next.splice(idx, 1);
  return {
    ...prev,
    notes: next,
    ...(prev.noteCount !== undefined
      ? { noteCount: Math.max(0, prev.noteCount - 1) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Voice-call reducers
//
// Set `activeCall` on incoming/ringing, flip to in_progress on answered,
// clear + append to `calls` history on terminal. The fanout splits incoming
// (team room toast) from ringing (conversation room) — the live hook
// dispatches both into the same `activeCall` slot since either represents
// the same "there is a call happening here" state.
// ---------------------------------------------------------------------------

export function applyCallIncoming(
  prev: ConversationWithRefs,
  payload: {
    callId: string;
    externalCallId: string;
    ringingAt: string;
  },
): ConversationWithRefs {
  if (prev.activeCall?.callId === payload.callId) return prev;
  const next: ActiveCallState = {
    callId: payload.callId,
    externalCallId: payload.externalCallId,
    direction: "in",
    status: "ringing",
    startedAt: payload.ringingAt,
    answeredAt: null,
  };
  return { ...prev, activeCall: next };
}

export function applyCallRinging(
  prev: ConversationWithRefs,
  payload: { callId: string },
): ConversationWithRefs {
  if (prev.activeCall?.callId === payload.callId) return prev;
  const next: ActiveCallState = {
    callId: payload.callId,
    externalCallId: payload.callId,
    direction: "out",
    status: "ringing",
    startedAt: new Date().toISOString(),
    answeredAt: null,
  };
  return { ...prev, activeCall: next };
}

export function applyCallAnswered(
  prev: ConversationWithRefs,
  payload: { callId: string; answeredAt: string },
): ConversationWithRefs {
  if (!prev.activeCall || prev.activeCall.callId !== payload.callId) return prev;
  if (prev.activeCall.status === "in_progress") return prev;
  return {
    ...prev,
    activeCall: {
      ...prev.activeCall,
      status: "in_progress",
      answeredAt: payload.answeredAt,
    },
  };
}

export function applyCallEnded(
  prev: ConversationWithRefs,
  payload: {
    callId: string;
    durationSeconds: number | null;
    endedAt: string;
    status: "completed" | "missed" | "rejected" | "failed";
  },
): ConversationWithRefs {
  const wasActive = prev.activeCall?.callId === payload.callId;
  // Append/update in the history slice so the bubble appears in the
  // timeline immediately. Idempotent — same callId replaces existing.
  const history: CallSnapshot[] = prev.calls ?? [];
  const existingIdx = history.findIndex((c) => c.id === payload.callId);
  let nextHistory: CallSnapshot[];
  if (existingIdx >= 0) {
    const existing = history[existingIdx]!;
    nextHistory = history.slice();
    nextHistory[existingIdx] = {
      ...existing,
      status: payload.status,
      endedAt: payload.endedAt,
      durationSeconds: payload.durationSeconds,
    };
  } else if (wasActive && prev.activeCall) {
    nextHistory = history.slice();
    nextHistory.push({
      id: prev.activeCall.callId,
      conversationId: prev.conversation.id,
      externalCallId: prev.activeCall.externalCallId,
      channel: prev.conversation.channel ?? "whatsapp",
      direction: prev.activeCall.direction,
      status: payload.status,
      answeredByUserId: null,
      ringingAt: prev.activeCall.startedAt,
      answeredAt: prev.activeCall.answeredAt,
      endedAt: payload.endedAt,
      durationSeconds: payload.durationSeconds,
    });
  } else {
    // Terminal frame for a call we never saw an active state for (page
    // load mid-call, late frame, etc.). Skip — the next full thread fetch
    // will surface it.
    nextHistory = history;
  }
  return {
    ...prev,
    activeCall: wasActive ? null : prev.activeCall ?? null,
    calls: nextHistory,
  };
}

// ---------------------------------------------------------------------------
// Iterated wiring contract
//
// Both consumers (use-conversation-events and inbox-shell) loop over this
// array. Adding a (event, apply) pair here auto-wires both sites — no
// manual `socket.on`/`socket.off`/`patchData` call edits required.
//
// Payload typing is inferred from `ServerToClientEvents[E]` via the
// `reducerEntry` helper, so a reducer signature mismatch is a compile error.
// ---------------------------------------------------------------------------

/**
 * Targeting mode:
 *   - "conversation" (default): payload.conversationId narrows to one thread.
 *   - "all": payload has no conversationId; iterate every cached thread and
 *     let the reducer's internal bail decide if it applies. Used for
 *     `contact:updated`, where a single event can affect multiple threads
 *     (one contact, N conversations) and the cache walker can't pre-filter.
 */
export type ThreadReducerTarget = "conversation" | "all";

export type ThreadReducerEntry<E extends keyof ServerToClientEvents> = {
  readonly event: E;
  readonly apply: (
    prev: ConversationWithRefs,
    payload: Parameters<ServerToClientEvents[E]>[0],
  ) => ConversationWithRefs;
  readonly target?: ThreadReducerTarget;
};

function reducerEntry<E extends keyof ServerToClientEvents>(
  entry: ThreadReducerEntry<E>,
): ThreadReducerEntry<E> {
  return entry;
}

export const THREAD_REDUCER_EVENTS = [
  reducerEntry({ event: "conversation:status", apply: applyConversationStatus }),
  reducerEntry({ event: "conversation:assigned", apply: applyConversationAssignment }),
  reducerEntry({ event: "conversation:read", apply: applyConversationRead }),
  reducerEntry({ event: "message:status", apply: applyMessageStatus }),
  reducerEntry({ event: "message:media:ready", apply: applyMessageMediaReady }),
  reducerEntry({ event: "note:deleted", apply: applyNoteDeleted }),
  reducerEntry({
    event: "contact:updated",
    apply: applyContactUpdate,
    target: "all",
  }),
  reducerEntry({ event: "call:incoming", apply: applyCallIncoming }),
  reducerEntry({ event: "call:ringing", apply: applyCallRinging }),
  reducerEntry({ event: "call:answered", apply: applyCallAnswered }),
  reducerEntry({ event: "call:ended", apply: applyCallEnded }),
] as const;

/**
 * Events that the LIVE-hook consumer (`useConversationEvents`) RAF-coalesces
 * instead of directly applying through the iterated `THREAD_REDUCER_EVENTS`
 * loop. The reducer itself is still shared — the cached-shell consumer
 * (`inbox-shell.tsx`) iterates the full array and applies these like any
 * other event because Map mutations don't need React batching.
 *
 * Why this list exists (and not just a magic string filter in the hook):
 * declare the exception structurally in one place. Adding a new coalesced
 * event = drop a string here, write the reducer, add to THREAD_REDUCER_EVENTS,
 * and bind a manual RAF-coalesced handler in the live hook. Forgetting any
 * step is a code-search away rather than a stale-cache bug six months later.
 *
 * Today only `message:status` is here — sent/delivered/read transitions
 * cascade in 100-500ms bursts and a React re-render per arrival pinned the
 * inbox CPU at 100% during multi-recipient broadcasts.
 */
export const COALESCED_LIVE_HOOK_EVENTS: ReadonlySet<keyof ServerToClientEvents> =
  new Set(["message:status"]);

/**
 * Per-thread-mutating events that DELIBERATELY skip THREAD_REDUCER_EVENTS.
 * Each entry must have a code reason; when you add a new socket event that
 * mutates per-thread state, either:
 *   (a) add it to THREAD_REDUCER_EVENTS (auto-wires live hook + cached shell), OR
 *   (b) add it here with the load-bearing reason.
 *
 * Choice (a) is correct for almost every new event. Choice (b) is for the
 * narrow set of events that need custom handling (list mutation, optimistic
 * reconcile, navigation side-effect, local-only optimistic frame, etc.).
 *
 * The dev-only invariant in `assertReducerCoverage()` below catches any
 * subscribed event that's neither in the table NOR in this exclusion list,
 * surfacing the missed-wiring class CLAUDE.md warns about.
 *
 * Keys are strings (not `keyof ServerToClientEvents`) so the list can
 * include built-in Socket.io lifecycle events like `connect` alongside
 * domain events.
 */
export const REDUCER_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  // List-mutating: live hook dedupes by externalId + reconciles optimistic;
  // cached shell evicts the affected thread's snapshot.
  ["message:new", "list mutation"],
  ["note:new", "list mutation"],
  // Optimistic-only: marks the optimistic row failed in the live hook; cached
  // shell evicts (the pending bubble isn't persisted on the server).
  ["message:failed", "optimistic-row mutation"],
  // Coalesced fanout: payload only carries ids, not contact bodies — shell
  // evicts affected snapshots, list refetches the page on next interaction.
  ["contacts:bulk_updated", "coalesced bulk fanout"],
  // Navigation side-effect, not a per-field patch — the thread is gone.
  ["conversation:deleted", "navigation side-effect"],
  // Client-only optimistic frame; server never emits this. See
  // [[project_optimistic_activity_pills]].
  ["conversation:activity", "client-only optimistic frame"],
  // Socket lifecycle — not a per-thread payload.
  ["connect", "socket lifecycle"],
  // Signaling-only — flow directly into useCall (RTCPeerConnection lifecycle),
  // not into the thread snapshot. The browser hangs them off the peer
  // connection, not the rendered state.
  ["call:sdp_offer", "WebRTC signaling, owned by useCall"],
]);

/**
 * Dev-only invariant: every event the live hook or shell subscribes to must
 * be either in `THREAD_REDUCER_EVENTS` (auto-wired) or `REDUCER_EXCLUSIONS`
 * (explicit). Call once at hook mount; throws a descriptive error in dev to
 * surface a missed wiring before it ships as a stale-state bug. No-op in
 * production (cost-conscious + we don't want a guard-throw in front of a
 * paying customer).
 *
 * Pass the list of events you ARE subscribing to — the function asserts
 * each one is accounted for.
 */
export function assertReducerCoverage(
  subscribedEvents: ReadonlyArray<string>,
): void {
  if (process.env.NODE_ENV === "production") return;
  const known = new Set<string>([
    ...THREAD_REDUCER_EVENTS.map((e) => e.event as string),
    ...REDUCER_EXCLUSIONS.keys(),
  ]);
  const orphans = subscribedEvents.filter((e) => !known.has(e));
  if (orphans.length === 0) return;
  // Fail loudly in dev: an event was subscribed without being declared in
  // either contract surface, which means the cached shell won't see it →
  // chat-switch-back will show stale state. Either add it to
  // THREAD_REDUCER_EVENTS or REDUCER_EXCLUSIONS with a reason.
  throw new Error(
    `[thread-reducers] socket event(s) subscribed without coverage: ${orphans.join(
      ", ",
    )}. Add to THREAD_REDUCER_EVENTS (auto-wires both consumers) or to REDUCER_EXCLUSIONS with a reason. See thread-reducers.ts header.`,
  );
}
