import { Prisma, type PrismaClient } from "@prisma/client";

import type { TicketPriority, TicketSource, TicketStatus } from "@ccp/shared/tickets/types";
import { isTicketActive, TICKET_ACTIVE_STATUSES } from "@ccp/shared/tickets/types";
import { asWorkHours } from "@ccp/shared/work-hours";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";
import { db as sharedDb } from "@/lib/db";

import { computeDueDates, isSlaPaused, shiftDueDates, type SlaPolicyInput } from "./sla";
import { mapTicket, TICKET_SELECT } from "./queries";
import type { Ticket } from "@ccp/shared/tickets/types";

/**
 * Write side of tickets — the ONLY place a `Ticket` row is created or changed,
 * and the only publisher of `ticket.changed`.
 *
 * Framework-agnostic (lib/): `db` is INJECTED, so the NestJS service, the /v1
 * service, the workflow steps, the ingest path and the SLA sweeper all share
 * one set of rules. Same durability contract as lib/message-flags/mutations.ts:
 * every mutation co-commits the row write, the `Conversation.openTicketCount`
 * maintenance, the `TicketEvent` audit row and the domain event inside ONE
 * `$transaction` via `publishInTx`, then calls `kickOutbox()` after commit.
 *
 * No NestJS exceptions are thrown from here — callers map the typed outcome to
 * their own error surface.
 */

type Db = Pick<
  PrismaClient,
  | "ticket"
  | "ticketEvent"
  | "ticketSlaPolicy"
  | "ticketNumberCounter"
  | "conversation"
  | "workspace"
  | "user"
  | "tag"
  // Handing a ticket to a team has to verify the team is this workspace's and
  // not archived — see assertWorkspaceTeam.
  | "assignmentPolicy"
  | "$transaction"
>;

type TxClient = Parameters<Parameters<Db["$transaction"]>[0]>[0];

/** Who is making the change. See FlagActor — same contract. */
export interface TicketActor {
  userId?: string | null;
  apiKeyId?: string | null;
}

interface EventGates {
  silent?: boolean;
  skipOutboundWebhook?: boolean;
}

export type TicketAction =
  | "created"
  | "assigned"
  /** Handed to a different team — a distinct action from assigning a person. */
  | "team_changed"
  | "status_changed"
  | "priority_changed"
  | "reopened"
  | "solved"
  | "closed"
  | "sla_breached"
  | "updated";

export type TicketOutcome =
  | { ok: true; ticket: Ticket; openTicketCount: number; action: TicketAction }
  | { ok: false; reason: "ticket_not_found" }
  | { ok: false; reason: "conversation_not_found" }
  | { ok: false; reason: "assignee_not_found" }
  | { ok: false; reason: "version_conflict" }
  | { ok: false; reason: "team_not_found" }
  | { ok: false; reason: "ticket_terminal" };

// ---------------------------------------------------------------------------
// Create.
// ---------------------------------------------------------------------------

export interface CreateTicketArgs extends EventGates {
  workspaceId: string;
  conversationId: string;
  actor: TicketActor;
  subject?: string | null;
  priority?: TicketPriority;
  assignedUserId?: string | null;
  /** Hand it straight to a team's queue (an AssignmentPolicy id). */
  assignedTeamId?: string | null;
  source?: TicketSource;
  tagIds?: string[];
  customFields?: Record<string, string>;
}

/**
 * Open a new ticket on a conversation and make it the active one.
 *
 * Retried once on a unique violation: `allocateNumber` serializes on the
 * counter row, but a workspace whose counter drifted behind an existing ticket
 * (a restored backup, a hand-inserted row) would collide on
 * `@@unique([workspaceId, number])`. A P2002 inside a Postgres transaction
 * poisons it, so the retry has to re-run the whole thing — by which point the
 * counter has advanced past the collision.
 */
export async function createTicket(db: Db, args: CreateTicketArgs): Promise<TicketOutcome> {
  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, workspaceId: args.workspaceId },
    select: { id: true, contactId: true, channel: true, assignedUserId: true },
  });
  if (!conversation) return { ok: false, reason: "conversation_not_found" };

  if (args.assignedUserId && !(await assertWorkspaceMember(db, args.workspaceId, args.assignedUserId))) {
    return { ok: false, reason: "assignee_not_found" };
  }

  // The team must belong to THIS workspace. Without the check a caller could
  // hand a ticket to another tenant's team id: the FK would accept it (it only
  // proves the row exists), and that team's queue would surface work whose
  // conversation they cannot open.
  if (args.assignedTeamId && !(await assertWorkspaceTeam(db, args.workspaceId, args.assignedTeamId))) {
    return { ok: false, reason: "team_not_found" };
  }

  return withUniqueRetry(() =>
    db
      .$transaction(async (tx) => {
        const created = await createTicketInTx(tx, args, conversation);
        return created;
      })
      .then((r) => {
        kickOutbox();
        return r;
      }),
  );
}

interface ConversationRef {
  id: string;
  contactId: string;
  channel: string;
  /** Inherited as the new ticket's owner when the caller names none. */
  assignedUserId?: string | null;
}

/**
 * The create, INSIDE a caller-supplied transaction. Split out because the
 * ingest path opens a ticket in the same transaction as the message write —
 * a message that exists with no ticket (or a ticket with no message) is exactly
 * the inconsistency `Message.ticketId` is meant to rule out.
 */
async function createTicketInTx(
  tx: TxClient,
  args: CreateTicketArgs,
  conversation: ConversationRef,
): Promise<Extract<TicketOutcome, { ok: true }>> {
  const priority = args.priority ?? "normal";
  // Inherit the thread's owner when the caller names none: the person already
  // working this conversation is the obvious owner of new work on it, and a
  // board full of unassigned cards on assigned threads helps nobody.
  // `assignedUserId: null` passed EXPLICITLY still means unassigned — hence the
  // `undefined` check rather than a falsy one.
  const assignedUserId =
    args.assignedUserId !== undefined ? args.assignedUserId : conversation.assignedUserId ?? null;
  const { policy, schedule } = await loadSlaContext(tx, args.workspaceId, priority);
  const now = Date.now();
  const due = computeDueDates(now, policy, schedule);
  const number = await allocateNumber(tx, args.workspaceId);

  // Drop any tag id that isn't this workspace's — connect-by-id doesn't filter.
  const safeTagIds = args.tagIds?.length
    ? await workspaceScopedTagIds(tx, args.workspaceId, args.tagIds)
    : [];

  const row = await tx.ticket.create({
    data: {
      workspaceId: args.workspaceId,
      number,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      channel: conversation.channel as Prisma.TicketCreateInput["channel"],
      subject: args.subject ?? null,
      priority,
      // An assigned-at-birth ticket is already being worked; only a genuinely
      // untouched one sits in `new`, which is what makes the untriaged backlog
      // reportable.
      status: assignedUserId ? "open" : "new",
      assignedUserId,
      lastAssignedUserId: assignedUserId,
      slaPolicyId: policy?.id ?? null,
      firstResponseDueAt: due.firstResponseDueAt,
      resolutionDueAt: due.resolutionDueAt,
      source: args.source ?? "auto",
      createdById: args.actor.userId ?? null,
      createdByApiKeyId: args.actor.apiKeyId ?? null,
      customFields: (args.customFields ?? {}) as Prisma.InputJsonValue,
      ...(safeTagIds.length ? { tags: { connect: safeTagIds.map((id) => ({ id })) } } : {}),
    },
    select: { id: true },
  });

  const openTicketCount = await bumpOpenTicketCount(tx, conversation.id, 1);
  await tx.conversation.update({
    where: { id: conversation.id },
    data: { activeTicketId: row.id },
  });

  const ticket = await readTicket(tx, row.id);
  await writeTicketEvent(tx, args.workspaceId, row.id, "created", args.actor, null, {
    number: ticket.number,
    subject: ticket.subject,
    priority: ticket.priority,
  });
  await writeConversationPill(tx, args.workspaceId, conversation.id, "ticket_opened", args.actor, ticket);
  await publishTicketEvent(tx, {
    args,
    ticket,
    openTicketCount,
    action: "created",
    previousStatus: null,
  });

  return { ok: true, ticket, openTicketCount, action: "created" };
}

// ---------------------------------------------------------------------------
// Message → ticket routing (the ingest chokepoint).
// ---------------------------------------------------------------------------

export interface RouteMessageArgs {
  workspaceId: string;
  conversationId: string;
  /** Inbound messages can reopen a solved ticket; outbound ones never do — an
   *  agent replying to close the loop must not resurrect the work item. */
  direction: "in" | "out";
  /** Injected for testability; the sweeper and the tests pass a fixed clock. */
  nowMs?: number;
}

export interface RouteMessageResult {
  ticketId: string | null;
  /** Set when the routing itself changed a ticket, so the caller can publish
   *  after its own transaction commits. Null when it simply attached. */
  opened: Extract<TicketOutcome, { ok: true }> | null;
}

/**
 * Decide which ticket a newly-arrived message belongs to, INSIDE the caller's
 * transaction.
 *
 * The rule, in order:
 *   1. An active (non-terminal) ticket on the thread → attach to it.
 *   2. Otherwise, a ticket SOLVED inside the workspace's reopen window → reopen
 *      it. This is the single most-debatable rule in ticketing (too short and
 *      one issue becomes three tickets; too long and a genuinely new question
 *      gets buried in resolved work), which is exactly why the window is a
 *      per-workspace setting rather than a constant.
 *   3. Otherwise, auto-open a new ticket — unless the workspace turned auto-open
 *      off, in which case the message simply carries no ticketId.
 *
 * Returns the ticket id to stamp on the message. Never throws for a
 * missing conversation: ingest must not fail because ticketing had a bad day.
 */
export async function routeMessageToTicket(
  tx: TxClient,
  args: RouteMessageArgs,
): Promise<RouteMessageResult> {
  const conversation = await tx.conversation.findFirst({
    where: { id: args.conversationId, workspaceId: args.workspaceId },
    select: {
      id: true,
      contactId: true,
      channel: true,
      activeTicketId: true,
      // Carried so an auto-opened ticket inherits the thread's owner (see
      // createTicketInTx). Without it the ingest path would always open
      // unassigned, defeating the inheritance for the commonest case.
      assignedUserId: true,
    },
  });
  if (!conversation) return { ticketId: null, opened: null };

  const workspace = await tx.workspace.findUnique({
    where: { id: args.workspaceId },
    select: { ticketAutoOpen: true, ticketReopenWindowHours: true },
  });

  if (conversation.activeTicketId) {
    const active = await tx.ticket.findFirst({
      where: { id: conversation.activeTicketId, workspaceId: args.workspaceId },
      select: { id: true, status: true },
    });
    // The pointer is only trusted while it points at live work. A ticket that
    // was solved leaves the pointer in place deliberately — that is what makes
    // the reopen window cheap to evaluate.
    if (active && isTicketActive(active.status)) {
      return { ticketId: active.id, opened: null };
    }
  }

  const now = args.nowMs ?? Date.now();
  const windowHours = workspace?.ticketReopenWindowHours ?? 72;
  if (args.direction === "in" && windowHours > 0) {
    const since = new Date(now - windowHours * 3_600_000);
    const solved = await tx.ticket.findFirst({
      where: {
        workspaceId: args.workspaceId,
        conversationId: conversation.id,
        status: "solved",
        lastSolvedAt: { gte: since },
      },
      orderBy: { lastSolvedAt: "desc" },
      select: { id: true },
    });
    if (solved) {
      const reopened = await reopenTicketInTx(tx, {
        workspaceId: args.workspaceId,
        ticketId: solved.id,
        conversationId: conversation.id,
        actor: {},
        nowMs: now,
      });
      return { ticketId: solved.id, opened: reopened };
    }
  }

  if (!workspace?.ticketAutoOpen) return { ticketId: null, opened: null };

  const opened = await createTicketInTx(
    tx,
    { workspaceId: args.workspaceId, conversationId: conversation.id, actor: {}, source: "auto" },
    conversation,
  );
  return { ticketId: opened.ticket.id, opened };
}

/**
 * Stamp the first-response clock when an agent replies.
 *
 * Called from the outbound path with the ticket the message was routed to. CAS
 * on `firstResponseAt: null` so an at-least-once redelivery, or two agents
 * replying at the same instant, can't move a stamped time — the first response
 * happened once.
 */
export async function markFirstResponse(
  tx: TxClient,
  workspaceId: string,
  ticketId: string,
  at: Date,
): Promise<void> {
  await tx.ticket.updateMany({
    where: { id: ticketId, workspaceId, firstResponseAt: null },
    data: { firstResponseAt: at },
  });
}

// ---------------------------------------------------------------------------
// Update.
// ---------------------------------------------------------------------------

export interface UpdateTicketArgs extends EventGates {
  workspaceId: string;
  ticketId: string;
  actor: TicketActor;
  /** Optimistic-concurrency token from the read. Omit to skip the check —
   *  automation (workflows, the SLA sweeper) has no stale view to protect. */
  expectedVersion?: number;
  status?: TicketStatus;
  priority?: TicketPriority;
  /** `null` unassigns. Omitted leaves the assignee alone. */
  assignedUserId?: string | null;
  /**
   * Hand the ticket to another TEAM; `null` takes it out of every queue.
   * Omitted leaves the team alone.
   *
   * Setting this clears `assignedUserId` unless the caller names one too — see
   * the reasoning at the write site.
   */
  assignedTeamId?: string | null;
  /** Why the ticket is being handed over. Stored on the `team_changed` event. */
  handoffReason?: string | null;
  subject?: string | null;
  resolutionCode?: string | null;
  resolutionNote?: string | null;
  tagIds?: string[];
  customFields?: Record<string, string>;
  nowMs?: number;
}

/**
 * Change a ticket. The one write path for every field an agent, a workflow, or
 * a /v1 partner can touch.
 *
 * The status transition drives everything else: the SLA clock parks and
 * resumes, `openTicketCount` moves, the conversation's active pointer follows,
 * and the emitted `action` names the TRANSITION rather than the post-state —
 * the lesson `message.flag_changed` learned the hard way, where deriving the
 * action from the final status both duplicated audit rows and lost every reopen.
 */
export async function updateTicket(db: Db, args: UpdateTicketArgs): Promise<TicketOutcome> {
  const existing = await db.ticket.findFirst({
    where: { id: args.ticketId, workspaceId: args.workspaceId },
    select: {
      id: true,
      version: true,
      status: true,
      priority: true,
      conversationId: true,
      // Snapshotted onto the team_changed event so the timeline reads
      // "Support → Sales" even after a rename.
      assignedTeamId: true,
      slaPolicyId: true,
      slaPausedAt: true,
      slaPausedMs: true,
      firstResponseDueAt: true,
      resolutionDueAt: true,
    },
  });
  if (!existing) return { ok: false, reason: "ticket_not_found" };
  if (args.expectedVersion !== undefined && args.expectedVersion !== existing.version) {
    return { ok: false, reason: "version_conflict" };
  }
  // Same tenancy check as create — the UPDATE path is the one a handoff
  // actually goes through, so omitting it here would leave the hole open on the
  // only route that matters.
  if (args.assignedTeamId && !(await assertWorkspaceTeam(db, args.workspaceId, args.assignedTeamId))) {
    return { ok: false, reason: "team_not_found" };
  }
  if (args.assignedUserId && !(await assertWorkspaceMember(db, args.workspaceId, args.assignedUserId))) {
    return { ok: false, reason: "assignee_not_found" };
  }

  const now = args.nowMs ?? Date.now();
  const result = await db.$transaction(async (tx) => {
    const nextStatus = args.status;
    const statusMoves = nextStatus !== undefined && nextStatus !== existing.status;

    const data: Prisma.TicketUncheckedUpdateInput = {
      ...(args.subject !== undefined ? { subject: args.subject } : {}),
      ...(args.resolutionCode !== undefined ? { resolutionCode: args.resolutionCode } : {}),
      ...(args.resolutionNote !== undefined ? { resolutionNote: args.resolutionNote } : {}),
      ...(args.customFields !== undefined
        ? { customFields: args.customFields as Prisma.InputJsonValue }
        : {}),
      version: { increment: 1 },
    };

    if (args.assignedUserId !== undefined) {
      data.assignedUserId = args.assignedUserId;
      // Continuity is never cleared — unassigning must not erase who handled it.
      if (args.assignedUserId) data.lastAssignedUserId = args.assignedUserId;
      // A `new` ticket that gets an owner is being worked; move it out of the
      // untriaged column unless the caller is explicitly setting a status too.
      if (args.assignedUserId && existing.status === "new" && !statusMoves) {
        data.status = "open";
      }
    }

    if (args.assignedTeamId !== undefined) {
      data.assignedTeamId = args.assignedTeamId;
      // Handing a ticket to another team CLEARS the current owner unless the
      // caller names one in the same breath. Keeping the old assignee would
      // leave it looking claimed by someone on the team that just handed it
      // away — so it sits in nobody's queue and nobody's list.
      if (args.assignedTeamId && args.assignedUserId === undefined) {
        data.assignedUserId = null;
      }
      // Same "it's being worked now" nudge as taking an assignee: a handed-over
      // ticket is not untriaged any more.
      if (args.assignedTeamId && existing.status === "new" && !statusMoves) {
        data.status = "open";
      }
    }

    const policyChanged = args.priority !== undefined && args.priority !== existing.priority;
    if (args.priority !== undefined) data.priority = args.priority;

    // ---- SLA clock ----
    const policy = await loadPolicyForPriority(
      tx,
      args.workspaceId,
      args.priority ?? existing.priority,
    );
    const finalStatus = nextStatus ?? (data.status as TicketStatus | undefined) ?? existing.status;
    const wasPaused = existing.slaPausedAt !== null;
    const shouldPause = isSlaPaused(finalStatus, policy) && isTicketActive(finalStatus);

    let pausedMsDelta = 0;
    if (wasPaused && !shouldPause) {
      // Resuming: bank the parked time and push both deadlines out by exactly
      // that much. Recomputing from scratch here would hand back a fresh full
      // commitment every time a ticket bounced through `on_hold`.
      pausedMsDelta = Math.max(0, now - existing.slaPausedAt!.getTime());
      data.slaPausedAt = null;
      data.slaPausedMs = { increment: pausedMsDelta };
      const shifted = shiftDueDates(
        {
          firstResponseDueAt: existing.firstResponseDueAt,
          resolutionDueAt: existing.resolutionDueAt,
        },
        pausedMsDelta,
      );
      data.firstResponseDueAt = shifted.firstResponseDueAt;
      data.resolutionDueAt = shifted.resolutionDueAt;
    } else if (!wasPaused && shouldPause) {
      data.slaPausedAt = new Date(now);
    }

    if (policyChanged) {
      // A priority change is a NEW commitment measured from now — that is what
      // escalating a ticket means. The already-banked pause time stays banked.
      const schedule = await loadSchedule(tx, args.workspaceId);
      const recomputed = computeDueDates(now, policy, schedule);
      data.slaPolicyId = policy?.id ?? null;
      // Preserve the resume-shift we may have just applied above.
      data.firstResponseDueAt = recomputed.firstResponseDueAt;
      data.resolutionDueAt = recomputed.resolutionDueAt;
    }

    // ---- Lifecycle ----
    if (statusMoves) {
      data.status = nextStatus;
      if (nextStatus === "solved") {
        data.resolvedAt = new Date(now);
        data.lastSolvedAt = new Date(now);
        data.resolvedById = args.actor.userId ?? null;
      } else if (nextStatus === "closed") {
        data.closedAt = new Date(now);
        // Closing straight from an active state is still a resolution — without
        // this, a ticket taken new → closed would report no resolution time at
        // all and drop out of every "time to resolve" report.
        if (existing.status !== "solved") {
          data.resolvedAt = new Date(now);
          data.resolvedById = args.actor.userId ?? null;
        }
      } else if (!isTicketActive(existing.status)) {
        // Coming BACK from solved/closed — a reopen. Wipe the resolution so a
        // stale "solved by Sara three weeks ago" can't sit on live work.
        data.resolvedAt = null;
        data.closedAt = null;
        data.resolvedById = null;
        data.reopenCount = { increment: 1 };
      }
    }

    // NOTE: tags are deliberately NOT in `data`. `updateMany` takes scalars
    // only — a relation write here is accepted by the (XOR-unioned) types and
    // then throws at runtime. It is applied as a second `update` below, after
    // the CAS has proven we own the transition.

    // CAS on the status we read: the write only lands if nobody moved the
    // lifecycle in between, so the counter below can't drift.
    const written = await tx.ticket.updateMany({
      where: { id: existing.id, status: existing.status },
      data: data as Prisma.TicketUncheckedUpdateManyInput,
    });
    if (written.count === 0) {
      // Someone else moved it first. Report the conflict rather than reapplying
      // against a state the caller never saw — an unconditional retry here is
      // how a "set to pending" silently overwrites a colleague's "closed".
      return { conflict: true as const };
    }

    if (args.tagIds !== undefined) {
      // Scope to this workspace's tags — `set` by id doesn't filter, so a
      // foreign id would attach another workspace's tag. Empty stays empty
      // (clears all tags), which is the intended meaning of `tagIds: []`.
      const safeTagIds = await workspaceScopedTagIds(tx, args.workspaceId, args.tagIds);
      await tx.ticket.update({
        where: { id: existing.id },
        data: { tags: { set: safeTagIds.map((id) => ({ id })) } },
      });
    }

    const wasActive = isTicketActive(existing.status);
    const nowActive = isTicketActive(finalStatus);
    const delta = wasActive === nowActive ? 0 : nowActive ? 1 : -1;
    const openTicketCount = await bumpOpenTicketCount(tx, existing.conversationId, delta);

    // The conversation's active pointer follows the lifecycle: a ticket that
    // left the active set stops receiving messages, and one that came back
    // takes the pointer again.
    if (statusMoves) {
      if (nowActive) {
        await tx.conversation.update({
          where: { id: existing.conversationId },
          data: { activeTicketId: existing.id },
        });
      } else {
        // Clear ONLY if we are the pointer — another ticket may already own it.
        await tx.conversation.updateMany({
          where: { id: existing.conversationId, activeTicketId: existing.id },
          data: { activeTicketId: null },
        });
      }
    }

    const ticket = await readTicket(tx, existing.id);
    const action = deriveAction(existing.status, statusMoves ? finalStatus : null, args);
    await writeTicketEvent(
      tx,
      args.workspaceId,
      existing.id,
      ticketEventKindFor(action, args),
      args.actor,
      // Snapshot the team on both sides so the timeline reads "Support → Sales"
      // even after a team is renamed or archived.
      { status: existing.status, priority: existing.priority, teamId: existing.assignedTeamId },
      { status: ticket.status, priority: ticket.priority, teamId: ticket.assignedTeamId },
      // The "why" on a handoff. A handoff with no reason is the most common way
      // this workflow fails — the receiving team re-reads the whole thread to
      // work out what was wanted.
      args.handoffReason ?? null,
    );
    const pill = conversationPillFor(existing.status, statusMoves ? finalStatus : null);
    if (pill) {
      await writeConversationPill(tx, args.workspaceId, existing.conversationId, pill, args.actor, ticket);
    }
    await publishTicketEvent(tx, {
      args,
      ticket,
      openTicketCount,
      action,
      previousStatus: existing.status,
    });
    return { conflict: false as const, ticket, openTicketCount, action };
  });

  if (result.conflict) return { ok: false, reason: "version_conflict" };
  kickOutbox();
  return {
    ok: true,
    ticket: result.ticket,
    openTicketCount: result.openTicketCount,
    action: result.action,
  };
}

/**
 * Reopen a solved ticket from inside a transaction — used by the ingest router
 * when a follow-up lands inside the reopen window.
 *
 * Kept separate from `updateTicket` because it must compose into the message
 * write's transaction: the reopen and the message that caused it commit
 * together or not at all.
 */
async function reopenTicketInTx(
  tx: TxClient,
  args: {
    workspaceId: string;
    ticketId: string;
    conversationId: string;
    actor: TicketActor;
    nowMs: number;
  },
): Promise<Extract<TicketOutcome, { ok: true }> | null> {
  const written = await tx.ticket.updateMany({
    where: { id: args.ticketId, workspaceId: args.workspaceId, status: "solved" },
    data: {
      status: "open",
      resolvedAt: null,
      resolvedById: null,
      reopenCount: { increment: 1 },
      version: { increment: 1 },
    },
  });
  // Lost the race — another inbound reopened it a moment earlier. Not an error:
  // the message still attaches to the (now open) ticket.
  if (written.count === 0) return null;

  const openTicketCount = await bumpOpenTicketCount(tx, args.conversationId, 1);
  await tx.conversation.update({
    where: { id: args.conversationId },
    data: { activeTicketId: args.ticketId },
  });

  const ticket = await readTicket(tx, args.ticketId);
  await writeTicketEvent(tx, args.workspaceId, args.ticketId, "reopened", args.actor, {
    status: "solved",
  }, { status: "open" });
  await writeConversationPill(
    tx,
    args.workspaceId,
    args.conversationId,
    "ticket_reopened",
    args.actor,
    ticket,
  );
  await publishTicketEvent(tx, {
    args: { workspaceId: args.workspaceId, actor: args.actor },
    ticket,
    openTicketCount,
    action: "reopened",
    previousStatus: "solved",
  });
  return { ok: true, ticket, openTicketCount, action: "reopened" };
}

/**
 * Flag an SLA breach. Called only by the sweeper.
 *
 * CAS on the not-yet-breached state so an at-least-once sweep, or two overlapping
 * sweeper runs, produce exactly one breach event — a partner's "SLA missed"
 * webhook firing every 60 seconds until someone answers would be worse than not
 * firing at all.
 */
export async function markSlaBreached(
  db: Db,
  args: {
    workspaceId: string;
    ticketId: string;
    leg: "first_response" | "resolution";
  },
): Promise<TicketOutcome> {
  const result = await db.$transaction(async (tx) => {
    const written = await tx.ticket.updateMany({
      where:
        args.leg === "first_response"
          ? { id: args.ticketId, workspaceId: args.workspaceId, firstResponseBreached: false }
          : { id: args.ticketId, workspaceId: args.workspaceId, resolutionBreached: false },
      data:
        args.leg === "first_response"
          ? { firstResponseBreached: true }
          : { resolutionBreached: true },
    });
    if (written.count === 0) return null;

    const ticket = await readTicket(tx, args.ticketId);
    const conversation = await tx.conversation.findUnique({
      where: { id: ticket.conversationId },
      select: { openTicketCount: true },
    });
    await writeTicketEvent(tx, args.workspaceId, args.ticketId, "sla_breached", {}, null, {
      leg: args.leg,
    });
    await publishInTx(tx, {
      type: "ticket.changed",
      workspaceId: args.workspaceId,
      ticketId: ticket.id,
      conversationId: ticket.conversationId,
      contactId: ticket.contactId,
      action: "sla_breached",
      ticket,
      previousStatus: ticket.status,
      breachedLeg: args.leg,
      openTicketCount: conversation?.openTicketCount ?? 0,
      changedByUserId: null,
    });
    return { ticket, openTicketCount: conversation?.openTicketCount ?? 0 };
  });

  if (!result) return { ok: false, reason: "ticket_not_found" };
  kickOutbox();
  return {
    ok: true,
    ticket: result.ticket,
    openTicketCount: result.openTicketCount,
    action: "sla_breached",
  };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Take the next ticket number for this workspace.
 *
 * The `update … increment` takes a row lock, so Postgres blocks the second
 * concurrent allocator until the first commits — two simultaneous creates can
 * never read the same value. `upsert` seeds the counter on a workspace's first
 * ever ticket without a separate provisioning step.
 */
async function allocateNumber(tx: TxClient, workspaceId: string): Promise<number> {
  const row = await tx.ticketNumberCounter.upsert({
    where: { workspaceId },
    create: { workspaceId, next: 2 },
    update: { next: { increment: 1 } },
    select: { next: true },
  });
  // `create` seeded next=2 and handed out 1; `update` returns the POST-increment
  // value, so the number just handed out is one less.
  return row.next - 1;
}

async function readTicket(tx: TxClient, id: string): Promise<Ticket> {
  const row = await tx.ticket.findUniqueOrThrow({ where: { id }, select: TICKET_SELECT });
  return mapTicket(row);
}

interface LoadedPolicy extends SlaPolicyInput {
  id: string;
}

async function loadPolicyForPriority(
  tx: TxClient,
  workspaceId: string,
  priority: TicketPriority,
): Promise<LoadedPolicy | null> {
  const row = await tx.ticketSlaPolicy.findFirst({
    where: { workspaceId, priority, isActive: true },
    select: {
      id: true,
      firstResponseMins: true,
      resolutionMins: true,
      pauseOnHold: true,
      pauseWhenPending: true,
      businessHoursOnly: true,
    },
  });
  return row;
}

async function loadSchedule(tx: TxClient, workspaceId: string) {
  const ws = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { workHours: true },
  });
  return asWorkHours(ws?.workHours);
}

/** The policy AND the schedule in one place — a `businessHoursOnly` policy is
 *  useless without the workspace's hours, and loading them apart invited a
 *  caller to forget the second one. */
async function loadSlaContext(tx: TxClient, workspaceId: string, priority: TicketPriority) {
  const policy = await loadPolicyForPriority(tx, workspaceId, priority);
  const schedule = policy?.businessHoursOnly ? await loadSchedule(tx, workspaceId) : null;
  return { policy, schedule };
}

/**
 * Move `Conversation.openTicketCount` by `delta` and return the result.
 *
 * `delta === 0` still reads the column: the event payload always carries the
 * authoritative count, so an idempotent replay must not ship an invented number
 * to the inbox badge. The clamp mirrors `bumpOpenFlagCount` — a counter driven
 * negative by drift would make the `> 0` filter start hiding threads.
 */
async function bumpOpenTicketCount(
  tx: TxClient,
  conversationId: string,
  delta: number,
): Promise<number> {
  if (delta === 0) {
    const row = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: { openTicketCount: true },
    });
    return row?.openTicketCount ?? 0;
  }
  const updated = await tx.conversation.update({
    where: { id: conversationId },
    data: { openTicketCount: { increment: delta } },
    select: { openTicketCount: true },
  });
  if (updated.openTicketCount >= 0) return updated.openTicketCount;
  await tx.conversation.update({ where: { id: conversationId }, data: { openTicketCount: 0 } });
  return 0;
}

/** Derive the TRANSITION, never the post-state. See the header comment. */
function deriveAction(
  previous: TicketStatus,
  next: TicketStatus | null,
  args: UpdateTicketArgs,
): TicketAction {
  if (next) {
    if (next === "solved") return "solved";
    if (next === "closed") return "closed";
    if (!isTicketActive(previous)) return "reopened";
    return "status_changed";
  }
  // Checked BEFORE `assignedUserId`: a handoff usually clears the assignee in
  // the same write, and filing that as "unassigned" would hide the thing that
  // actually happened.
  if (args.assignedTeamId !== undefined) return "team_changed";
  if (args.assignedUserId !== undefined) return "assigned";
  if (args.priority !== undefined) return "priority_changed";
  return "updated";
}

/**
 * The timeline row this change earns. Derived from the same `action` the event
 * carries, so the audit row and the webhook can never disagree about what
 * happened — deriving them separately is how a "note edited" ends up filed as a
 * second resolution.
 */
function ticketEventKindFor(
  action: TicketAction,
  args: UpdateTicketArgs,
): Prisma.TicketEventCreateInput["kind"] {
  switch (action) {
    case "team_changed":
      return "team_changed";
    case "assigned":
      return args.assignedUserId ? "assigned" : "unassigned";
    case "priority_changed":
      return "priority_changed";
    case "reopened":
      return "reopened";
    case "status_changed":
    case "solved":
    case "closed":
      return "status_changed";
    default:
      return args.subject !== undefined ? "subject_changed" : "field_changed";
  }
}

/** Which inbox pill (if any) this transition earns. Only boundaries that change
 *  what the THREAD means cross over; the full history stays on TicketEvent. */
function conversationPillFor(
  previous: TicketStatus,
  next: TicketStatus | null,
): "ticket_solved" | "ticket_reopened" | "ticket_closed" | null {
  if (!next) return null;
  if (next === "solved") return "ticket_solved";
  if (next === "closed") return "ticket_closed";
  if (!isTicketActive(previous)) return "ticket_reopened";
  return null;
}

async function writeTicketEvent(
  tx: TxClient,
  workspaceId: string,
  ticketId: string,
  kind: Prisma.TicketEventCreateInput["kind"],
  actor: TicketActor,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  /** Note text, or the "why" on a handoff. */
  body?: string | null,
): Promise<void> {
  await tx.ticketEvent.create({
    data: {
      workspaceId,
      ticketId,
      kind,
      before: (before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      after: (after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      ...(body ? { body } : {}),
      actorUserId: actor.userId ?? null,
      actorApiKeyId: actor.apiKeyId ?? null,
    },
  });
}

/**
 * Add an internal note to a ticket. The customer never sees it.
 *
 * This is the other half of a team handoff: Sales receives a ticket and answers
 * "tell them their order ships Tuesday" WITHOUT messaging the customer
 * themselves. Without it the receiving team's only options are to say nothing or
 * to contact the customer directly — and a handoff that forces the second one
 * isn't a handoff, it's a transfer.
 *
 * Deliberately NOT a ticket UPDATE: a note changes nothing about the ticket, so
 * it must not bump `version` (which would 409 a colleague's open editor) or move
 * the SLA clock. It appends to the timeline and nothing else.
 */
export async function addTicketNote(
  db: Db,
  args: {
    workspaceId: string;
    ticketId: string;
    actor: TicketActor;
    body: string;
  },
): Promise<{ ok: true } | { ok: false; reason: "ticket_not_found" | "empty_note" }> {
  const body = args.body.trim();
  if (!body) return { ok: false, reason: "empty_note" };

  // Scoped read — a ticket id from another workspace must 404, not append.
  const ticket = await db.ticket.findFirst({
    where: { id: args.ticketId, workspaceId: args.workspaceId },
    select: { id: true },
  });
  if (!ticket) return { ok: false, reason: "ticket_not_found" };

  await db.ticketEvent.create({
    data: {
      workspaceId: args.workspaceId,
      ticketId: args.ticketId,
      kind: "note",
      body,
      actorUserId: args.actor.userId ?? null,
      actorApiKeyId: args.actor.apiKeyId ?? null,
    },
  });
  return { ok: true };
}

/**
 * Write the inline conversation-timeline pill.
 *
 * Written HERE rather than by the audit subscriber, because the pill must
 * commit with the ticket change: a thread showing "solved" for a ticket the
 * transaction rolled back is worse than no pill at all. The values are
 * snapshotted (number, subject) so the pill keeps reading correctly after a
 * rename — the same rule as tag_added.
 */
async function writeConversationPill(
  tx: TxClient,
  workspaceId: string,
  conversationId: string,
  kind: "ticket_opened" | "ticket_solved" | "ticket_reopened" | "ticket_closed",
  actor: TicketActor,
  ticket: Ticket,
): Promise<void> {
  await tx.conversationEvent.create({
    data: {
      workspaceId,
      conversationId,
      kind,
      userId: actor.userId ?? null,
      apiKeyId: actor.apiKeyId ?? null,
      after: {
        ticketId: ticket.id,
        number: ticket.number,
        subject: ticket.subject,
        status: ticket.status,
      } as Prisma.InputJsonValue,
    },
  });
}

async function publishTicketEvent(
  tx: TxClient,
  params: {
    args: EventGates & { workspaceId: string; actor: TicketActor };
    ticket: Ticket;
    openTicketCount: number;
    action: TicketAction;
    previousStatus: TicketStatus | null;
  },
): Promise<void> {
  const { args, ticket, openTicketCount, action, previousStatus } = params;
  await publishInTx(tx, {
    type: "ticket.changed",
    workspaceId: args.workspaceId,
    ticketId: ticket.id,
    conversationId: ticket.conversationId,
    contactId: ticket.contactId,
    action,
    ticket,
    previousStatus,
    openTicketCount,
    changedByUserId: args.actor.userId ?? null,
    changedByApiKeyId: args.actor.apiKeyId ?? null,
    ...(args.silent !== undefined ? { silent: args.silent } : {}),
    ...(args.skipOutboundWebhook !== undefined
      ? { skipOutboundWebhook: args.skipOutboundWebhook }
      : {}),
  });
}

/** An assignee must be a live member of THIS workspace — otherwise a crafted id
 *  could hand work to someone in another tenant. */
/**
 * Does this team (AssignmentPolicy) belong to this workspace, and is it live?
 *
 * The FK alone only proves the row exists — it says nothing about WHOSE it is.
 * A handoff to another tenant's team id would otherwise be accepted and put
 * work in a queue whose members cannot open the conversation behind it.
 * Archived teams are refused too: handing work to a disbanded queue is a silent
 * way to lose it.
 */
async function assertWorkspaceTeam(
  db: Db,
  workspaceId: string,
  policyId: string,
): Promise<boolean> {
  const policy = await db.assignmentPolicy.findFirst({
    where: { id: policyId, workspaceId, archivedAt: null },
    select: { id: true },
  });
  return Boolean(policy);
}

async function assertWorkspaceMember(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const user = await db.user.findFirst({
    where: { id: userId, workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
    select: { id: true },
  });
  return Boolean(user);
}

/**
 * Narrow a caller-supplied set of tag ids to the ones that actually belong to
 * this workspace.
 *
 * Prisma's `tags: { connect: [{ id }] }` / `{ set: [{ id }] }` connect by id
 * with NO workspace filter, so an id from another workspace would attach that
 * workspace's tag (its name/color then renders on this ticket — a cross-tenant
 * leak, and a dangling cross-workspace reference). Foreign ids are dropped
 * rather than erroring, matching how saved-view / workflow tag handling treats
 * ids that don't resolve.
 */
async function workspaceScopedTagIds(
  db: Db,
  workspaceId: string,
  tagIds: string[],
): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const rows = await db.tag.findMany({
    where: { id: { in: tagIds }, workspaceId },
    select: { id: true },
  });
  return rows.map((t) => t.id);
}

async function withUniqueRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return fn();
    }
    throw err;
  }
}

export { TICKET_ACTIVE_STATUSES };


/**
 * Give a conversation's ACTIVE ticket the same owner as the thread — but only
 * when it has none.
 *
 * Exists because of an ordering fact, not a preference: auto-assignment runs
 * DETACHED in the background tier, after ingest has already opened the ticket.
 * Without this, every auto-opened ticket on an auto-assigned thread would sit
 * unassigned forever and the board's "Mine" filter would be empty for everyone.
 *
 * FILL-EMPTY-ONLY, never a reassignment: a ticket can legitimately belong to
 * someone other than whoever owns the thread (an escalation handed to a
 * specialist), and dragging it along with the conversation would take work away
 * from the person doing it — §18's "automated assignment never overrides a
 * human", applied to the ticket.
 *
 * Reads the SHARED db rather than taking an injected one, so `assignConversation`
 * keeps its narrow three-delegate `Db` contract instead of every one of its
 * callers having to know about ticketing. Same posture as ingest.ts.
 */
export async function fillActiveTicketAssignee(
  workspaceId: string,
  conversationId: string,
  userId: string,
): Promise<void> {
  const conv = await sharedDb.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { activeTicketId: true },
  });
  if (!conv?.activeTicketId) return;
  const ticket = await sharedDb.ticket.findFirst({
    where: { id: conv.activeTicketId, workspaceId, assignedUserId: null },
    select: { id: true },
  });
  if (!ticket) return;
  await updateTicket(sharedDb, {
    workspaceId,
    ticketId: ticket.id,
    actor: {},
    assignedUserId: userId,
    // Loop safety: this write is a CONSEQUENCE of an assignment that already
    // published its own events. Letting it chain-trigger workflows or echo a
    // partner webhook would announce one human action twice (§9).
    silent: true,
    skipOutboundWebhook: true,
  });
}
