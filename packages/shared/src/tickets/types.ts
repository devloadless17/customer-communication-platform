/**
 * Tickets — the unit of WORK on a conversation.
 *
 * A conversation is the long-lived thread with one contact on one channel and
 * never fragments. A ticket is one piece of work on it, and there are many over
 * time: the refund in March and the delivery question in June are two tickets on
 * one unbroken thread, each with its own assignee, priority, SLA clock and
 * outcome.
 *
 * Framework-agnostic wire shapes only. The DB models live in
 * prisma/schema.prisma; the domain logic in apps/api/src/lib/tickets.
 */

/**
 * Lifecycle of a ticket.
 *  - `new`     — raised but unclaimed. Distinct from `open` so an untriaged
 *                backlog is reportable separately from a worked one.
 *  - `open`    — actively being worked.
 *  - `pending` — waiting on the CUSTOMER's reply.
 *  - `on_hold` — waiting on US, deliberately parked (escalation, part on order).
 *  - `solved`  — the customer got their answer; the work is done. A person may
 *                still reopen it deliberately — nothing reopens it on its own
 *                (auto-reopen removed 2026-08-01).
 *  - `closed`  — terminal. A genuinely new issue gets a NEW ticket somebody
 *                chooses to raise; nothing opens one automatically.
 */
export type TicketStatus = "new" | "open" | "pending" | "on_hold" | "solved" | "closed";

/** Every status, in board-column order. Iterate this, never a literal array. */
export const TICKET_STATUSES: readonly TicketStatus[] = [
  "new",
  "open",
  "pending",
  "on_hold",
  "solved",
  "closed",
] as const;

/**
 * States a ticket is still WORK. The complement (`solved`, `closed`) is what
 * `Conversation.openTicketCount` excludes and what the SLA sweeper skips —
 * derive from this set rather than re-listing statuses at each call site.
 */
/**
 * The ONE set of human labels for the statuses. Four surfaces (board, detail,
 * sub-sidebar, workflow step editor) each hand-wrote their own copy and one had
 * already drifted; iterate `TICKET_STATUSES` and read labels from here.
 */
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  pending: "Waiting on customer's reply",
  on_hold: "On hold",
  solved: "Solved",
  closed: "Closed",
};

export const TICKET_ACTIVE_STATUSES: readonly TicketStatus[] = [
  "new",
  "open",
  "pending",
  "on_hold",
] as const;

export function isTicketActive(status: TicketStatus): boolean {
  return (TICKET_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export type TicketPriority = "low" | "normal" | "high" | "urgent";

/** Lowest first — the order the priority picker and the board sort render in. */
export const TICKET_PRIORITIES: readonly TicketPriority[] = [
  "low",
  "normal",
  "high",
  "urgent",
] as const;

/**
 * Who or what created / changed a ticket. A plain string union, not a DB enum,
 * for the same reason as MessageFlagSource: provenance metadata, not behaviour.
 *  - `auto`       — opened by an inbound message on a thread with no active ticket
 *  - `human`      — an agent
 *  - `workflow`   — a workflow step
 *  - `api`        — an external /v1 integration
 *  - `escalation` — created in THIS workspace by another workspace escalating a
 *                   ticket here (the target side of a TicketEscalation pair)
 */
export type TicketSource = "auto" | "human" | "workflow" | "api" | "escalation";

export const TICKET_SOURCES: readonly TicketSource[] = [
  "auto",
  "human",
  "workflow",
  "api",
  "escalation",
] as const;

export type TicketEventKind =
  | "created"
  | "assigned"
  | "unassigned"
  /** Handed to a different TEAM — distinct from `assigned`, which is a person. */
  | "team_changed"
  /** An internal note. The customer never sees it. */
  | "note"
  | "status_changed"
  | "priority_changed"
  | "subject_changed"
  /** The cause was edited. */
  | "description_changed"
  | "tag_added"
  | "tag_removed"
  | "field_changed"
  | "sla_breached"
  | "reopened"
  | "merged"
  /** This ticket was escalated to another workspace (source side). */
  | "escalated"
  /** Access was revoked — that workspace can no longer see the ticket. */
  | "escalation_revoked"
  /** A comment every workspace with access sees — the conversation BETWEEN the
   *  departments, as opposed to `note`, which stays in one workspace. */
  | "escalation_note"
  /** A file was attached / removed. */
  | "attachment_added"
  | "attachment_removed"
  /** Retired with the twin-pair design (2026-07-30). Old rows still render. */
  | "escalation_received"
  | "escalation_status"
  | "escalation_severed";

/** A tag as it renders on a ticket. Shared vocabulary with contact tags. */
export interface TicketTag {
  id: string;
  name: string;
  color: string;
}

/**
 * The SLA state of one ticket, computed server-side.
 *
 * Deliberately NOT "minutes remaining": the client renders a countdown from
 * `dueAt` against its own clock, so a tab left open overnight doesn't show a
 * number frozen at page load. `breached` is the stored fact, not a comparison —
 * once the sweeper flags a breach it stays flagged even if the due date is later
 * recomputed.
 */
export interface TicketSlaState {
  /** ISO. Null when the policy makes no commitment on this leg. */
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  /** ISO. Set the moment an agent first replies — stops the first-response leg. */
  firstResponseAt: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
  /**
   * True while the clock is parked (status is `on_hold`/`pending` and the policy
   * pauses there). The UI freezes the countdown rather than counting down to a
   * deadline that isn't advancing.
   */
  paused: boolean;
}

/**
 * One ticket, as the board / list / detail all render it.
 *
 * Assignee and contact NAMES are resolved server-side (not just ids) for the
 * same reason MessageFlag inlines its definition: a frame must be renderable
 * without the client holding the roster.
 */
export interface Ticket {
  id: string;
  /** Human-facing sequential id — what people quote to each other ("#1042"). */
  number: number;
  /**
   * The conversation THIS workspace can open. For the owner, the customer
   * thread the ticket was raised on. For a GUEST workspace on a shared ticket,
   * their OWN thread with that customer — null until they start one, because
   * the owner's conversation and messages are never exposed across the
   * workspace boundary.
   */
  conversationId: string | null;
  contactId: string | null;
  /** Falls back to the escalation snapshot's name when `contactId` is null. */
  contactName: string;
  channel: string;
  subject: string | null;
  /** The cause — why the ticket was raised, in the agent's words. WRITE-ONCE:
   *  fillable while empty, then immutable (`cause_immutable`) — everything
   *  after it reasons against it. Updates travel in the thread. */
  description: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  /**
   * Who owns YOUR side of this ticket. For the owning workspace that is the
   * ticket's assignee; for a workspace it was escalated to, their own — the
   * two departments do not share one accountable person (see
   * TicketSharingInfo.guests).
   */
  assignedUserId: string | null;
  assignedUserName: string | null;
  /**
   * The TEAM that currently owns this ticket (an Team id), or null.
   *
   * Independent of `assignedUserId`: a ticket handed to Sales sits in their
   * queue with no person on it until someone claims it. Both set means someone
   * on that team took it.
   */
  assignedTeamId: string | null;
  tags: TicketTag[];
  sla: TicketSlaState;
  /** ISO. Null until it reaches `solved`. */
  resolvedAt: string | null;
  /** ISO. Null until it reaches `closed`. */
  closedAt: string | null;
  resolvedById: string | null;
  resolvedByName: string | null;
  resolutionCode: string | null;
  resolutionNote: string | null;
  /** How many times it came back from `solved` — a high number means "solved" was optimistic. */
  reopenCount: number;
  source: TicketSource;
  /** Values keyed by TicketFieldDefinition.key. */
  customFields: Record<string, string>;
  /** Optimistic-concurrency token; send it back on a write to detect a stale edit. */
  version: number;
  /** Present only when the ticket has been escalated to another workspace. */
  sharing?: TicketSharingInfo;
  /** Files on the ticket, oldest first. Every party to a shared ticket sees
   *  all of them — the ticket is meant to carry the whole issue. */
  attachments: TicketAttachment[];
  /** ISO. */
  createdAt: string;
  /** ISO. */
  updatedAt: string;
  /**
   * When something last HAPPENED here — a reply, a file, a note, a status move.
   * ISO. The board sorts on it, and the client re-sorts a card locally when a
   * reply frame arrives, so it ships on every ticket read.
   */
  lastActivityAt: string;
}

/**
 * The customer's profile as it was AT ESCALATION time — a deliberate snapshot,
 * not a live join. The source workspace's directory stays private, and later
 * edits or deletes there never mutate what the target workspace was handed.
 */
export interface ContactSnapshot {
  name: string | null;
  phoneNumber: string | null;
  email: string | null;
  identityChannel: string;
  /** Values keyed by the SOURCE workspace's ContactFieldDefinition labels. */
  customFields: Record<string, string>;
}

/**
 * The cross-workspace sharing state of ONE ticket.
 *
 * A ticket is how two departments talk about one customer's issue, so there is
 * exactly one ticket — one number, one status, one history. Escalating grants a
 * sibling workspace access to it; it never copies it. This block says who has
 * access and, when the viewer is a guest, what they were handed of the customer.
 */
export interface TicketSharingInfo {
  /** What the VIEWING workspace is: the workspace that raised it, or one it
   *  was escalated to. */
  role: "owner" | "guest";
  /**
   * The workspace the viewer is reading from. `role` says WHAT they are; this
   * says WHICH — the difference matters as soon as a ticket has more than one
   * guest, because "is this row me?" is otherwise unanswerable on the client
   * (comparing a guest row against `ownerWorkspaceId` is never true, which is
   * how a guest lost the ability to hand its own access back).
   */
  viewerWorkspaceId: string;
  /** The workspace that owns the ticket (and the customer conversation). */
  ownerWorkspaceId: string;
  ownerWorkspaceName: string;
  /**
   * Every workspace this ticket has been escalated to, and who owns each
   * side. Visible to all parties — "waiting on Billing" is only actionable if
   * you can see whether anyone there has picked it up.
   */
  guests: Array<{
    workspaceId: string;
    workspaceName: string;
    sharedAt: string;
    assignedUserId: string | null;
    assignedUserName: string | null;
  }>;
  /**
   * The customer profile the viewer was handed, frozen at share time. Present
   * only for a GUEST — the owner reads the live contact instead. The owner's
   * conversation and messages are never exposed to a guest.
   */
  contactSnapshot?: ContactSnapshot;
}

/** A file on a ticket — attached at raise time, or with a later comment. */
export interface TicketAttachment {
  id: string;
  filename: string;
  mimeType: string;
  /** "image" | "video" | "audio" | "document" | "sticker". */
  kind: string;
  sizeBytes: number;
  /** Same-origin streaming URL — `/api/tickets/:ticketId/attachments/:id`. */
  url: string;
  /** The timeline entry it came in with. Only pre-2026-07-31 comment files —
   *  nothing writes it now. */
  eventId: string | null;
  /** The THREAD message it came in with, or null for a ticket-level file.
   *  A file belongs to the sentence that explains it, so the Files section
   *  shows only what has neither pointer. */
  messageId: string | null;
  uploadedById: string | null;
  uploadedByName: string | null;
  /** Which workspace added it — a shared ticket's files come from both. */
  workspaceName: string | null;
  /** ISO. */
  createdAt: string;
}

/**
 * One message in a ticket's THREAD — the conversation between the departments
 * working the issue.
 *
 * Distinct from `TicketEvent`, which is the audit log ("Ali changed the
 * status"). Mixing them is what made the answer to "what did Billing say?"
 * something you had to hunt for.
 *
 * Author identity is JOINED at read time, not snapshotted like
 * `TicketEvent.after`: an event describes a past state and must keep reading
 * correctly after a rename, whereas a chat author is a live identity that
 * should follow one. It is carried ON the message because the reader's roster
 * (`listTeamMembers`) only holds their OWN workspace — a guest cannot resolve
 * an owner-workspace author locally.
 */
export interface TicketThreadMessage {
  id: string;
  body: string;
  authorUserId: string | null;
  /** Null for an API-key/automation author — the UI renders "Automation". */
  authorName: string | null;
  authorAvatarUrl: string | null;
  authorWorkspaceId: string | null;
  /** Which department spoke. Rendered as a chip on a shared ticket. */
  authorWorkspaceName: string | null;
  attachments: TicketAttachment[];
  /** ISO. */
  createdAt: string;
  /** Echoed back so an optimistic row can be swapped for the real one. */
  clientTempId?: string;
  /** Client-only: an optimistic row still in flight / that failed to send. */
  pending?: boolean;
  failed?: boolean;
}

/** One timeline row on the ticket detail page. */
export interface TicketEvent {
  id: string;
  kind: TicketEventKind;
  /** Which workspace the actor was acting in — what makes a SHARED ticket's log
   *  readable ("Billing changed the status"). Null for older or system rows. */
  actorWorkspaceName?: string | null;
  /** Files that came in with this entry. */
  attachments?: TicketAttachment[];
  /** Note text, or the "why" on a handoff. Null on every other kind. */
  body?: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actorUserId: string | null;
  /** Resolved server-side; null for automation. */
  actorName: string | null;
  /** ISO. */
  createdAt: string;
}

/** The SLA commitment for one priority. `null` minutes = no commitment on that leg. */
export interface TicketSlaPolicy {
  id: string;
  priority: TicketPriority;
  firstResponseMins: number | null;
  resolutionMins: number | null;
  pauseOnHold: boolean;
  pauseWhenPending: boolean;
  businessHoursOnly: boolean;
  isActive: boolean;
}

/** A per-workspace custom field on a ticket. Mirrors ContactFieldDefinition. */
export interface TicketFieldDefinition {
  id: string;
  key: string;
  label: string;
  order: number;
  isVisible: boolean;
}

/** Board column counts, so the header badges don't need a second round-trip. */
export interface TicketCounts {
  /** Non-terminal tickets across the workspace. */
  totalActive: number;
  /** Non-terminal tickets assigned to the requesting user. */
  mineActive: number;
  /**
   * NEW WORK NOBODY HERE HAS PICKED UP — the number the nav badge shows.
   *
   * Deliberately not `byStatus.new`: a ticket escalated INTO this workspace
   * keeps whatever status it already had, so an `open` ticket handed to Billing
   * incremented nothing and the department only found it by looking at the
   * board. This counts both arrivals: our own untriaged tickets, and active
   * tickets shared with us that no one in this workspace has claimed.
   */
  untriaged: number;
  /** Active tickets another workspace escalated to us. */
  sharedWithUs: number;
  /**
   * Tickets where someone ELSE replied in the thread and this user hasn't
   * looked yet — the "you were answered" signal. Per-user, so it is 0 for an
   * API key (which has no agent identity), exactly like `mineActive`.
   */
  unreadReplies: number;
  /** Non-terminal tickets past a due date. */
  breached: number;
  /** Count keyed by status. Statuses with zero are omitted. */
  byStatus: Partial<Record<TicketStatus, number>>;
}

/**
 * Read caps on a ticket's detail lists. Newest-first fetch, no cursor: these
 * are the ceilings the UI names when a list is sitting on one, so the earliest
 * rows are not silently absent. Shared so the query and the notice can't drift.
 */
export const TICKET_NOTES_CAP = 200;
export const TICKET_EVENTS_CAP = 500;
