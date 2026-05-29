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
  Channel,
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
  /**
   * Absolute team-wide unread count AFTER the server-side increment.
   * Clients overwrite their local mirror with this value instead of adding
   * a delta, so brief client/server drift (e.g. an earlier event dropped
   * during a socket flap) self-heals on the next event instead of
   * accumulating. The previous `unreadDelta: 1` semantics required the
   * client to start from a correct prior value.
   */
  unreadCount: number;
  /** Recent thread context handed to workflow `message_received` trigger. */
  recentMessages: WorkflowMessageSnapshot[];
  /** Skip downstream reactions (workflows + outbound webhooks). See ConversationAssignedEvent.silent. */
  silent?: boolean;
}

export interface MessageSentEvent {
  teamId: string;
  conversationId: string;
  /** Carried so outbound webhook envelopes can include contact_id without
   *  a DB roundtrip in the framework-agnostic event mapper. */
  contactId: string;
  message: import("../types").Message;
  preview: string;
  lastMessageAt: string;
  /**
   * Absolute team-wide unread count at send time. Outbound sends don't
   * change unread (only inbounds do), so this is the same value the
   * conversation row holds. Carried for socket-payload parity with
   * `message.received` and to let clients overwrite-not-add their mirror.
   */
  unreadCount: number;
  /** Echoed so the originating client can swap its optimistic bubble. */
  clientTempId?: string;
  /** null for system/automation sends (workflow steps); user id for agent sends. */
  senderUserId: string | null;
  /**
   * Set on /v1 external-API sends so the audit timeline can attribute the
   * message to the API key, not a real user. Mutually exclusive with
   * `senderUserId` in practice — a partner integration has no human author.
   */
  senderApiKeyId?: string | null;
  /**
   * Set only when this outbound send opened a brand-new conversation (e.g.
   * forward to a contact that's never been messaged). Carries the full
   * ConversationWithRefs so inbox lists can splice the row in without a
   * refetch — same shape used by the inbound-message path on first contact.
   */
  newConversation?: ConversationWithRefs;
  /** Skip downstream reactions (workflows + outbound webhooks). See ConversationAssignedEvent.silent. */
  silent?: boolean;
}

export interface MessageStatusChangedEvent {
  teamId: string;
  conversationId: string;
  /** Carried so outbound webhook envelopes can include contact_id without
   *  a DB roundtrip in the framework-agnostic event mapper. */
  contactId: string;
  messageId: string;
  status: MessageStatus;
  /** Skip downstream reactions (workflows + outbound webhooks). See ConversationAssignedEvent.silent. */
  silent?: boolean;
}

/**
 * Outbound send failed inside the background `message-sends` queue worker
 * (introduced for S1 — moving Meta sends off the HTTP critical path).
 * Used by socket-fanout to emit `message:failed` to the originating client
 * so the optimistic bubble flips from `pending` to `failed`, mirroring the
 * pre-queue UX where a 4xx HTTP response had the reply-box surface the
 * error inline.
 *
 *   clientTempId — set when the originating POST carried one; the frontend
 *                  reducer keys off this to mark the right optimistic row.
 *                  Absent for system-initiated sends (workflow-step retries
 *                  etc. — not yet in scope, but the field is here so the
 *                  contract doesn't churn when they land).
 *   reason       — short machine code (`outside_24h_window`, `auth_expired`,
 *                  `rate_limited`, `send_failed`) the frontend can map to
 *                  a localized message.
 *   detail       — free-text human description for the toast / tooltip.
 *
 * Note: only socket-fanout subscribes. Audit + analytics + workflow dispatch
 * deliberately stay quiet — a failed send isn't a real outbound message,
 * shouldn't fire firstResponseAt, shouldn't be logged on the conversation
 * timeline (the agent's bubble already shows the failure inline), and
 * shouldn't trigger any `message_sent` workflows.
 */
export interface MessageSendFailedEvent {
  teamId: string;
  conversationId: string;
  /** null on system-initiated sends. */
  senderUserId: string | null;
  clientTempId?: string;
  reason: string;
  detail?: string;
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
  /** Set on /v1 external-API mutations for audit attribution. */
  changedByApiKeyId?: string | null;
  /** Contact attached to the conversation, for workflow snapshot. */
  contact: WorkflowContactSnapshot;
  /**
   * `silent` = "this mutation is internal/cascaded — skip downstream
   * REACTIONS." Two subscribers honor it:
   *   - workflow-dispatch: skips chain-triggering, so a step inside workflow
   *     X can't cascade into workflow Y mid-run (loop avoidance).
   *   - outbound-webhooks: skips delivery, so an API/workflow-driven change
   *     doesn't echo a webhook back to the very system that caused it
   *     (echo-loop avoidance).
   * Socket fanout + audit + analytics ALWAYS run — those are user-visible
   * truth, not reactions. Set by workflow step handlers (always) and by the
   * external /v1 API when the request opts in (`silent: true`). The same
   * `silent` flag on every webhook-able event below carries this meaning.
   * See lib/workflows/steps/* and outbound-webhooks.subscriber.ts.
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
  /** Set on /v1 external-API mutations for audit attribution. */
  changedByApiKeyId?: string | null;
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
  /** Set on /v1 external-API mutations for audit attribution. */
  changedByApiKeyId?: string | null;
  /**
   * Discriminates a brand-new contact from a mutation of an existing row.
   * Lets outbound-webhook subscribers fan out to `contact.created` vs
   * `contact.updated` subscriptions without us needing a second event type.
   * Optional for source-compat; treat absent as `"updated"`.
   */
  kind?: "created" | "updated";
  /** Pre-update WorkflowContactSnapshot used as `previous` if downstream wants it. */
  workflowContact: WorkflowContactSnapshot;
  /** Workflow steps set this to skip chain-trigger dispatch. See ConversationAssignedEvent.silent. */
  silent?: boolean;
  /**
   * Bulk paths set this so the realtime fanout subscriber SKIPS the per-contact
   * socket emit — the bulk-path also publishes one `contact.bulk_updated` that
   * carries the whole id set, and that's what fans out to clients. Workflow +
   * audit subscribers don't read this flag (they want per-contact granularity).
   * Bounds socket-frame volume on a 500-contact bulk-tag from 500×N agents
   * down to 1×N.
   */
  suppressSocketFanout?: boolean;
}

/**
 * Coalesced bulk-update notification for the socket layer. Bulk paths
 * (contacts bulk-tag, future bulk-stage, future bulk-update-field) publish
 * one of these AFTER firing per-contact `contact.updated` events with
 * `suppressSocketFanout: true`. Realtime fanout emits one
 * `contacts:bulk_updated` socket frame; clients invalidate the affected
 * rows in one query instead of receiving N separate patches.
 *
 * Workflow + audit subscribers do NOT subscribe to this — they read per-
 * contact `contact.updated` events for granular trigger dispatch.
 */
export interface ContactBulkUpdatedEvent {
  teamId: string;
  contactIds: string[];
  /** What changed — frontend uses this to decide which caches to invalidate. */
  changeKind: "tags" | "stage" | "fields" | "mixed";
  /** null when triggered by the external API. */
  changedByUserId: string | null;
  /** Set on /v1 external-API mutations for audit attribution. */
  changedByApiKeyId?: string | null;
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
  /** null when triggered by the external API. */
  deletedByUserId: string | null;
  /** Set on /v1 external-API deletes for audit attribution. */
  deletedByApiKeyId?: string | null;
  /** Skip downstream reactions (workflows + outbound webhooks). See ConversationAssignedEvent.silent. */
  silent?: boolean;
}

/**
 * A brand-new contact row landed. Distinct from `contact.updated` so the
 * "On Contact created" webhook trigger has a clean signal — receivers
 * subscribing to "created" don't get every name edit too. Fired BEFORE
 * `message.received` on the inbound first-message path so a "Contact
 * created → Send welcome" n8n flow sees the contact existed first.
 *
 * `source` discriminates HOW the contact landed:
 *   - "inbound" — first WhatsApp message from a new number (webhook ingest)
 *   - "api"     — POST /v1/contacts or /v1/contacts/upsert (n8n / partners)
 *   - "manual"  — agent added via the New Contact dialog in the inbox
 *   - "import"  — CSV/bulk import flow
 */
export interface ContactCreatedEvent {
  teamId: string;
  contact: Contact;
  source: "inbound" | "api" | "manual" | "import";
  /** null when the source is "inbound" (no acting human) or "api". */
  createdByUserId: string | null;
  /** Set on /v1 create paths for audit attribution. */
  createdByApiKeyId?: string | null;
  /** Skip downstream reactions (workflows + outbound webhooks). See ConversationAssignedEvent.silent. */
  silent?: boolean;
}

/**
 * Tag membership on a contact changed (added OR removed, single OR bulk).
 * Distinct from `contact.updated` so n8n flows triggered on "On Contact Tag
 * updated" don't fire for unrelated edits (name, email, custom fields).
 *
 * Bulk paths emit one of these per affected contact AND publish one
 * `contact.bulk_updated` for socket fanout coalescing.
 */
export interface ContactTagChangedEvent {
  teamId: string;
  contactId: string;
  before: { tagIds: string[] };
  after: { tagIds: string[] };
  added: string[];
  removed: string[];
  /** null when triggered by the external API. */
  changedByUserId: string | null;
  /** Set on /v1 mutations for audit attribution. */
  changedByApiKeyId?: string | null;
  /**
   * Skip downstream reactions — see ConversationAssignedEvent.silent.
   * The outbound-webhook subscriber honors it TODAY (no echo back to the
   * partner that just changed the tag via /v1). Workflow-dispatch does not
   * yet subscribe to `contact.tag_changed`, so the workflow side is dormant
   * until that trigger is wired — but the flag is set by the tag step now so
   * that future trigger can't infinite-loop into itself.
   */
  silent?: boolean;
}

/**
 * Contact lifecycle stage changed. We call it "stage" internally; the public
 * event uses "lifecycle" to match respond.io's terminology so n8n users
 * coming over recognize the trigger.
 */
export interface ContactLifecycleChangedEvent {
  teamId: string;
  contactId: string;
  before: { stageId: string | null };
  after: { stageId: string | null };
  /** null when triggered by the external API. */
  changedByUserId: string | null;
  /** Set on /v1 mutations for audit attribution. */
  changedByApiKeyId?: string | null;
  /**
   * Skip downstream reactions — see ConversationAssignedEvent.silent.
   * Honored by the outbound-webhook subscriber TODAY; the workflow side is
   * dormant until a lifecycle-changed trigger is wired (the `update_lifecycle`
   * step sets it now so that future trigger can't loop into itself). Mirrors
   * `ContactTagChangedEvent.silent`.
   */
  silent?: boolean;
}

export interface NoteCreatedEvent {
  teamId: string;
  conversationId: string;
  note: InternalNote;
  /**
   * Set by workflow steps (`add_comment`) so a future workflow trigger on
   * `note_added` doesn't re-fire workflows on system-authored notes. Today
   * no such trigger exists; the flag is forward-compatible discipline so
   * the workflow-step author doesn't have to remember to add it later
   * after a downstream subscriber starts caring. Mirrors the silent flag
   * on ConversationAssignedEvent / ContactUpdatedEvent.
   */
  silent?: boolean;
}

export interface NoteDeletedEvent {
  teamId: string;
  conversationId: string;
  noteId: string;
  /** Who deleted the note. null for system/automation deletions. The audit
   *  timeline attributes the row to this actor instead of falling back to
   *  "Removed user" / unattributed. */
  deletedByUserId: string | null;
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
 * Broadcast lifecycle: queued → running → completed | failed | canceled | paused.
 * `canceled` is operator-initiated via POST /api/broadcasts/:id/cancel —
 * runner sees the flipped status between recipients and bails.
 * `paused` is automatic on graceful shutdown — the runner stamps it when
 * the process is draining for deploy/restart; the boot reconciler flips
 * back to `queued` and re-fires the runner, which resumes via the
 * recipient CAS without re-sending anything already marked `sent`.
 * Emitted by the broadcast runner at each phase transition.
 */
export interface BroadcastStatusChangedEvent {
  teamId: string;
  broadcastId: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled" | "paused";
  error?: string;
  /**
   * When status === "failed" via the boot reconciler, the count of
   * recipients that were still `queued` when the process died. Surfaces
   * partial-failure scope to the UI (banner shows "N recipients never
   * received the message — manual resume required"). Undefined for
   * normal status transitions where this isn't meaningful.
   */
  abandonedRecipients?: number;
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
  /**
   * Absolute team-wide unread count. Broadcasts are outbound so this is
   * unchanged from before the send; included for parity with the wire
   * `message:new` payload so clients can absolute-overwrite instead of
   * additive-update their local mirror.
   */
  unreadCount: number;
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
  /**
   * Monotonic per-(message,emoji) version derived from `TeamChannelReaction.updatedAt`
   * (ms since epoch). The client compares incoming versions and DISCARDS any
   * event with `version <= lastSeenVersion` for that key — without this,
   * two near-simultaneous toggles can produce stale-but-different userIds
   * snapshots and the one that lands last wins regardless of real DB order.
   */
  version: number;
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
 * A user was added or removed from a channel. Subscribers fan this out as
 * `team:channel:member:added` / `:removed` to every connected member of the
 * team so (a) the affected user's channel list refreshes immediately, and
 * (b) the members dialog updates live for everyone watching it.
 *
 * `userIds` is the full set of changed users for batch ops — adding 8 people
 * via the picker produces ONE event with all 8 ids, not 8 events.
 */
export interface TeamChannelMembersChangedEvent {
  teamId: string;
  channelId: string;
  action: "added" | "removed";
  userIds: string[];
  changedById: string | null;
}

/**
 * A thread reply was deleted (or rarely, a chained refresh op). Carries the
 * post-decrement reply count + the new last-reply timestamp so the parent
 * message's "X replies" pill in the channel feed stays honest on every
 * other client. Fired alongside `message.deleted` for reply-row deletions.
 */
export interface TeamChannelThreadReplyCountChangedEvent {
  teamId: string;
  channelId: string;
  rootMessageId: string;
  replyCount: number;
  lastReplyAt: string | null;
}

/**
 * A user updated their own profile (name / avatar). Subscribers fan this to
 * the team so every cached sender-name + avatar around the inbox + assignment
 * surfaces reflects the new value without a refetch.
 *
 * Only the fields that actually changed are populated — undefined means "no
 * change", null means "explicitly cleared" (currently only supported for
 * avatarUrl since name is required).
 */
export interface UserProfileUpdatedEvent {
  teamId: string;
  userId: string;
  name?: string;
  avatarUrl?: string | null;
}

/**
 * A user changed their own availability (available / busy / away / offline).
 *
 * Split from `user.profile_updated` on purpose: availability is a higher-
 * frequency, lower-cost change (toggling busy/away as you move through your
 * day) — keeping it on a dedicated event keeps profile-update subscribers
 * (which may do heavier work) from running on every status flip. The
 * fanout subscriber emits a `user:availability:updated` socket frame to the
 * team room; "appear offline" also re-emits `presence:update` so the
 * online-dot list updates in the same frame.
 */
export interface UserAvailabilityChangedEvent {
  teamId: string;
  userId: string;
  /** Plain string here so the domain-event type doesn't pull the
   *  UserAvailabilityStatus union from the wider types module. */
  status: string;
  /** Optional free-form note; null when cleared, undefined when unchanged. */
  message?: string | null;
}

/**
 * An outbound-webhook subscription was auto-disabled by the circuit breaker
 * after N consecutive failures. Carries the webhook id + a short human-
 * readable reason so the settings UI can toast the team in real time
 * ("Webhook 'CRM sync' was auto-disabled after 20 consecutive failures").
 *
 * Internal-only event: NOT published to outbound webhooks (we'd just fail
 * to deliver it through the very subscription that just died). The
 * dedicated socket-fanout subscriber emits a `webhook:subscription_disabled`
 * frame to the team room.
 */
export interface WebhookSubscriptionDisabledEvent {
  teamId: string;
  webhookId: string;
  reason: string;
}

/**
 * A previously-failing webhook started delivering successfully again
 * (consecutiveFailures transitioned N>0 → 0). Mirrors
 * `webhook.subscription_disabled` — no outbound delivery, just an
 * internal socket frame to the team room so the UI can clear any
 * "webhook unhealthy" badge.
 */
export interface WebhookSubscriptionRecoveredEvent {
  teamId: string;
  webhookId: string;
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
    | "api-keys"
    | "team-channels";
}

/**
 * Team display name changed. Drives sidebar chrome + settings header live —
 * every open tab of every agent sees the new name without a refresh. Same
 * shape as the `team:renamed` socket frame in `socket/events.ts`.
 */
export interface TeamRenamedEvent {
  teamId: string;
  name: string;
  renamedByUserId: string;
}

// ---------------------------------------------------------------------------
// Event map — discriminated union by `type`. Use `DomainEventOf<K>` to grab
// the strongly-typed envelope for a single type.
// ---------------------------------------------------------------------------

export interface DomainEventMap {
  "message.received": MessageReceivedEvent;
  "message.sent": MessageSentEvent;
  "message.send_failed": MessageSendFailedEvent;
  "message.status_changed": MessageStatusChangedEvent;
  "message.media_ready": MessageMediaReadyEvent;
  "conversation.assigned": ConversationAssignedEvent;
  "conversation.status_changed": ConversationStatusChangedEvent;
  "conversation.deleted": ConversationDeletedEvent;
  "conversation.read": ConversationReadEvent;
  "contact.created": ContactCreatedEvent;
  "contact.updated": ContactUpdatedEvent;
  "contact.tag_changed": ContactTagChangedEvent;
  "contact.lifecycle_changed": ContactLifecycleChangedEvent;
  "contact.bulk_updated": ContactBulkUpdatedEvent;
  "contact.deleted": ContactDeletedEvent;
  "note.created": NoteCreatedEvent;
  "note.deleted": NoteDeletedEvent;
  "broadcast.status_changed": BroadcastStatusChangedEvent;
  "broadcast.progress": BroadcastProgressEvent;
  "broadcast.recipient_message_sent": BroadcastRecipientMessageSentEvent;
  "broadcast.conversation_reopened": BroadcastConversationReopenedEvent;
  "team_channel.message_created": TeamChannelMessageCreatedEvent;
  "team_channel.message_edited": TeamChannelMessageEditedEvent;
  "team_channel.message_deleted": TeamChannelMessageDeletedEvent;
  "team_channel.reaction_changed": TeamChannelReactionChangedEvent;
  "team_channel.pin_changed": TeamChannelPinChangedEvent;
  "team_channel.read": TeamChannelReadEvent;
  "team_channel.members_changed": TeamChannelMembersChangedEvent;
  "team_channel.thread_reply_count_changed": TeamChannelThreadReplyCountChangedEvent;
  "user.profile_updated": UserProfileUpdatedEvent;
  "user.availability_changed": UserAvailabilityChangedEvent;
  "team.catalog_changed": TeamCatalogChangedEvent;
  "team.renamed": TeamRenamedEvent;
  "webhook.subscription_disabled": WebhookSubscriptionDisabledEvent;
  "webhook.subscription_recovered": WebhookSubscriptionRecoveredEvent;
}

export type DomainEventType = keyof DomainEventMap;

export type DomainEventOf<K extends DomainEventType> = { type: K } & DomainEventMap[K];

export type DomainEvent = {
  [K in DomainEventType]: DomainEventOf<K>;
}[DomainEventType];

/**
 * Provider hint — `Channel` lives in the Prisma client enum. Surface
 * it here so subscribers can pivot on channel without re-importing Prisma.
 */
export type EventProvider = Channel;
