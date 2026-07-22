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
 *  - `auto`     — opened by an inbound message on a thread with no active ticket
 *  - `human`    — an agent
 *  - `workflow` — a workflow step
 *  - `api`      — an external /v1 integration
 */
export type TicketSource = "auto" | "human" | "workflow" | "api";

export const TICKET_SOURCES: readonly TicketSource[] = ["auto", "human", "workflow", "api"] as const;

export type TicketEventKind =
  | "created"
  | "assigned"
  | "unassigned"
  | "status_changed"
  | "priority_changed"
  | "subject_changed"
  | "tag_added"
  | "tag_removed"
  | "field_changed"
  | "sla_breached"
  | "reopened"
  | "merged";

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
  conversationId: string;
  contactId: string;
  contactName: string;
  channel: string;
  subject: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  assignedUserId: string | null;
  assignedUserName: string | null;
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
  /** ISO. */
  createdAt: string;
  /** ISO. */
  updatedAt: string;
}

/** One timeline row on the ticket detail page. */
export interface TicketEvent {
  id: string;
  kind: TicketEventKind;
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
