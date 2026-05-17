/**
 * Domain event taxonomy — the spine of the platform.
 *
 * Every state mutation in the app publishes exactly one `DomainEvent` through
 * `lib/events/bus.ts`. Subscribers (socket fanout, audit log, analytics,
 * workflow dispatch, outbound webhooks) react to those events. Routes never
 * call `emitToTeam` / `dispatch()` / `trackOn*` / `recordConversationEvent`
 * directly — they publish a fact, and the subscribers do the fan-out.
 *
 * Adding a new event:
 *   1. Add a key + payload interface to `DomainEventMap`.
 *   2. Wire any subscribers that should react (see lib/events/subscribers/).
 *   3. Publish from the place the fact actually happens.
 *
 * This module is intentionally framework-agnostic — same types are reused
 * by Phase 1's NestJS service via the Redis pub/sub bridge.
 */

import type {
  Contact,
  ConversationStatus,
  ConversationWithRefs,
  InternalNote,
  MediaAttachment,
  MessageStatus,
  ProviderName,
  User,
} from "../types";
import type { TeamChannelMessageDto } from "../socket/events";
import type {
  WorkflowContactSnapshot,
  WorkflowConversationSnapshot,
  WorkflowMessageSnapshot,
} from "../workflows/events";

// ---------------------------------------------------------------------------
// Per-event payloads. Each is a fact about a state mutation that just
// happened. Payloads carry enough data for every subscriber to react without
// hitting the DB again — except where subscribers need post-side-effect
// state (e.g. workflow dispatch needing analytics-updated conversation
// counters), in which case the subscriber re-reads.
// ---------------------------------------------------------------------------

export interface MessageReceivedEvent {
  teamId: string;
  conversationId: string;
  /** Full domain message used by the socket fanout's `message:new` payload. */
  message: import("../types").Message;
  /** Snapshots for the workflow dispatcher. */
  contact: WorkflowContactSnapshot;
  conversation: WorkflowConversationSnapshot;
  workflowMessage: WorkflowMessageSnapshot;
  /** True when this inbound opened a brand-new conversation. */
  isNewConversation: boolean;
  /** True when this inbound reopened a previously-closed conversation. */
  reopened: boolean;
  /** Pre-built socket payload for new-conversation splice (live splice without refetch). */
  newConversation?: ConversationWithRefs;
  preview: string;
  lastMessageAt: string;
  unreadDelta: number;
  /** Recent thread context handed to workflow `message_received` trigger. */
  recentMessages: WorkflowMessageSnapshot[];
}

export interface MessageSentEvent {
  teamId: string;
  conversationId: string;
  message: import("../types").Message;
  preview: string;
  lastMessageAt: string;
  /** Always 0 — outbound messages never bump unread. Kept for socket parity. */
  unreadDelta: 0;
  /** Echoed so the originating client can swap its optimistic bubble. */
  clientTempId?: string;
  /** null for system/automation sends (workflow steps); user id for agent sends. */
  senderUserId: string | null;
  /**
   * Set only when this outbound send opened a brand-new conversation (e.g.
   * forward to a contact that's never been messaged). Carries the full
   * ConversationWithRefs so inbox lists can splice the row in without a
   * refetch — same shape used by the inbound-message path on first contact.
   */
  newConversation?: ConversationWithRefs;
}

export interface MessageStatusChangedEvent {
  teamId: string;
  conversationId: string;
  messageId: string;
  status: MessageStatus;
}

export interface ConversationAssignedEvent {
  teamId: string;
  conversationId: string;
  /** Hydrated assignedUser for socket payload. null = unassigned. */
  assignedUser: User | null;
  previousAssignedUserId: string | null;
  newAssignedUserId: string | null;
  /** null when triggered by the external API (no acting session). */
  changedByUserId: string | null;
  /** Contact attached to the conversation, for workflow snapshot. */
  contact: WorkflowContactSnapshot;
  /**
   * When true, workflow-dispatch subscribers SKIP this event. Set by
   * workflow step handlers so a step that runs inside workflow X doesn't
   * cascade into workflow Y mid-run (loop avoidance). Socket fanout,
   * audit, and analytics still run normally — those are user-visible
   * effects, not chain-trigger semantics. See lib/workflows/steps/*.
   */
  silent?: boolean;
}

export interface ConversationStatusChangedEvent {
  teamId: string;
  conversationId: string;
  previousStatus: ConversationStatus;
  newStatus: ConversationStatus;
  /** null when status changed by the system (e.g. reopen on inbound). */
  changedByUserId: string | null;
  contact: WorkflowContactSnapshot;
  /**
   * Step-driven closures (workflow `close_conversation` config) can carry
   * a structured close category + free-text summary. The analytics
   * subscriber persists these onto the row alongside closedAt/closedByUserId;
   * the workflow `conversation_closed` trigger then sees them populated.
   */
  closedCategory?: string | null;
  closedSummary?: string | null;
  /** Workflow steps set this to skip chain-trigger dispatch. See ConversationAssignedEvent.silent. */
  silent?: boolean;
}

export interface ConversationDeletedEvent {
  teamId: string;
  conversationId: string;
  deletedByUserId: string;
}

export interface ContactUpdatedEvent {
  teamId: string;
  contact: Contact;
  /** Pre-update stage id, for stage-change detection downstream. */
  previousStageId: string | null;
  /** Custom-field diffs since the last commit. */
  fieldChanges: ContactFieldChange[];
  /** Tag membership diffs — fires `contact_tag_updated` workflow trigger per id. */
  tagChanges?: { added: string[]; removed: string[] };
  /** null when triggered by the external API (no acting session). */
  changedByUserId: string | null;
  /** Pre-update WorkflowContactSnapshot used as `previous` if downstream wants it. */
  workflowContact: WorkflowContactSnapshot;
  /** Workflow steps set this to skip chain-trigger dispatch. See ConversationAssignedEvent.silent. */
  silent?: boolean;
}

export interface ContactFieldChange {
  key: string;
  previous: string | null;
  next: string | null;
}

export interface ContactDeletedEvent {
  teamId: string;
  contactId: string;
  /** Cascaded conversation ids — fanout emits `conversation:deleted` for each. */
  conversationIds: string[];
  deletedByUserId: string;
}

export interface NoteCreatedEvent {
  teamId: string;
  conversationId: string;
  note: InternalNote;
}

export interface NoteDeletedEvent {
  teamId: string;
  conversationId: string;
  noteId: string;
}

/**
 * Inbound media's phase-2 background download landed (or failed).
 *
 *   - `media` present → the message bubble swaps in the real media block.
 *   - `media` absent  → download failed / hit cap. The placeholder is
 *                       cleared and the bubble renders as text-only.
 *
 * Emitted by the webhook media fetcher AND by the inbound-media sweeper
 * (which fires the "absent media" form when clearing restart-orphan rows).
 */
export interface MessageMediaReadyEvent {
  teamId: string;
  conversationId: string;
  messageId: string;
  media?: MediaAttachment;
}

/**
 * Broadcast lifecycle: queued → running → completed | failed.
 * Emitted by the broadcast runner at each phase transition.
 */
export interface BroadcastStatusChangedEvent {
  teamId: string;
  broadcastId: string;
  status: "queued" | "running" | "completed" | "failed";
  error?: string;
}

/**
 * Per-recipient progress tick. Fired once per send (success or failure) so
 * the detail page can advance the progress bar without polling.
 */
export interface BroadcastProgressEvent {
  teamId: string;
  broadcastId: string;
  sentCount: number;
  failedCount: number;
  totalCount: number;
}

/**
 * One template message landed in a recipient's conversation as part of a
 * broadcast. Carries the same fields the `message:new` socket emit needs.
 *
 * Why this is a distinct event (not `message.sent`):
 *
 *   The analytics subscriber bumps outgoing-message counters on
 *   `message.sent` and the audit subscriber writes a timeline row — both
 *   are correct for agent-typed replies but explicitly NOT for broadcasts
 *   (broadcasts have their own analytics surface; a 1k-recipient send must
 *   not flood the per-conversation audit log). Keeping this on its own
 *   event type means only `socket-fanout` listens and the suppression is
 *   structural, not a runtime flag check.
 *
 * Emitted by the broadcast runner once per successful Meta send.
 */
export interface BroadcastRecipientMessageSentEvent {
  teamId: string;
  broadcastId: string;
  conversationId: string;
  message: import("../types").Message;
  preview: string;
  lastMessageAt: string;
}

/**
 * A previously-closed conversation was reopened (flipped to `pending`)
 * because a broadcast targeted it. Sibling to
 * `BroadcastRecipientMessageSentEvent` — separate from
 * `conversation.status_changed` for the same reason: the audit subscriber
 * would otherwise write a "reopened" timeline row per broadcast recipient.
 */
export interface BroadcastConversationReopenedEvent {
  teamId: string;
  broadcastId: string;
  conversationId: string;
}

/**
 * A new audit row landed in `ConversationEvent`. Carries the hydrated row
 * + author name so live history-panel viewers can prepend without a
 * refetch.
 *
 * Why this is a distinct event (not direct emit): `recordConversationEvent`
 * runs inside the audit bus subscriber, which now lives in the NestJS
 * process. Direct `emitToTeam` from there would target a Next.js-side
 * Socket.io singleton that no longer exists post-Phase-5. Routing through
 * the bus lets the NestJS realtime-fanout subscriber emit to wire.
 */
export interface ConversationEventRecordedEvent {
  teamId: string;
  conversationId: string;
  event: {
    id: string;
    kind: import("@prisma/client").ConversationEventKind;
    userId: string | null;
    userName: string | null;
    before: import("@prisma/client").Prisma.JsonValue;
    after: import("@prisma/client").Prisma.JsonValue;
    at: string;
  };
}

/**
 * Conversation read receipt — a teammate opened the thread (or hit "mark
 * read"). Broadcasts to the team room so other open tabs of the same agent
 * can clear their unread badges in lock-step.
 *
 * Per CLAUDE.md, per-agent unread is deferred; the team-wide unreadCount=0
 * reset happens elsewhere. This event is the cross-tab nudge only.
 */
export interface ConversationReadEvent {
  teamId: string;
  conversationId: string;
  readByUserId: string;
}

// ---------------------------------------------------------------------------
// Team chat (internal channels). Separate event family from the customer-
// facing conversation events — different DB tables, different rooms, but the
// same bus mechanics. Channel-thread-room emits are bundled into the same
// event payloads via threadRootId.
// ---------------------------------------------------------------------------

/**
 * Top-level message OR thread reply landed in a channel. Discriminated by
 * `threadRootId`:
 *   - null → top-level. Socket fanout emits `team:channel:message` to the
 *            team room with preview + lastMessageAt populated.
 *   - set  → reply. Socket fanout emits:
 *            (a) `team:channel:message` to team room (preview/lastMessageAt
 *                null — the channel feed doesn't surface replies),
 *            (b) `team:channel:thread:reply` to team room with replyCount,
 *            (c) `team:channel:message` to the channel-thread room so any
 *                open side panel gets the new reply.
 *
 * `threadReplyCount` is only meaningful when threadRootId is set — it's the
 * post-increment count carried so the team-room `team:channel:thread:reply`
 * payload can include it. Top-level emits leave it at 0.
 */
export interface TeamChannelMessageCreatedEvent {
  teamId: string;
  channelId: string;
  message: TeamChannelMessageDto;
  /** Truncated body/media preview. Null for thread replies. */
  preview: string | null;
  /** Channel.lastMessageAt at the moment of post. Null for thread replies. */
  lastMessageAt: string | null;
  /** Post-increment replyCount on the root. Only used when threadRootId is set. */
  threadReplyCount: number;
  /** Echoed for optimistic-swap on the originating client. */
  clientTempId?: string;
}

export interface TeamChannelMessageEditedEvent {
  teamId: string;
  channelId: string;
  messageId: string;
  body: string;
  editedAt: string;
}

export interface TeamChannelMessageDeletedEvent {
  teamId: string;
  channelId: string;
  messageId: string;
  /** When the deleted message was a reply, the root's id. Null for top-level. */
  threadRootId: string | null;
}

export interface TeamChannelReactionChangedEvent {
  teamId: string;
  channelId: string;
  messageId: string;
  emoji: string;
  /** Full set of user ids reacting with `emoji` on this message AFTER the change. */
  userIds: string[];
}

export interface TeamChannelPinChangedEvent {
  teamId: string;
  channelId: string;
  messageId: string;
  pinned: boolean;
}

export interface TeamChannelReadEvent {
  teamId: string;
  channelId: string;
  readByUserId: string;
  lastReadAt: string;
}

/**
 * A team-scoped catalog row was created / updated / deleted / reordered.
 *
 * Two subscribers ride on this during the NestJS migration:
 *   - `socket-fanout` (in NestJS post-Phase 2) emits the `team:catalog:changed`
 *     socket event so connected browsers call `router.refresh()`.
 *   - `cache-revalidate` (in Next.js always) calls `revalidateTag(...)` so the
 *     next RSC render reads fresh data instead of the in-memory unstable_cache.
 *
 * Routes (Next.js OR NestJS) publish this fact and let both subscribers fan
 * out. The transitional bus bridge keeps both sides in sync — if NestJS
 * publishes it, the Next.js subscriber still fires via Redis pub/sub.
 */
export interface TeamCatalogChangedEvent {
  teamId: string;
  scope:
    | "stages"
    | "tags"
    | "contact-fields"
    | "workflows"
    | "members"
    | "snippets"
    | "audience-groups"
    | "whatsapp-templates"
    | "invites"
    | "team-channels";
}

// ---------------------------------------------------------------------------
// Event map — discriminated union by `type`. Use `DomainEventOf<K>` to grab
// the strongly-typed envelope for a single type.
// ---------------------------------------------------------------------------

export interface DomainEventMap {
  "message.received": MessageReceivedEvent;
  "message.sent": MessageSentEvent;
  "message.status_changed": MessageStatusChangedEvent;
  "message.media_ready": MessageMediaReadyEvent;
  "conversation.assigned": ConversationAssignedEvent;
  "conversation.status_changed": ConversationStatusChangedEvent;
  "conversation.deleted": ConversationDeletedEvent;
  "conversation.read": ConversationReadEvent;
  "contact.updated": ContactUpdatedEvent;
  "contact.deleted": ContactDeletedEvent;
  "note.created": NoteCreatedEvent;
  "note.deleted": NoteDeletedEvent;
  "broadcast.status_changed": BroadcastStatusChangedEvent;
  "broadcast.progress": BroadcastProgressEvent;
  "broadcast.recipient_message_sent": BroadcastRecipientMessageSentEvent;
  "broadcast.conversation_reopened": BroadcastConversationReopenedEvent;
  "conversation.event_recorded": ConversationEventRecordedEvent;
  "team_channel.message_created": TeamChannelMessageCreatedEvent;
  "team_channel.message_edited": TeamChannelMessageEditedEvent;
  "team_channel.message_deleted": TeamChannelMessageDeletedEvent;
  "team_channel.reaction_changed": TeamChannelReactionChangedEvent;
  "team_channel.pin_changed": TeamChannelPinChangedEvent;
  "team_channel.read": TeamChannelReadEvent;
  "team.catalog_changed": TeamCatalogChangedEvent;
}

export type DomainEventType = keyof DomainEventMap;

export type DomainEventOf<K extends DomainEventType> = { type: K } & DomainEventMap[K];

export type DomainEvent = {
  [K in DomainEventType]: DomainEventOf<K>;
}[DomainEventType];

/**
 * Provider hint — `ProviderName` lives in the Prisma client enum. Surface
 * it here so subscribers can pivot on channel without re-importing Prisma.
 */
export type EventProvider = ProviderName;
