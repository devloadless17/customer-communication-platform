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
  Contact,
  ConversationStatus,
  ConversationWithRefs,
  InternalNote,
  MediaAttachment,
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

  /**
   * Inbound media finished downloading (or failed). Fired after `message:new`
   * (which carries `mediaPending: true`) when the webhook's background
   * download + blob upload completes.
   *   - `media` present → bubble swaps in the real media block.
   *   - `media` absent → download failed or hit the size cap; bubble drops
   *     the placeholder and renders as a text-only bubble (caption preserved).
   */
  "message:media:ready": (payload: {
    teamId: string;
    conversationId: string;
    messageId: string;
    media?: MediaAttachment;
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
   * Editable contact data changed (name, email, location, customFields,
   * stage, or tags). Payload carries the full updated Contact so consumers
   * can splice it in without a refetch.
   *
   * Fanned out from /api/contacts/:id (PATCH) and /api/contacts/:id/tags
   * (PATCH). Used by:
   *   - use-team-events: updates the contact embedded in each matching
   *     ConversationWithRefs in the sidebar (stage filter / stage counts
   *     re-evaluate, conversation-list-item name + avatar refresh).
   *   - use-conversation-events: updates `data.contact` so the message
   *     thread's stage stepper, contact name in the header, etc. follow.
   *   - ContactPanel: re-seeds its local mirror fields so two agents
   *     editing the same contact stay in sync without a hard refresh.
   *
   * Phone number can never change on an existing contact (it's the
   * WhatsApp identity used for inbound dedupe), so it's stable across
   * every emit.
   */
  "contact:updated": (payload: {
    teamId: string;
    contact: Contact;
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
   * New audit row on a conversation (assign / status_changed for now —
   * tag_added / tag_removed values exist in the enum but no writer fires
   * them since tags moved back onto Contact). Lets a live history-panel
   * viewer prepend the entry without a refetch.
   */
  "conversation:event": (payload: {
    teamId: string;
    conversationId: string;
    event: {
      id: string;
      kind: "assigned" | "status_changed" | "tag_added" | "tag_removed";
      userId: string | null;
      userName: string | null;
      before: unknown;
      after: unknown;
      at: string;
    };
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

  /**
   * A team-scoped catalog row was created, updated, deleted, or reordered.
   * Catalogs are the lookup tables the inbox reads at render time —
   * contact stages, tags, custom field definitions, automations, and team
   * members. None of these are large enough or change frequently enough
   * to warrant a per-row diff event; instead the server tells every client
   * "the X catalog moved" and the client calls `router.refresh()` to
   * re-run the affected server components.
   *
   * Why a single event instead of one per catalog:
   *   - The client handler is identical (router.refresh) for every scope.
   *   - Bundling them keeps both server emit-sites and the client listener
   *     one-liners — there's no per-scope state on the client to merge,
   *     so a discriminator field is enough.
   *   - The `scope` field stays useful for telemetry / future
   *     optimisations (e.g. skip refresh if the user isn't on a route
   *     that consumes that catalog).
   */
  "team:catalog:changed": (payload: {
    teamId: string;
    scope:
      | "stages"
      | "tags"
      | "contact-fields"
      | "automations"
      | "members"
      // Reply-composer snippets. Previously relied on `revalidateTag` alone,
      // which only re-validates the data cache on the next render — other
      // open tabs never see the new/edited/deleted snippet until they
      // navigate. The actor's own tab also waited for a click, since
      // revalidateTag doesn't push to the browser.
      | "snippets"
      // Broadcast audience groups (lists of saved contact filters). Used
      // by /broadcasts/new and the groups list under /broadcasts/groups.
      | "audience-groups"
      // Meta-managed WhatsApp message templates. The catalog is mirrored
      // into our DB and shown in the template-send picker + the manage UI.
      | "whatsapp-templates"
      // Pending team invites (un-accepted, un-expired). Fires on create,
      // revoke, and accept so admin tabs viewing /settings/team see the
      // "Pending invites" panel update without a manual refresh.
      | "invites";
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
