import type {
  ConversationStatus,
  ConversationWithRefs,
  MediaAttachment,
  MessageStatus,
  User,
} from "@/lib/types";

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

export function applyConversationRead(prev: ConversationWithRefs): ConversationWithRefs {
  if (prev.conversation.unreadCount === 0) return prev;
  return {
    ...prev,
    conversation: { ...prev.conversation, unreadCount: 0 },
  };
}

export function applyMessageStatus(
  prev: ConversationWithRefs,
  payload: { messageId: string; status: MessageStatus },
): ConversationWithRefs {
  let changed = false;
  const nextMessages = prev.messages.map((m) => {
    if (m.id !== payload.messageId || m.status === payload.status) return m;
    changed = true;
    return { ...m, status: payload.status };
  });
  if (!changed) return prev;
  return { ...prev, messages: nextMessages };
}

export function applyMessageMediaReady(
  prev: ConversationWithRefs,
  payload: { messageId: string; media?: MediaAttachment },
): ConversationWithRefs {
  let changed = false;
  const nextMessages = prev.messages.map((m) => {
    if (m.id !== payload.messageId) return m;
    changed = true;
    if (payload.media) {
      return { ...m, media: payload.media, mediaPending: false };
    }
    // Download failed / dropped — strip media block, keep row as text.
    const { media: _media, mediaPending: _p, ...rest } = m;
    return rest;
  });
  if (!changed) return prev;
  return { ...prev, messages: nextMessages };
}

export function applyNoteDeleted(
  prev: ConversationWithRefs,
  payload: { noteId: string },
): ConversationWithRefs {
  const next = prev.notes.filter((n) => n.id !== payload.noteId);
  if (next.length === prev.notes.length) return prev;
  return {
    ...prev,
    notes: next,
    ...(prev.noteCount !== undefined
      ? { noteCount: Math.max(0, prev.noteCount - 1) }
      : {}),
  };
}
