import { db } from "@/lib/db";
import { createTicket, updateTicket } from "@/lib/tickets/mutations";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from "@ccp/shared/tickets/types";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
  envelopeConversation,
} from "./types";

/**
 * Ticket steps: `create_ticket`, `set_ticket_status`, `set_ticket_priority`,
 * `assign_ticket`.
 *
 * All four act on the conversation's ACTIVE ticket (or open one). None takes a
 * ticket id: a workflow runs in the context of one conversation, and letting it
 * name an arbitrary ticket would let workflow A silently reach into work that
 * belongs to a different thread — a whole class of cross-tenant-shaped bugs the
 * envelope scoping otherwise rules out.
 *
 * Every mutation goes through lib/tickets/mutations, so a workflow-driven
 * change is indistinguishable downstream from an agent's — same CAS, same
 * counters, same events. `silent: true` on every publish so a step inside
 * workflow X can't chain-trigger workflow Y mid-run (§9 loop safety); use the
 * `trigger_workflow` step when that IS the intent.
 *
 * `expectedVersion` is deliberately NOT sent: automation has no stale view to
 * protect, and a version conflict would fail a step for a race it can't see.
 */

/** The active ticket on the envelope's conversation, or null. */
async function activeTicketId(
  workspaceId: string,
  conversationId: string,
): Promise<string | null> {
  const row = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { activeTicketId: true },
  });
  return row?.activeTicketId ?? null;
}

// ---------------------------------------------------------------------------
// create_ticket
// ---------------------------------------------------------------------------

export interface CreateTicketStepConfig {
  subject?: string | null;
  priority?: TicketPriority;
  /**
   * Skip when the thread already has live work (the default). Off by default
   * because the common shape — "open a ticket when a VIP messages" — must not
   * mint a second ticket on every follow-up message in the same conversation.
   */
  onlyIfNoActiveTicket?: boolean;
}

export const createTicketStepHandler: StepHandler<CreateTicketStepConfig> = {
  type: "create_ticket",
  sideEffect: "irreversible",
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const priority = r.priority as TicketPriority | undefined;
    if (priority && !TICKET_PRIORITIES.includes(priority)) {
      throw new StepConfigError(
        `create_ticket.priority must be one of ${TICKET_PRIORITIES.join(", ")}`,
      );
    }
    const subject = typeof r.subject === "string" ? r.subject.slice(0, 200) : null;
    return {
      subject,
      ...(priority ? { priority } : {}),
      // Default ON: see the config comment.
      onlyIfNoActiveTicket: r.onlyIfNoActiveTicket !== false,
    };
  },
  describeConfig(config) {
    return config.subject ? `Open ticket "${config.subject}"` : "Open a ticket";
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    const conv = envelopeConversation(envelope);
    if (!conv) return advanceWithError(400, "envelope missing conversation");

    if (config.onlyIfNoActiveTicket) {
      const existing = await activeTicketId(ctx.workspaceId, conv.id);
      if (existing) return advance({ skipped: "already_has_active_ticket", ticketId: existing });
    }

    const outcome = await createTicket(db, {
      workspaceId: ctx.workspaceId,
      conversationId: conv.id,
      actor: {},
      source: "workflow",
      subject: config.subject ?? null,
      ...(config.priority ? { priority: config.priority } : {}),
      silent: true,
    });
    if (!outcome.ok) return advanceWithError(404, outcome.reason);
    return advance({ ticketId: outcome.ticket.id, number: outcome.ticket.number });
  },
};

// ---------------------------------------------------------------------------
// set_ticket_status / set_ticket_priority
// ---------------------------------------------------------------------------

export interface SetTicketStatusStepConfig {
  status: TicketStatus;
  resolutionCode?: string | null;
}

export const setTicketStatusStepHandler: StepHandler<SetTicketStatusStepConfig> = {
  type: "set_ticket_status",
  sideEffect: "irreversible",
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const status = r.status as TicketStatus | undefined;
    if (!status || !TICKET_STATUSES.includes(status)) {
      throw new StepConfigError(
        `set_ticket_status.status must be one of ${TICKET_STATUSES.join(", ")}`,
      );
    }
    return {
      status,
      resolutionCode: typeof r.resolutionCode === "string" ? r.resolutionCode.slice(0, 80) : null,
    };
  },
  describeConfig(config) {
    return `Set ticket status to ${config.status}`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    return mutateActiveTicket(envelope, ctx, {
      status: config.status,
      ...(config.resolutionCode ? { resolutionCode: config.resolutionCode } : {}),
    });
  },
};

export interface SetTicketPriorityStepConfig {
  priority: TicketPriority;
}

export const setTicketPriorityStepHandler: StepHandler<SetTicketPriorityStepConfig> = {
  type: "set_ticket_priority",
  sideEffect: "irreversible",
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const priority = r.priority as TicketPriority | undefined;
    if (!priority || !TICKET_PRIORITIES.includes(priority)) {
      throw new StepConfigError(
        `set_ticket_priority.priority must be one of ${TICKET_PRIORITIES.join(", ")}`,
      );
    }
    return { priority };
  },
  describeConfig(config) {
    return `Set ticket priority to ${config.priority}`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    // A priority change re-computes the SLA due dates from now — that IS what
    // escalating means, and it's the same behaviour an agent gets in the UI.
    return mutateActiveTicket(envelope, ctx, { priority: config.priority });
  },
};

// ---------------------------------------------------------------------------
// assign_ticket
// ---------------------------------------------------------------------------

export type AssignTicketStepConfig =
  | { mode: "user"; userId: string; overwrite: boolean }
  | { mode: "unassign" };

export const assignTicketStepHandler: StepHandler<AssignTicketStepConfig> = {
  type: "assign_ticket",
  sideEffect: "irreversible",
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (r.mode === "unassign") return { mode: "unassign" };
    const userId = typeof r.userId === "string" ? r.userId : "";
    if (!userId) throw new StepConfigError("assign_ticket.userId is required");
    // Same rule as assign_to and every other automated assignment: fill an
    // EMPTY slot by default, so automation can never quietly take work away
    // from the person doing it (CLAUDE.md §18).
    return { mode: "user", userId, overwrite: r.overwrite === true };
  },
  describeConfig(config) {
    return config.mode === "unassign" ? "Unassign the ticket" : "Assign the ticket";
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    const conv = envelopeConversation(envelope);
    if (!conv) return advanceWithError(400, "envelope missing conversation");
    const ticketId = await activeTicketId(ctx.workspaceId, conv.id);
    if (!ticketId) return advance({ skipped: "no_active_ticket" });

    if (config.mode === "user" && !config.overwrite) {
      const current = await db.ticket.findFirst({
        where: { id: ticketId, workspaceId: ctx.workspaceId },
        select: { assignedUserId: true },
      });
      if (current?.assignedUserId) {
        return advance({ skipped: "already_assigned", ticketId });
      }
    }

    return applyTicketUpdate(ctx.workspaceId, ticketId, {
      assignedUserId: config.mode === "unassign" ? null : config.userId,
    });
  },
};

// ---------------------------------------------------------------------------
// Shared.
// ---------------------------------------------------------------------------

async function mutateActiveTicket(
  envelope: Parameters<StepHandler["run"]>[0],
  ctx: Parameters<StepHandler["run"]>[2],
  patch: Record<string, unknown>,
): Promise<StepResult> {
  const conv = envelopeConversation(envelope);
  if (!conv) return advanceWithError(400, "envelope missing conversation");
  const ticketId = await activeTicketId(ctx.workspaceId, conv.id);
  // No live work on this thread is a normal state, not an error — the workflow
  // continues rather than failing the run.
  if (!ticketId) return advance({ skipped: "no_active_ticket" });
  return applyTicketUpdate(ctx.workspaceId, ticketId, patch);
}

async function applyTicketUpdate(
  workspaceId: string,
  ticketId: string,
  patch: Record<string, unknown>,
): Promise<StepResult> {
  const outcome = await updateTicket(db, {
    workspaceId,
    ticketId,
    actor: {},
    silent: true,
    ...patch,
  });
  if (!outcome.ok) {
    if (outcome.reason === "ticket_not_found") return advanceWithError(404, "ticket not found");
    if (outcome.reason === "assignee_not_found") {
      return advanceWithError(400, "assignee is not a member of this workspace");
    }
    // A concurrent change won the CAS. Degrade rather than fail the run: the
    // thing the step asked for is either already true or has been superseded by
    // a human, and failing a whole workflow over that helps nobody.
    return advance({ skipped: "changed_by_someone_else", ticketId });
  }
  return advance({
    ticketId,
    status: outcome.ticket.status,
    priority: outcome.ticket.priority,
    action: outcome.action,
  });
}
