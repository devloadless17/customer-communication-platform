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
 *  - `new`     — auto-opened, nobody has picked it up. Distinct from `open` so
 *                an untriaged backlog is reportable separately from a worked one.
 *  - `open`    — actively being worked.
 *  - `pending` — waiting on the CUSTOMER.
 *  - `on_hold` — waiting on US, deliberately parked (escalation, part on order).
 *  - `solved`  — done, but inside the reopen window: a follow-up message lands
 *                back on THIS ticket instead of opening a new one.
 *  - `closed`  — terminal. A message after this always opens a new ticket.
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
  /** This ticket WAS the escalation — its birth event on the target side. */
  | "escalation_received"
  /** A comment shared across the escalation pair — BOTH workspaces see it. */
  | "escalation_note"
  /** The twin ticket's status changed in the other workspace. */
  | "escalation_status"
  /** The twin ticket was deleted — the link is gone. */
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
   * Null ONLY on an escalated-in ticket (source `escalation`) before the target
   * workspace binds its own conversation via "Message customer". Every other
   * ticket is born bound to a thread.
   */
  conversationId: string | null;
  contactId: string | null;
  /** Falls back to the escalation snapshot's name when `contactId` is null. */
  contactName: string;
  channel: string;
  subject: string | null;
  /** The cause — why the ticket was raised, in the agent's words. Set at
   *  creation, editable, read by whoever the ticket is handed to. */
  description: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  assignedUserId: string | null;
  assignedUserName: string | null;
  /**
   * The TEAM that currently owns this ticket (an AssignmentPolicy id), or null.
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
  /** Present when this ticket is one side of a cross-workspace escalation pair. */
  escalation?: TicketEscalationInfo;
  /** ISO. */
  createdAt: string;
  /** ISO. */
  updatedAt: string;
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
 * One side's view of a cross-workspace escalation pair. The two tickets stay
 * workspace-scoped; this is the only cross-workspace data either side sees —
 * a sibling workspace's NAME plus the twin's number and status.
 */
export interface TicketEscalationInfo {
  id: string;
  /** Which side of the pair THIS ticket is. */
  role: "source" | "target";
  /** The sibling workspace — id + name so "Open it there" can switch this
   *  device's active workspace and deep-link the twin. */
  otherWorkspaceId: string;
  otherWorkspaceName: string;
  /** Null when severed (the twin was deleted). */
  otherTicketId: string | null;
  otherTicketNumber: number | null;
  otherTicketStatus: TicketStatus | null;
  /** True when the twin ticket no longer exists. */
  severed: boolean;
  /** Only on the TARGET side — the customer profile handed over at escalation. */
  contactSnapshot?: ContactSnapshot;
}

/** One timeline row on the ticket detail page. */
export interface TicketEvent {
  id: string;
  kind: TicketEventKind;
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
  /** Non-terminal tickets past a due date. */
  breached: number;
  /** Count keyed by status. Statuses with zero are omitted. */
  byStatus: Partial<Record<TicketStatus, number>>;
}
