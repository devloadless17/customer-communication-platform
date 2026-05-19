import type {
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
  payload: { conversationId: string; readByUserId: string; teamId: string },
  ctx?: ReducerContext,
): ConversationWithRefs {
  // Team-wide counter always clears — any user marking read zeroes it.
  // Per-agent `unreadForMe` only clears when the READER is me; another
  // teammate reading doesn't affect my "I haven't seen this" state.
  const teamChange = prev.conversation.unreadCount !== 0;
  const myChange =
    ctx?.currentUserId !== undefined &&
    payload.readByUserId === ctx.currentUserId &&
    prev.conversation.unreadForMe === true;
  if (!teamChange && !myChange) return prev;
  return {
    ...prev,
    conversation: {
      ...prev.conversation,
      ...(teamChange ? { unreadCount: 0 } : {}),
      ...(myChange ? { unreadForMe: false } : {}),
    },
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

/**
 * Optional context handed to reducers that need viewer-aware behavior.
 * Today only `applyConversationRead` reads `currentUserId` (to decide
 * whether a `conversation:read` event clears MY per-agent `unreadForMe`,
 * or just the team-wide counter). Reducers that don't need context ignore
 * the parameter entirely.
 */
export type ReducerContext = {
  currentUserId: string;
};

export type ThreadReducerEntry<E extends keyof ServerToClientEvents> = {
  readonly event: E;
  readonly apply: (
    prev: ConversationWithRefs,
    payload: Parameters<ServerToClientEvents[E]>[0],
    ctx?: ReducerContext,
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
