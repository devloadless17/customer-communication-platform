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
  ConversationWithRefs,
  InternalNote,
  Message,
  MessageStatus,
  User,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Server → Client events.
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  /**
   * A new message arrived on a conversation (inbound or outbound).
   *
   * `newConversation` is populated only when the message opened a brand-new
   * thread (first contact, or first inbound after a closed thread). Clients
   * that don't yet have the conversation in their list use it to splice the
   * row in without a refetch.
   */
  "message:new": (payload: {
    teamId: string;
    conversationId: string;
    message: Message;
    preview: string;
    lastMessageAt: string;
    unreadDelta: number;
    newConversation?: ConversationWithRefs;
    /**
     * Echoed from the originating client so it can swap its optimistic bubble
     * for this real one without flicker. Absent for inbound messages.
     */
    clientTempId?: string;
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

  /** A teammate deleted an internal note — splice it out of the thread. */
  "note:deleted": (payload: {
    teamId: string;
    conversationId: string;
    noteId: string;
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

  /**
   * Conversation was hard-deleted by an agent. Every client splices it out
   * of its list; an open detail view should bounce back to /inbox.
   */
  "conversation:deleted": (payload: {
    teamId: string;
    conversationId: string;
  }) => void;

  /**
   * Contact was hard-deleted. All its conversations went with it via FK
   * cascade — fire one event per affected conversation so existing
   * conversation:deleted listeners drop them. Plus this one for the
   * contacts page itself.
   */
  "contact:deleted": (payload: {
    teamId: string;
    contactId: string;
  }) => void;

  /**
   * Conversation was read — team-wide unread counter resets to 0. Fires when
   * a teammate opens the thread or explicitly marks it read. CLAUDE.md flags
   * per-agent unread as deferred, so this is shared across the team.
   */
  "conversation:read": (payload: {
    teamId: string;
    conversationId: string;
    readByUserId: string;
  }) => void;

  /**
   * Snapshot of which teammates currently have a live socket. Broadcast to
   * the team room whenever the set changes; also sent to a single socket on
   * subscribe so it doesn't have to wait for the next change to populate.
   */
  "presence:update": (payload: {
    teamId: string;
    onlineUserIds: string[];
  }) => void;

  /**
   * Snapshot of who's currently typing in a specific conversation. The
   * server broadcasts this to the conversation room on every change; clients
   * filter their own userId out of the list when rendering.
   */
  "typing:update": (payload: {
    conversationId: string;
    typingUserIds: string[];
  }) => void;

  /**
   * Broadcast lifecycle: `queued` → `running` → `completed` | `failed`. Fired
   * by the broadcast runner so the detail page can update without polling
   * (polling is still in place as a fallback for clients off the socket).
   */
  "broadcast:status": (payload: {
    teamId: string;
    broadcastId: string;
    status: "queued" | "running" | "completed" | "failed";
    error?: string;
  }) => void;

  /**
   * Per-send progress tick. Fired once per recipient send (success or fail)
   * so the detail page can advance the progress bar in real time.
   */
  "broadcast:progress": (payload: {
    teamId: string;
    broadcastId: string;
    sentCount: number;
    failedCount: number;
    totalCount: number;
  }) => void;
}

// ---------------------------------------------------------------------------
// Client → Server events.
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  /**
   * Join the team room — receives every team-wide update for the inbox list.
   *
   * The server validates `teamId` against the authenticated handshake; a
   * mismatched id is silently dropped. Identity itself comes from the JWT
   * cookie at handshake time, not from any client payload.
   */
  "subscribe:team": (payload: { teamId: string }) => void;

  /** Join a conversation room — receives message/note updates for that thread. */
  "subscribe:conversation": (payload: { conversationId: string }) => void;
  "unsubscribe:conversation": (payload: { conversationId: string }) => void;

  /** Agent started typing in a conversation. Server fans out to that room. */
  "typing:start": (payload: { conversationId: string }) => void;
  /** Agent stopped typing — explicit, e.g. on send or on blur. */
  "typing:stop": (payload: { conversationId: string }) => void;
}

// Inter-server events left empty until we add a Redis adapter (deferred per CLAUDE.md).
export type InterServerEvents = Record<string, never>;

export interface SocketData {
  // Set during the handshake auth middleware, non-null afterwards.
  teamId?: string;
  userId?: string;
  role?: import("@/lib/types").Role;
  /** Conversations this socket is currently flagged as typing in. */
  typingIn?: Set<string>;
}

/** Path Socket.io binds to. Kept here so client and server cannot drift. */
export const SOCKET_PATH = "/api/socket";
