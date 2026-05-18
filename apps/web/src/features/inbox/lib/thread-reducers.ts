import type {
  ConversationStatus,
  ConversationWithRefs,
  MediaAttachment,
  MessageStatus,
  User,
} from "@ccp/shared/types";

/**
 * Pure reducers: apply a socket event to a per-thread snapshot and return
 * a new snapshot, or the same reference when nothing changed (callers
 * short-circuit on identity).
 *
 * Single source of truth for:
 *   - `useConversationEvents` (live state of the displayed thread)
 *   - `inbox-shell.tsx` (ThreadCache snapshot for chat-switch round-trips)
 *
 * Adding a new socket event that mutates a per-thread field: add one
 * reducer here and call it from both consumers. Don't duplicate the
 * reducer in either site.
 *
 * ---------------------------------------------------------------------------
 * Per-event wiring matrix — keep BOTH sites in sync when adding events
 * ---------------------------------------------------------------------------
 *
 *  Socket event              | Reducer here                  | Live hook       | Cached shell
 *  --------------------------|-------------------------------|-----------------|-------------------
 *  conversation:status       | applyConversationStatus       | use-conv...:on  | inbox-shell:on
 *  conversation:assigned     | applyConversationAssignment   | use-conv...:on  | inbox-shell:on
 *  conversation:read         | applyConversationRead         | use-conv...:on  | inbox-shell:on
 *  message:status            | applyMessageStatus            | use-conv...:on  | inbox-shell:on
 *  message:media:ready       | applyMessageMediaReady        | use-conv...:on  | inbox-shell:on
 *  note:deleted              | applyNoteDeleted              | use-conv...:on  | inbox-shell:on
 *
 *  message:new / note:new    | (no reducer — full append /   | use-conv...:on  | inbox-shell:
 *                            |  pull via dataRef)            |                 |  evictIfBackground
 *  contact:updated           | (no reducer — full swap)      | contact-panel +  | inbox-shell:
 *                            |                                | use-conv...     |   onContactUpdated
 *  contacts:bulk_updated     | (no reducer — refetch / evict)| contacts-client | inbox-shell
 *                            |                                |                 |  bulk-evict
 *
 * If you add a per-thread field-mutating socket event and skip this matrix,
 * a chat-switch + back will revert the field to the stale cached value.
 * See `inbox-shell.tsx` for the cached-side pattern; `useConversationEvents`
 * for the live-side pattern.
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

export function applyConversationRead(
  prev: ConversationWithRefs,
  // Reserved for future payload growth (e.g. per-user read receipts). All
  // callers pass it explicitly so the contract stays consistent across
  // sibling reducers; the implementation today only needs the prev state.
  _payload?: { conversationId: string; readByUserId: string; teamId: string },
): ConversationWithRefs {
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
