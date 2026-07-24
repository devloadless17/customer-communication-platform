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
  Channel,
  Contact,
  ConversationActivityEvent,
  ConversationStatus,
  ConversationWithRefs,
  InternalNote,
  MediaAttachment,
  Message,
  MessageFlag,
  MessageStatus,
  Ticket,
  TicketStatus,
  User,
  UserAvailabilityStatus,
} from "../types";
import type { AvailabilitySource } from "../work-hours";

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
    workspaceId: string;
    conversationId: string;
    message: Message;
    preview: string;
    lastMessageAt: string;
    /**
     * Absolute team-wide unread count AFTER the server-side write. Clients
     * overwrite their local mirror with this value (don't add a delta) so
     * brief drift from a dropped event self-heals on the next frame. See
     * MessageReceivedEvent.unreadCount for the migration rationale.
     */
    unreadCount: number;
    newConversation?: ConversationWithRefs;
    /**
     * Echoed from the originating client so it can swap its optimistic bubble
     * for this real one without flicker. Absent for inbound messages.
     */
    clientTempId?: string;
  }) => void;

  /** A message's delivery status changed (sent → delivered → read, or failed). */
  "message:status": (payload: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    status: MessageStatus;
    /**
     * Provider failure diagnostics — present ONLY on a `status: "failed"`
     * frame that carried a Meta `errors[0]` reason. Lets the inbox failed
     * bubble surface WHY a send failed (e.g. outside the 24h window, number
     * undeliverable) to the agent, not just a bare red icon. Absent on every
     * non-failed transition. Mirrors the persisted Message.statusError* columns.
     */
    errorCode?: number;
    errorTitle?: string;
    errorDetail?: string;
  }) => void;

  /**
   * A reaction on a message changed — set / replaced / removed. `actor` says
   * which side: `customer` (an inbound react) or `agent` (our own outbound
   * react), each an independent field on the message so both can show at once.
   * Scoped to the conversation room (like `message:status`): only agents
   * viewing the thread consume it, patching the reacted-to bubble. `emoji` is
   * null when the reaction was removed.
   */
  "message:reaction": (payload: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    actor: "customer" | "agent";
    emoji: string | null;
  }) => void;

  /**
   * The customer unsent (deleted) or edited a message. Scoped to the
   * conversation room like `message:reaction`: agents viewing the thread patch
   * the target bubble to the tombstone / edited body. Matched by `messageId`
   * (our internal id). `deletedAt` set → render "deleted"; `editedAt` + `body`
   * set → replace the text with an "edited" marker.
   */
  /**
   * The customer unsent (deleted) or edited a message. TEAM-scoped, not
   * conversation-scoped: this event is in `THREAD_REDUCER_EVENTS`, so the inbox
   * shell patches its CACHED (background) thread snapshots from it, and those
   * conversations' rooms were never joined. Rare enough (a customer correcting
   * their own message) that the team frame costs nothing.
   */
  "message:updated": (payload: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    deletedAt: string | null;
    editedAt: string | null;
    body: string | null;
    /** Customer 👍/👎 feedback on our outbound (Messenger response_feedback). */
    feedback?: "positive" | "negative" | null;
  }) => void;

  /**
   * A triage flag on a message was raised, changed, resolved, or removed.
   *
   * TEAM-scoped, not conversation-scoped, for the same reason as
   * `message:updated`: this event is in `THREAD_REDUCER_EVENTS`, so the inbox
   * shell patches its CACHED background thread snapshots from it, and those
   * conversations' rooms were never joined. It also drives the flags queue and
   * the inbox-list flag badge, neither of which is inside any `conv:` room.
   * Low volume (agent-initiated triage), so the team frame is free.
   *
   * `flag` is the state AFTER the change, present even for `removed` (the
   * reducer matches on `flag.id` and the queue needs the definition to animate
   * the row out). `openFlagCount` is the parent conversation's post-change
   * count — the list badge reads it directly instead of recomputing.
   */
  "message:flag": (payload: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    action: "added" | "updated" | "reopened" | "resolved" | "removed";
    flag: MessageFlag;
    openFlagCount: number;
  }) => void;

  /**
   * A ticket was created or changed.
   *
   * WORKSPACE-room scoped, unlike `message:flag`. The ticket board is a
   * workspace-wide view of work across every conversation — an agent watching
   * the board has not joined `conv:<id>` for any of the threads on it, so a
   * conversation-room frame would leave every card stale until a refetch. The
   * frames are rare (ticket writes are agent- or lifecycle-driven, never
   * per-message), so the team-room cost is the right trade — same call as
   * `message:updated`.
   *
   * `ticket` is the state AFTER the change. `openTicketCount` is the parent
   * conversation's post-change count, so the inbox row badge updates from the
   * same frame without recomputing.
   */
  "ticket:changed": (payload: {
    workspaceId: string;
    ticketId: string;
    conversationId: string;
    action:
      | "created"
      | "assigned"
      /** Handed to a different TEAM — the board must re-render both queues. */
      | "team_changed"
      | "status_changed"
      | "priority_changed"
      | "reopened"
      | "solved"
      | "closed"
      | "sla_breached"
      | "updated"
      /** Permanently deleted — the board drops the card, the detail view exits. */
      | "deleted";
    ticket: Ticket;
    previousStatus: TicketStatus | null;
    breachedLeg?: "first_response" | "resolution";
    openTicketCount: number;
  }) => void;

  /**
   * The inbox-list preview for a conversation changed WITHOUT a new message —
   * fired when the customer unsends/edits the thread's NEWEST message, so the
   * denormalized `lastMessagePreview` (tombstone / edited text) updates live in
   * the list instead of waiting for the next read to converge. Team-scoped (the
   * list is team-wide); the sibling `message:updated` frame patches the open
   * thread's bubble. Carries no unread/assignment change and must not re-sort
   * the row — `lastMessageAt` is the newest message's own (unchanged) time,
   * forwarded only for the list's recency guard.
   */
  "conversation:preview": (payload: {
    workspaceId: string;
    conversationId: string;
    preview: string;
    lastMessageAt: string | null;
  }) => void;

  /**
   * Outbound send failed inside the background `message-sends` queue worker.
   * Frontend reducer flips the optimistic bubble (matched by clientTempId)
   * from `pending` to `failed` so the user sees the same error UX as the
   * pre-queue inline 4xx path. See `MessageSendFailedEvent` for why only
   * socket-fanout subscribes to the underlying domain event.
   */
  "message:failed": (payload: {
    workspaceId: string;
    conversationId: string;
    clientTempId?: string;
    reason: string;
    detail?: string;
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
    workspaceId: string;
    conversationId: string;
    messageId: string;
    media?: MediaAttachment;
  }) => void;

  /** A teammate added an internal note. */
  "note:new": (payload: {
    workspaceId: string;
    conversationId: string;
    note: InternalNote;
  }) => void;

  /** A teammate deleted an internal note — splice it out of the thread. */
  "note:deleted": (payload: {
    workspaceId: string;
    conversationId: string;
    noteId: string;
    /** Client-only flag on the deleter's optimistic dispatch: removes the card
     *  instantly but skips the leading /events GET (which would race ahead of
     *  the server's audit row). The authoritative team-room frame drives the
     *  "deleted a note" pill. See `conversation:assigned.optimistic`. */
    optimistic?: boolean;
  }) => void;

  /** Assignment was changed (or cleared). */
  "conversation:assigned": (payload: {
    workspaceId: string;
    conversationId: string;
    assignedUser: User | null;
    /**
     * Set ONLY by client-side optimistic dispatches (dispatchLocalSocketEvent),
     * before the corresponding POST /assign has committed. Server fan-out never
     * sets it. Consumers that re-fetch from the server on this event (inbox-list
     * filter resync, conversation-counts refetch) MUST skip that re-fetch when
     * this is true — otherwise the read can beat the in-flight write and either
     * (a) re-introduce a stale row that the optimistic patch already removed or
     * (b) overwrite the optimistic count badge with pre-change numbers. The
     * post-commit server frame (optimistic absent) drives convergence. Mirrors
     * the same flag on `contact:updated`.
     */
    optimistic?: boolean;
  }) => void;

  /** Conversation status changed (open / pending / closed). */
  "conversation:status": (payload: {
    workspaceId: string;
    conversationId: string;
    status: ConversationStatus;
    /** See `conversation:assigned.optimistic`. */
    optimistic?: boolean;
  }) => void;

  /** AI Autopilot enabled/disabled for a conversation. */
  "conversation:ai": (payload: {
    workspaceId: string;
    conversationId: string;
    aiEnabled: boolean;
    /** See `conversation:assigned.optimistic`. */
    optimistic?: boolean;
  }) => void;

  // --- Native AI Assistant (panel/suggestion-level; consumed by the inbox AI
  // surfaces via direct socket.on, not thread-reducers). ---
  "ai:suggestion": (payload: {
    workspaceId: string;
    conversationId: string;
    suggestionId: string | null;
    state: string;
  }) => void;
  "ai:summary": (payload: { workspaceId: string; conversationId: string }) => void;
  "ai:memory": (payload: {
    workspaceId: string;
    conversationId: string;
    customerId: string;
  }) => void;
  "ai:state": (payload: { workspaceId: string; conversationId: string; state: string }) => void;
  "ai:transcription": (payload: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    status: string;
  }) => void;
  "ai:flag": (payload: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    risk: number;
    notes: string | null;
  }) => void;

  /**
   * Conversation was hard-deleted by an agent. Every client splices it out
   * of its list; an open detail view should bounce back to /inbox.
   */
  "conversation:deleted": (payload: {
    workspaceId: string;
    conversationId: string;
  }) => void;

  /**
   * Contact was hard-deleted. All its conversations went with it via FK
   * cascade — fire one event per affected conversation so existing
   * conversation:deleted listeners drop them. Plus this one for the
   * contacts page itself.
   */
  "contact:deleted": (payload: {
    workspaceId: string;
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
    workspaceId: string;
    contact: Contact;
    /**
     * Set ONLY by client-side optimistic dispatches (dispatchLocalSocketEvent),
     * before the corresponding PATCH has committed. Server fan-out never sets
     * it. Consumers that re-fetch from the server on this event (e.g. the inbox
     * list's stage-filter re-sync) MUST skip that re-fetch when this is true —
     * otherwise the read can beat the in-flight write and re-introduce a stale
     * row. The post-commit server frame (optimistic absent) drives convergence.
     */
    optimistic?: boolean;
  }) => void;

  /**
   * Coalesced "many contacts just changed" notification. Fanned out from
   * bulk paths (POST /api/contacts/bulk for tag-add/tag-remove today).
   * Clients should invalidate the contact list query and any open
   * conversation/contact-panel views for the affected ids — full payloads
   * are NOT carried (would re-create the per-contact frame storm this
   * event exists to avoid). Refetch the rows in one query.
   *
   * Single-contact PATCH still emits `contact:updated` per row — this
   * event only fires when the server batched the mutation.
   */
  "contacts:bulk_updated": (payload: {
    workspaceId: string;
    contactIds: string[];
    changeKind: "tags" | "stage" | "fields" | "mixed";
  }) => void;

  /**
   * Live progress for a contact import/export job, delivered ONLY to the
   * `user:` room of whoever started it. Fires roughly every 2s while the job
   * runs plus once on every terminal transition, so the wizard can show a real
   * progress bar and auto-start the download without polling.
   */
  "contacts:transfer_progress": (payload: {
    workspaceId: string;
    job: {
      id: string;
      kind: "import" | "export";
      format: "csv" | "xlsx";
      status: "pending" | "running" | "completed" | "failed" | "canceled";
      filename: string;
      processedRows: number;
      totalRows: number | null;
      created: number;
      updated: number;
      revived: number;
      skipped: number;
      failed: number;
      automationsSkipped: boolean;
      hasArtifact: boolean;
      hasErrorReport: boolean;
      error: string | null;
    };
  }) => void;

  /**
   * Conversation was read — team-wide unread counter resets to 0. Fires when
   * a teammate opens the thread or explicitly marks it read. CLAUDE.md flags
   * per-agent unread as deferred, so this is shared across the team.
   */
  "conversation:read": (payload: {
    workspaceId: string;
    conversationId: string;
    readByUserId: string;
  }) => void;

  /**
   * CLIENT-ONLY optimistic activity-log pill. The server NEVER fans this out —
   * the authoritative activity row is fetched via GET
   * /api/conversations/:id/events after the matching header/contact frame lands
   * (see use-conversation-events `refreshActivity`). This event exists solely so
   * the agent who MADE a change (status / assignment / stage / tag) sees the
   * timeline pill in the SAME frame as the header flips, instead of waiting on
   * that GET round-trip.
   *
   * Dispatched via `dispatchLocalSocketEvent` from the change call sites
   * (status/assignment dropdowns, stage picker, tag picker). Consumed only by
   * `use-conversation-events`, which appends the synthetic event to `data.events`
   * with an `optimistic-…` id. The trailing authoritative GET replaces the
   * whole `events` array with server rows (correct id + exact server time +
   * actor for teammates), so the optimistic stub is transparently reconciled —
   * never persisted, never double-rendered (matched out by `optimisticId`).
   *
   * `optimisticId` is the synthetic event's `id`; carried separately so a
   * rollback dispatch can target the exact stub to remove on a failed PATCH.
   */
  "conversation:activity": (payload: {
    workspaceId: string;
    conversationId: string;
    /** The synthetic event to append. `null` together with `removeId` = remove. */
    event: ConversationActivityEvent | null;
    /** When set, splice this optimistic id out (rollback on a failed write). */
    removeId?: string;
  }) => void;

  /**
   * Snapshot of which teammates currently have a live socket. Broadcast to
   * the team room whenever the set changes; also sent to a single socket on
   * subscribe so it doesn't have to wait for the next change to populate.
   */
  "presence:update": (payload: {
    workspaceId: string;
    onlineUserIds: string[];
  }) => void;

  /**
   * One teammate's availability changed (available / busy / away / offline).
   *
   * Sent to the team room on every status flip; also seeded to a single
   * socket on connect as part of the initial snapshot so a freshly-loaded
   * tab sees teammates' current state without waiting for a change.
   *
   * Orthogonal to `presence:update`:
   *   - `presence:update` is the set of users with ≥1 open socket.
   *   - `user:availability:updated` is the per-user status badge.
   * A user can be online + busy (online dot + busy badge), online + offline
   * (the user picked "Appear offline" — socket is up, presence excludes
   * them anyway so the online dot goes off), or offline + anything (socket
   * gone — status irrelevant). Treat them as independent.
   *
   * `message: null` clears a previously-set note; `undefined` means
   * "unchanged" — clients merge by user id, replacing the prior entry.
   */
  "user:availability:updated": (payload: {
    workspaceId: string;
    userId: string;
    status: UserAvailabilityStatus;
    message?: string | null;
    /**
     * Who decided it: "manual" (they picked it), "admin" (a teammate with
     * `availability:manageOthers` set it for them), or "schedule" (their
     * working hours flipped). Absent = "manual".
     */
    source?: AvailabilitySource;
    /** ISO instant the manual/admin pick expires back to the schedule. */
    until?: string | null;
    /**
     * The user's own pick, distinct from the effective status above. Read ONLY
     * by that user's own availability picker — teammates render `status` /
     * `message`. Lets the picker stay in sync across devices without showing
     * the schedule's note as if the user had typed it.
     */
    manual?: { status: UserAvailabilityStatus; message: string | null };
  }) => void;

  /**
   * Bulk seed of every teammate's current availability. Sent to a single
   * socket on connect (and on `presence:request`) so the freshly-loaded tab
   * paints right immediately. Single-user changes go via
   * `user:availability:updated`; this event is read once on join and never
   * re-applied incrementally.
   */
  "user:availability:snapshot": (payload: {
    workspaceId: string;
    byUserId: Record<string, {
      status: UserAvailabilityStatus;
      message?: string | null;
      source?: AvailabilitySource;
      until?: string | null;
    }>;
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
   * A website-widget VISITOR is typing in this conversation. Distinct from
   * `typing:update` (that carries teammate userIds; a visitor is not a user).
   * The widget gateway relays the visitor's `visitor:typing {on}` to the agent
   * conversation room so the inbox can show "the customer is typing…". Only
   * `webchatwidget` threads ever emit this. Scoped to the conversation room
   * (not team-wide) — same fanout scope as `typing:update`.
   */
  "conversation:visitor_typing": (payload: {
    conversationId: string;
    on: boolean;
  }) => void;

  /**
   * A website-widget visitor's socket connected (`present:true`) or dropped
   * (`present:false`). Lets an agent see whether the visitor is still on the page
   * instead of waiting on a dead thread. Conversation-scoped, ephemeral.
   */
  "conversation:visitor_presence": (payload: {
    conversationId: string;
    present: boolean;
    /** Epoch ms the visitor's last socket dropped (present=false). Carried so an
     *  agent who opens the thread AFTER the visitor left still sees an accurate
     *  "Left Xm ago" rather than "just now". null when currently present, or when
     *  the visitor was never seen this session (renders "Away"). */
    leftAt?: number | null;
  }) => void;

  /**
   * Snapshot of which teammates currently have this conversation OPEN in
   * their inbox UI. Different from `typing:update` — that fires on every
   * keystroke transition; this fires on subscribe/unsubscribe.
   *
   * The whole point of a shared inbox is that the team avoids double-
   * handling. A viewer pill in the thread header ("Maria is also viewing
   * this chat") lets agents see the collision before both of them type
   * replies. Reuses the existing per-conversation socket room so the
   * fanout cost is one frame per join/leave instead of N team-wide
   * emits.
   *
   * Server-side state: per-conversation Set<userId> in PresenceService.
   * The set is snapshotted to the joining socket immediately (so the
   * pill paints without waiting for the next change) and broadcast to
   * the room only when the set transitions on the user level — multiple
   * tabs from the same agent are one viewer, not several.
   */
  "conversation:viewers": (payload: {
    conversationId: string;
    viewerUserIds: string[];
  }) => void;

  /**
   * Broadcast lifecycle: `queued` → `running` → `completed` | `failed`. Fired
   * by the broadcast runner so the detail page can update without polling
   * (polling is still in place as a fallback for clients off the socket).
   */
  "broadcast:status": (payload: {
    workspaceId: string;
    broadcastId: string;
    // `scheduled` is emitted only by the create path so other tabs can
    // pick up newly-created delayed broadcasts live. See
    // BroadcastStatusChangedEvent in events/types.ts.
    status:
      | "scheduled"
      | "materializing"
      | "queued"
      | "running"
      | "completed"
      | "failed"
      | "canceled"
      | "paused";
    error?: string;
  }) => void;

  /**
   * Per-send progress tick. Fired once per recipient send (success or fail)
   * so the detail page can advance the progress bar in real time.
   */
  "broadcast:progress": (payload: {
    workspaceId: string;
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
    workspaceId: string;
    scope:
      | "stages"
      | "tags"
      // The message-flag catalog (which triage flags exist). An open inbox's
      // flag picker is populated once per session, so a create/rename/archive
      // needs this frame to reach every tab — otherwise a new flag is invisible
      // until reload.
      | "message-flags"
      | "contact-fields"
      // Multi-step workflow definitions (canvas). Round 2 replaced
      // single-action "automations" with this.
      | "workflows"
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
      | "invites"
      // Team-scoped API keys. Fires on create + revoke so a second admin
      // tab viewing /settings/api-keys updates without a manual refresh.
      | "api-keys"
      // Workflow definitions — fires on workflow create / publish / disable
      // so the /automations list updates across open tabs.
      | "workflows"
      // Team chat channels. Fires on channel create / rename / delete so
      // every agent's sidebar refreshes without a page reload.
      | "team-channels"
      // Channel connections (Messenger / Instagram / …). Fires on connect /
      // update / disconnect so the settings Channels list refreshes live.
      | "channels";
  }) => void;

  /**
   * Team (organization) display name was changed by an admin. Sidebar
   * chrome + settings header listen and patch the rendered name in place —
   * no router.refresh(), no flash. Scoped to the `team:<id>` room so only
   * members of that team see it.
   */
  "team:renamed": (payload: {
    workspaceId: string;
    name: string;
    renamedByUserId: string;
  }) => void;

  /**
   * An outbound webhook subscription was auto-disabled by the circuit
   * breaker after N consecutive failures. The settings page listens to
   * this and refreshes the subscription list + toasts the admin so they
   * know the integration just went silent.
   */
  "webhook:subscription_disabled": (payload: {
    workspaceId: string;
    webhookId: string;
    reason: string;
  }) => void;

  /**
   * Counterpart to `webhook:subscription_disabled`: a previously-failing
   * webhook started succeeding again. The settings page clears any "this
   * webhook is unhealthy" badge so the operator doesn't need to refresh.
   */
  "webhook:subscription_recovered": (payload: {
    workspaceId: string;
    webhookId: string;
  }) => void;

  // -------------------------------------------------------------------------
  // Team chat (internal channels). All payloads carry `workspaceId` so the team
  // room's clients can ignore events from other tenants in the rare case
  // they ever cross a room (e.g. multi-team accounts in the future).
  // -------------------------------------------------------------------------

  /**
   * A new message landed in a channel — top-level OR thread reply. Clients
   * subscribed to that channel append it to their feed; clients on the
   * channel list (sidebar) bump unread counts. `threadRootId` discriminates:
   *   - null → top-level: append to channel feed, bump lastMessage preview.
   *   - set  → reply: skip the channel feed (it lives in the thread panel).
   *            Use `team:channel:thread:reply` to bump the root's reply pill.
   *
   * `clientTempId` is echoed for the originating client's optimistic swap,
   * same pattern as `message:new` for customer threads.
   */
  "team:channel:message": (payload: {
    workspaceId: string;
    channelId: string;
    message: TeamChannelMessageDto;
    /** Truncated body / media hint for the channel-list preview. Null for replies. */
    preview: string | null;
    /** Updated channel.lastMessageAt — only set for top-level messages. */
    lastMessageAt: string | null;
    clientTempId?: string;
  }) => void;

  /**
   * CONTENT-LEAN companion to `team:channel:message`, fanned to the TEAM room
   * so the SIDEBAR channel list can live-update its unread dot + mention badge
   * for channels the viewer is NOT currently subscribed to (the channel-room
   * `team:channel:message` frame only reaches the one channel a tab has open).
   *
   * Deliberately carries NO message body / preview — a team-room frame reaches
   * non-members of private channels, so leaking the body here would defeat the
   * channel-room confidentiality boundary. Only id-shaped fields cross:
   *   - `authorUserId` — so the author's own send doesn't badge their sidebar.
   *   - `mentionedUserIds` — so the recipient knows whether to bump the mention
   *     counter.
   *   - `lastMessageAt` — reorders the row (null for thread replies).
   *   - `isReply` — replies bump only the mention counter, never the unread dot.
   * The list ignores any `channelId` not already in its (membership-scoped)
   * state, so non-members drop the frame. The preview text converges via the
   * channel-room frame (when the channel is active) or the next list refetch.
   */
  "team:channel:activity": (payload: {
    workspaceId: string;
    channelId: string;
    authorUserId: string | null;
    mentionedUserIds: string[];
    /** Updated channel.lastMessageAt — null for thread replies. */
    lastMessageAt: string | null;
    /** True when this was a thread reply (mention-only, no unread-dot bump). */
    isReply: boolean;
  }) => void;

  /** Reply landed in a thread. Fired in addition to `team:channel:message`.
   *  Also fired (with a possibly-null `lastReplyAt`) on reply DELETE so the
   *  parent's "X replies" pill keeps the count + timestamp in sync. */
  "team:channel:thread:reply": (payload: {
    workspaceId: string;
    channelId: string;
    rootMessageId: string;
    replyCount: number;
    lastReplyAt: string | null;
  }) => void;

  /**
   * A message body was edited in place. `editedAt` becomes the "(edited)"
   * label source. Body is the post-edit content; old body isn't carried.
   */
  "team:channel:message:edited": (payload: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    body: string;
    editedAt: string;
  }) => void;

  /** A message was hard-deleted. Splice from the feed and any open thread. */
  "team:channel:message:deleted": (payload: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    /** Set when the deleted message was a reply — so the thread panel can
     *  decrement its count without a refetch. Null for top-level deletes. */
    threadRootId: string | null;
  }) => void;

  /**
   * Reaction snapshot for an emoji on a message. We emit the FULL user-id
   * list per emoji on every change (add or remove) rather than diff events
   * — payload is tiny (a few cuids) and the receiver doesn't need a reducer
   * to apply add/remove deltas correctly. Empty `userIds` means the last
   * reaction was removed.
   */
  "team:channel:reaction:changed": (payload: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    emoji: string;
    userIds: string[];
    /** Monotonic per-(message,emoji) version (ms since epoch). The client uses
     *  it to discard a STALE OPTIMISTIC frame, never to gate an authoritative
     *  one — see `optimistic`. */
    version: number;
    /** True only for client-predicted (local) frames. The authoritative server
     *  frame OMITS this (or sets false) and is ALWAYS applied — it carries the
     *  full per-(message,emoji) DB snapshot, so it is truth. Gating it by
     *  `version` was a bug: a client clock ahead of the server made an
     *  optimistic frame out-rank the authoritative one, so the real reaction
     *  state was discarded until a refetch. */
    optimistic?: boolean;
  }) => void;

  /**
   * A message was pinned or unpinned in a channel.
   *
   * The pin metadata is carried so the client can synthesize the ChannelPinDto
   * from the message it already holds instead of refetching the whole pin
   * list. It still falls back to a refetch when the pinned message is off the
   * loaded slice — and the reconnect refetch stays as the convergence path.
   * Fields are null on unpin.
   */
  "team:channel:pin:changed": (payload: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    pinned: boolean;
    pinnedAt: string | null;
    pinnedById: string | null;
    pinnedByName: string | null;
  }) => void;

  /**
   * A user marked a channel read. Broadcast to the team so every tab of the
   * SAME user clears its badge (and so other agents don't accidentally
   * re-mark on the next paint). Carries the new `lastReadAt` so receivers
   * can reconcile against any in-flight `team:channel:message` events.
   */
  "team:channel:read": (payload: {
    workspaceId: string;
    channelId: string;
    readByUserId: string;
    lastReadAt: string;
  }) => void;

  /**
   * Typing snapshot for a channel. Same shape as the conversation typing
   * event but scoped to a channel room. Fires on every change to the set.
   */
  "team:channel:typing:update": (payload: {
    channelId: string;
    typingUserIds: string[];
  }) => void;

  /**
   * One or more users were added to / removed from a channel. Fires to every
   * connected member of the team — clients receiving this event update their
   * cached members list for the channel, and the affected users (those in
   * `userIds`) update their own channel-list visibility.
   *
   * `userIds` is the full set of changes for the action (batched), not one
   * event per user. `changedById` is the actor who triggered the change.
   */
  "team:channel:members:changed": (payload: {
    workspaceId: string;
    channelId: string;
    action: "added" | "removed";
    userIds: string[];
    changedById: string | null;
  }) => void;

  /**
   * A team member updated their profile (name / avatar). Cached sender names
   * + avatars across the inbox, assignment dropdowns, contact-panel "assigned
   * to" labels, and team-chat author rows update against this without a
   * refetch.
   *
   * Undefined fields = no change. `avatarUrl: null` = explicitly cleared.
   */
  "user:profile:updated": (payload: {
    workspaceId: string;
    userId: string;
    name?: string;
    avatarUrl?: string | null;
  }) => void;

  /**
   * A 1:1 DM was created; the recipient should surface it in their sidebar.
   *
   * Emitted ONLY to the two participants' `user:` rooms — never the team
   * room, because the existence of a DM between two people is itself private.
   *
   * Deliberately CONTENT-FREE: no peer name, no avatar, no preview. The client
   * responds by refetching `GET /api/team/channels/dms`, which is membership-
   * filtered server-side, so the frame itself can't disclose anything even if
   * it were ever mis-routed. Do not "helpfully" enrich this payload further.
   *
   * `createdByUserId` is the one permitted addition and it is load-bearing:
   * this frame reaches BOTH participants, so without an author the starter's
   * own tab cannot tell "I just clicked New DM" from "someone DM'd me" — and a
   * client-side marker stamped when the POST resolves always loses the race
   * against the socket frame. It leaks nothing: it goes only to the two
   * people in the DM, who already know who they are.
   */
  "team:dm:created": (payload: {
    workspaceId: string;
    channelId: string;
    /** Who opened it — lets the starter's own tab skip the toast/ding. */
    createdByUserId: string;
  }) => void;

  /**
   * Typing snapshot for a thread. Rides the channel room (so any tab with
   * the channel open can dispatch — only the tab with the matching thread
   * panel open will render). `threadRootId` is the discriminator clients
   * filter on.
   */
  "team:channel:thread:typing:update": (payload: {
    channelId: string;
    threadRootId: string;
    typingUserIds: string[];
  }) => void;

  // ---- WhatsApp Business Calling -----------------------------------------
  // The browser is the WebRTC peer; these frames carry signaling + lifecycle.
  // The split mirrors the locked `availability:*` event-split decision: each
  // phase rides its own frame so subscribers attach to the narrowest payload.

  /** Inbound call ringing. Team room — any agent might pick up. */
  "call:incoming": (payload: {
    workspaceId: string;
    conversationId: string;
    callId: string;
    externalCallId: string;
    /** Drives the browser answer signaling (WhatsApp consumes the webhook SDP
     *  offer; social generates the offer locally) + the toast copy. */
    channel: Channel;
    contactId: string;
    contactName: string;
    ringingAt: string;
  }) => void;

  /** Outbound call placed. TEAM room (not the conversation room): the inbox
   *  thread reducer still filters by `conversationId` so only the agent
   *  viewing the originating thread paints the ring banner, but the team-wide
   *  Calls badge (which counts ringing rows) must see the outbound ring phase
   *  for non-viewers too. See fanout-rules.ts `call.ringing_out`. */
  "call:ringing": (payload: {
    workspaceId: string;
    conversationId: string;
    callId: string;
    initiatedByUserId: string;
    /** SERVER ringing time (ISO). Carried so the optimistic call entry sorts in
     *  the timeline by server time — same clock as messages/notes/events — not
     *  the client's `Date.now()` (which mis-orders a call vs a message when the
     *  client clock lags the server). */
    ringingAt: string;
  }) => void;

  /** First agent's CAS succeeded. Team room — dismisses every OTHER toast. */
  "call:answered": (payload: {
    workspaceId: string;
    conversationId: string;
    callId: string;
    answeredByUserId: string;
    answeredAt: string;
  }) => void;

  /** Call ended (terminal). Same shape used for missed/rejected/failed —
   *  Call.status differentiates them on the row when the bubble renders. */
  "call:ended": (payload: {
    workspaceId: string;
    conversationId: string;
    callId: string;
    durationSeconds: number | null;
    endedAt: string;
    /** Terminal CallStatus value the row was set to. */
    status: "completed" | "missed" | "rejected" | "failed";
  }) => void;

  /** SDP delivered by Meta. Inbound: type="offer" (customer's offer →
   *  browser generates answer → POST /answer). Outbound: type="answer"
   *  (customer's answer to our offer → browser calls setRemoteDescription
   *  to complete handshake). Branches on payload.sdp.type. */
  "call:sdp_offer": (payload: {
    workspaceId: string;
    conversationId: string;
    callId: string;
    sdp: { type: "offer" | "answer"; sdp: string };
  }) => void;

}

// -------------------------------------------------------------------------
// Team-chat DTOs. Defined here (not in lib/types.ts) so the socket layer
// stays self-contained — adding a field is a one-file edit on both ends.
// -------------------------------------------------------------------------

export interface TeamChannelMediaDto {
  kind: string;
  /**
   * RELATIVE auth-gated proxy path (`/api/team/channels/:id/messages/:mid/media`)
   * — NOT the raw CDN URL. The API redirects to the CDN after a team +
   * channel-membership check, so internal attachments are auth-protected (M4).
   */
  url: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
  filename?: string;
  durationMs?: number;
}

export interface TeamChannelMessageDto {
  id: string;
  channelId: string;
  workspaceId: string;
  /** Null when author was removed. UI renders "Removed user." */
  authorUserId: string | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  body: string;
  media?: TeamChannelMediaDto;
  /** Null = never edited. Otherwise the most recent edit timestamp. */
  editedAt: string | null;
  /** Null on top-level messages. */
  threadRootId: string | null;
  /** Live counts on the ROOT message (0 / null on reply rows). */
  threadReplyCount: number;
  threadLastReplyAt: string | null;
  /** Mentioned user ids (small array — denormalized for cheap render). */
  mentionedUserIds: string[];
  /** Per-emoji snapshot of reactor user ids. */
  reactions: { emoji: string; userIds: string[] }[];
  /** True iff a TeamChannelPin row exists for this message. */
  pinned: boolean;
  createdAt: string;
  // ---- Client-only optimistic fields (never persisted) ----
  clientTempId?: string;
  pending?: boolean;
  failed?: boolean;
}

// ---------------------------------------------------------------------------
// Client → Server events.
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  /** Join a conversation room — receives message/note updates for that thread. */
  "subscribe:conversation": (payload: { conversationId: string }) => void;
  "unsubscribe:conversation": (payload: { conversationId: string }) => void;

  /** Agent started typing in a conversation. Server fans out to that room. */
  "typing:start": (payload: { conversationId: string }) => void;
  /** Agent stopped typing — explicit, e.g. on send or on blur. */
  "typing:stop": (payload: { conversationId: string }) => void;

  // -------------------------------------------------------------------------
  // Team-chat room joins. Subscribing to a channel gets you message/edit/
  // delete/reaction/pin/typing events for that channel — thread replies,
  // edits, and reactions ride the same team-room frames and are filtered
  // client-side by `payload.threadRootId === rootMessageId`. A dedicated
  // thread room was redundant; removed.
  // -------------------------------------------------------------------------
  "subscribe:channel": (payload: { channelId: string }) => void;
  "unsubscribe:channel": (payload: { channelId: string }) => void;
  "typing:channel:start": (payload: { channelId: string }) => void;
  "typing:channel:stop": (payload: { channelId: string }) => void;

  /**
   * Ask the server for a fresh `presence:update` snapshot scoped to this
   * socket. Needed because the snapshot the server emits on handshake fires
   * BEFORE any feature hook mounts a listener — so a route-nav into /inbox
   * (no reconnect) would otherwise wait for the next teammate to flip online
   * before populating the green dots.
   */
  "presence:request": () => void;
  /** Thread typing. `channelId` is required so the gateway can validate
   *  membership without a DB lookup (the socket is already in that room). */
  "typing:thread:start": (payload: { channelId: string; threadRootId: string }) => void;
  "typing:thread:stop": (payload: { channelId: string; threadRootId: string }) => void;
}

// Inter-server events left empty until we add a Redis adapter (deferred per CLAUDE.md).
export type InterServerEvents = Record<string, never>;

export interface SocketData {
  // Set during the handshake auth middleware, non-null afterwards.
  workspaceId?: string;
  userId?: string;
  role?: import("../types").Role;
  /** `Team.agentConversationVisibility` — decides whether this socket joins the
   *  team firehose room. See RealtimeGateway.handleConnection. */
  agentConversationVisibility?: string;
  /** Conversations this socket is currently flagged as typing in. */
  typingIn?: Set<string>;
  /** Channels (team chat) this socket is currently flagged as typing in. */
  typingInChannel?: Set<string>;
  /** Threads (team chat) this socket is currently flagged as typing in.
   *  Keyed by `threadRootId`; the channel is recoverable from socket rooms. */
  typingInThread?: Set<string>;
  /** `${channelId}::${threadRootId}` composites whose thread root has been
   *  verified to belong to the supplied channel. Caches the per-socket
   *  thread-typing ownership check so re-toggles skip the DB lookup. */
  validatedThreads?: Set<string>;
  /**
   * Conversations this socket has joined as a viewer. Tracked so disconnect
   * can release viewer slots without depending on the client managing to
   * send unsubscribe:conversation on tab close.
   */
  viewingConversations?: Set<string>;
}

/** Path Socket.io binds to. Kept here so client and server cannot drift. */
export const SOCKET_PATH = "/api/socket";

/**
 * Handshake query flag marking a socket as the anonymous WEBSITE WIDGET rather
 * than the agent app. Both share one Socket.io server, and CORS is resolved on the
 * HTTP handshake before any namespace is known — so the transport-level CORS
 * delegate in `ws-adapter.ts` needs this to tell them apart and reflect the
 * customer's third-party origin WITHOUT credentials (see the rationale there).
 *
 * `apps/web/public/widget.js` is plain, un-bundled JS served as a static asset, so
 * it cannot import this — it hardcodes the literal `widget=1`. Change both together.
 */
export const WIDGET_HANDSHAKE_FLAG = "widget";
