/**
 * Typed event contracts for the Socket.io transport.
 *
 * Server and client both import this — keeping a single source of truth
 * means a renamed event surface is a build error, not a silent dropped
 * message.
 *
 * Naming convention: `<noun>:<verb>` so events sort sensibly in logs.
 */

import type {
  ConversationStatus,
  InternalNote,
  Message,
  MessageStatus,
  User,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Server → Client events.
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  /** A new message arrived on a conversation (inbound or outbound). */
  "message:new": (payload: {
    teamId: string;
    conversationId: string;
    message: Message;
    preview: string;
    lastMessageAt: string;
    unreadDelta: number;
  }) => void;

  /** A message's delivery status changed (sent → delivered → read, or failed). */
  "message:status": (payload: {
    teamId: string;
    conversationId: string;
    messageId: string;
    status: MessageStatus;
  }) => void;

  /** A teammate added an internal note. */
  "note:new": (payload: {
    teamId: string;
    conversationId: string;
    note: InternalNote;
  }) => void;

  /** Assignment was changed (or cleared). */
  "conversation:assigned": (payload: {
    teamId: string;
    conversationId: string;
    assignedUser: User | null;
  }) => void;

  /** Conversation status changed (open / pending / closed). */
  "conversation:status": (payload: {
    teamId: string;
    conversationId: string;
    status: ConversationStatus;
  }) => void;
}

// ---------------------------------------------------------------------------
// Client → Server events.
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  /** Join the team room — receives every team-wide update for the inbox list. */
  "subscribe:team": (payload: { teamId: string }) => void;

  /** Join a conversation room — receives message/note updates for that thread. */
  "subscribe:conversation": (payload: { conversationId: string }) => void;
  "unsubscribe:conversation": (payload: { conversationId: string }) => void;
}

// Inter-server events left empty until we add a Redis adapter (deferred per CLAUDE.md).
export type InterServerEvents = Record<string, never>;

export interface SocketData {
  // Phase 2 will populate this from the NextAuth session on connection.
  teamId?: string;
  userId?: string;
}

/** Path Socket.io binds to. Kept here so client and server cannot drift. */
export const SOCKET_PATH = "/api/socket";
