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
  // Status changes and deletes MIRROR onto the escalation twin (escalations.ts
  // owns the pair; this file only writes the mirror rows).
  | "ticketEscalation"
  | "$transaction"
>;

export type TxClient = Parameters<Parameters<Db["$transaction"]>[0]>[0];

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
  | "updated"
  /** The ticket was permanently deleted. The board removes the card; the
   *  detail view redirects. Messages survive (SetNull), events cascade. */
  | "deleted"
  /** Escalated to another workspace (fired on the SOURCE side). */
  | "escalated"
  /** The TWIN in the other workspace changed — this side gained a mirrored
   *  timeline row; its own lifecycle did NOT move. */
  | "escalation_update";

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
  /** The cause — why the ticket is being raised, for the team that receives it. */
  description?: string | null;
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
      description: args.description ?? null,
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
    description: ticket.description,
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
 *   3. Otherwise, the message carries no ticketId. There is NO auto-open
 *      (removed 2026-07-25): a ticket is a deliberate act — raised by an agent
 *      or a workflow's `create_ticket` step, never minted just because a
 *      customer messaged.
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
      // (assignedUserId was selected here for the auto-open owner-inheritance
      // path; auto-open was removed 2026-07-25 and nothing read it since.)
    },
  });
  if (!conversation) return { ticketId: null, opened: null };

  const workspace = await tx.workspace.findUnique({
    where: { id: args.workspaceId },
    select: { ticketReopenWindowHours: true },
  });

  if (conversation.activeTicketId) {
    const active = await tx.ticket.findFirst({
      where: { id: conversation.activeTicketId, workspaceId: args.workspaceId },
      select: { id: true, status: true },
    });
    // The pointer is only trusted while it points at live work.
    if (active && isTicketActive(active.status)) {
      return { ticketId: active.id, opened: null };
    }
  }

  // Pointer null or stale — but the ROUTING RULE is "an active ticket on the
  // thread → attach" (docs/ticketing.md §2 rule 1), and the pointer is only a
  // hot-path cache of it. With two tickets raised on one thread, solving the
  // pointer-holder left the OTHER active ticket invisible here: the fall-
  // through went straight to the reopen query and resurrected the solved one
  // while live work sat unroutable until its SLA breached. Scan, attach to the
  // newest active, and repair the pointer.
  const fallbackActive = await tx.ticket.findFirst({
    where: {
      workspaceId: args.workspaceId,
      conversationId: conversation.id,
      status: { in: TICKET_ACTIVE_STATUSES as TicketStatus[] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (fallbackActive) {
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { activeTicketId: fallbackActive.id },
    });
    return { ticketId: fallbackActive.id, opened: null };
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

  // No auto-open. A ticket is a deliberate act — raised by an agent from the
  // inbox (the "Raise a ticket" button) or by a workflow's `create_ticket`
  // step, never minted just because a customer messaged. So an inbound either
  // ATTACHES to the thread's live ticket, REOPENS a recently-solved one inside
  // the window, or leaves the thread ticket-free (the inbox already tracks it).
  return { ticketId: null, opened: null };
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
   * Only land the write if the ticket is UNASSIGNED at write time — in the
   * CAS where, not a pre-read. Set by `fillActiveTicketAssignee`: fill-empty-
   * only is §18's "automation never overrides a human" applied to the ticket,
   * and a pre-read alone left a window in which a human handing the ticket to
   * a specialist was silently overwritten by the thread-owner fill.
   */
  onlyIfUnassigned?: boolean;
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
  /** Edit the cause. Emits `description_changed` on the timeline. */
  description?: string | null;
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
      ...(args.description !== undefined ? { description: args.description } : {}),
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

    if (policyChanged && isTicketActive(finalStatus)) {
      // A priority change is a NEW commitment measured from now — that is what
      // escalating a ticket means. The already-banked pause time stays banked.
      // Gated on an active final status: recomputing deadlines "from now" on a
      // solved/closed ticket would arm the sweeper against finished work.
      const schedule = await loadSchedule(tx, args.workspaceId);
      const recomputed = computeDueDates(now, policy, schedule);
      data.slaPolicyId = policy?.id ?? null;
      data.firstResponseDueAt = recomputed.firstResponseDueAt;
      data.resolutionDueAt = recomputed.resolutionDueAt;
      // If the ticket is currently paused (escalated while on_hold), the new
      // commitment starts NOW — re-anchor the pause marker, or the eventual
      // resume would shift the fresh deadlines by hold time that predates the
      // escalation (deadlines pushed out by the entire pre-escalation park).
      if (wasPaused && shouldPause) data.slaPausedAt = new Date(now);
    }

    // ---- Lifecycle ----
    if (statusMoves) {
      data.status = nextStatus;
      if (nextStatus === "solved") {
        data.resolvedAt = new Date(now);
        data.lastSolvedAt = new Date(now);
        data.resolvedById = args.actor.userId ?? null;
        // closed → solved is a correction, not a second life: without this the
        // ticket reported as BOTH closed and solved (closedAt kept) while
        // becoming ingest-reopenable via the fresh lastSolvedAt.
        if (existing.status === "closed") data.closedAt = null;
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
        // A reopen is a FRESH commitment measured from now. The stored due
        // dates belong to the previous life: a ticket solved on time and
        // reopened past its old `resolutionDueAt` was instantly (and
        // permanently) breach-flagged for a promise that was kept. Breach
        // flags that genuinely fired before stay set — history, not state.
        const schedule = await loadSchedule(tx, args.workspaceId);
        const recomputed = computeDueDates(now, policy, schedule);
        data.firstResponseDueAt = recomputed.firstResponseDueAt;
        data.resolutionDueAt = recomputed.resolutionDueAt;
      }
    }

    // NOTE: tags are deliberately NOT in `data`. `updateMany` takes scalars
    // only — a relation write here is accepted by the (XOR-unioned) types and
    // then throws at runtime. It is applied as a second `update` below, after
    // the CAS has proven we own the transition.

    // CAS on the status we read: the write only lands if nobody moved the
    // lifecycle in between, so the counter below can't drift. When the caller
    // supplied `expectedVersion`, it goes IN the where too — the JS pre-check
    // above is only a fast path, and without the version here two concurrent
    // non-status writes (assign vs re-prioritize, or two customFields edits —
    // a whole-map replace) both passed the pre-check and the last writer
    // silently erased the first, defeating the documented 409 contract.
    const written = await tx.ticket.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        ...(args.expectedVersion !== undefined ? { version: args.expectedVersion } : {}),
        ...(args.onlyIfUnassigned ? { assignedUserId: null } : {}),
      },
      data: data as Prisma.TicketUncheckedUpdateManyInput,
    });
    if (written.count === 0) {
      // Someone else moved it first. Report the conflict rather than reapplying
      // against a state the caller never saw — an unconditional retry here is
      // how a "set to pending" silently overwrites a colleague's "closed".
      return { conflict: true as const };
    }

    let tagDiff: { added: TagSnapshot[]; removed: TagSnapshot[] } | null = null;
    if (args.tagIds !== undefined) {
      // Read the pre-set tags WITH names so the timeline can say which tag
      // moved (snapshotted — history keeps reading after a rename).
      const current = await tx.ticket.findUniqueOrThrow({
        where: { id: existing.id },
        select: { tags: { select: { id: true, name: true, color: true } } },
      });
      // Scope to this workspace's tags — `set` by id doesn't filter, so a
      // foreign id would attach another workspace's tag. Empty stays empty
      // (clears all tags), which is the intended meaning of `tagIds: []`.
      const safeTagIds = await workspaceScopedTagIds(tx, args.workspaceId, args.tagIds);
      await tx.ticket.update({
        where: { id: existing.id },
        data: { tags: { set: safeTagIds.map((id) => ({ id })) } },
      });
      const nextIds = new Set(safeTagIds);
      const currentIds = new Set(current.tags.map((t) => t.id));
      const addedIds = safeTagIds.filter((id) => !currentIds.has(id));
      tagDiff = {
        added: addedIds.length
          ? await tx.tag.findMany({
              where: { id: { in: addedIds }, workspaceId: args.workspaceId },
              select: { id: true, name: true, color: true },
            })
          : [],
        removed: current.tags.filter((t) => !nextIds.has(t.id)),
      };
    }

    const wasActive = isTicketActive(existing.status);
    const nowActive = isTicketActive(finalStatus);
    const delta = wasActive === nowActive ? 0 : nowActive ? 1 : -1;
    // An escalated-in ticket has no conversation until "Message customer"
    // binds one — there is no counter or pointer to maintain until then.
    const openTicketCount = existing.conversationId
      ? await bumpOpenTicketCount(tx, existing.conversationId, delta)
      : 0;

    // The conversation's active pointer follows the lifecycle: a ticket that
    // left the active set stops receiving messages, and one that came back
    // takes the pointer again.
    if (statusMoves && existing.conversationId) {
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

    // Tag edits earn their own timeline verbs — the generic `field_changed`
    // used to swallow them, leaving "something changed" where the reader needs
    // "the VIP tag was removed". Snapshotted name/color, same rule as the
    // conversation audit's tag rows.
    const tagEvents = tagDiff ? tagDiff.added.length + tagDiff.removed.length : 0;
    if (tagDiff) {
      for (const tag of tagDiff.added) {
        await writeTicketEvent(tx, args.workspaceId, existing.id, "tag_added", args.actor, null, {
          tagId: tag.id,
          name: tag.name,
          color: tag.color,
        });
      }
      for (const tag of tagDiff.removed) {
        await writeTicketEvent(tx, args.workspaceId, existing.id, "tag_removed", args.actor, null, {
          tagId: tag.id,
          name: tag.name,
          color: tag.color,
        });
      }
    }
    // Skip the generic row only when tags were the ONLY change AND the diff
    // actually produced rows — otherwise the write would leave no trace at all.
    const tagsOnly =
      tagEvents > 0 &&
      action === "updated" &&
      args.subject === undefined &&
      args.description === undefined &&
      args.customFields === undefined &&
      args.resolutionCode === undefined &&
      args.resolutionNote === undefined;
    if (!tagsOnly) {
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
    }
    const pill = conversationPillFor(existing.status, statusMoves ? finalStatus : null);
    if (pill && existing.conversationId) {
      await writeConversationPill(tx, args.workspaceId, existing.conversationId, pill, args.actor, ticket);
    }
    await publishTicketEvent(tx, {
      args,
      ticket,
      openTicketCount,
      action,
      previousStatus: existing.status,
    });
    // A lifecycle move mirrors onto the escalation twin ("they solved it"), so
    // the other workspace's timeline and board learn without any cross-
    // workspace read. The mirrored row + frame are each scoped to the TWIN's
    // own workspace. Non-status edits deliberately do not mirror — the shared
    // comment thread is the channel for words.
    if (statusMoves) {
      await mirrorStatusToTwin(tx, existing.id, ticket, args.actor);
    }
    return { conflict: false as const, ticket, openTicketCount, action };
  });

  if (result.conflict) return { ok: false, reason: "version_conflict" };
  kickOutbox();

  // `Workspace.ticketCloseConversationOnLastSolved`: solving the LAST active
  // ticket closes the thread. Detached, best-effort, and AFTER the ticket tx
  // (a close failure must not fail the solve). Applies to every solve path —
  // agent, workflow set_ticket_status, /v1 — because this is the one write
  // path they all share. Dynamic import: conversations/mutations already
  // imports this module (fillActiveTicketAssignee), so a static back-import
  // would be a cycle.
  // (`conversationId` null = an unbound escalated-in ticket — no thread to close.)
  const closableConversationId = result.ticket.conversationId;
  if (result.action === "solved" && result.openTicketCount === 0 && closableConversationId) {
    void (async () => {
      const ws = await sharedDb.workspace.findUnique({
        where: { id: args.workspaceId },
        select: { ticketCloseConversationOnLastSolved: true },
      });
      if (!ws?.ticketCloseConversationOnLastSolved) return;
      const { setConversationStatus } = await import("@/lib/conversations/mutations");
      const { publish } = await import("@/lib/events/bus");
      await setConversationStatus({
        db: sharedDb,
        publish,
        workspaceId: args.workspaceId,
        conversationId: closableConversationId,
        status: "closed",
        changedByUserId: args.actor.userId ?? null,
      });
    })().catch((err) => {
      console.warn(
        `[tickets] close-on-last-solved failed for conversation ${result.ticket.conversationId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

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
  // Fresh SLA commitment for the reopened life — same reasoning as the
  // updateTicket reopen branch: the stored due dates belong to the previous
  // life, and a reopen past the old `resolutionDueAt` instantly breach-flagged
  // a promise that was kept.
  const row = await tx.ticket.findFirst({
    where: { id: args.ticketId, workspaceId: args.workspaceId, status: "solved" },
    select: { priority: true },
  });
  if (!row) return null;
  const policy = await loadPolicyForPriority(tx, args.workspaceId, row.priority);
  const schedule = await loadSchedule(tx, args.workspaceId);
  const recomputed = computeDueDates(args.nowMs, policy, schedule);

  const written = await tx.ticket.updateMany({
    where: { id: args.ticketId, workspaceId: args.workspaceId, status: "solved" },
    data: {
      status: "open",
      resolvedAt: null,
      resolvedById: null,
      reopenCount: { increment: 1 },
      version: { increment: 1 },
      firstResponseDueAt: recomputed.firstResponseDueAt,
      resolutionDueAt: recomputed.resolutionDueAt,
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
    // The CAS repeats the sweeper's FULL scan predicate, not just the flag:
    // between the scan and this write (a per-row loop over up to 200 rows) an
    // agent can reply, solve, or pause the ticket — and a flag-only CAS still
    // stamped a permanent breach + partner webhook for a promise that was
    // kept. `now` is re-read here so the due date must STILL be past.
    const now = new Date();
    const stillLate =
      args.leg === "first_response"
        ? {
            firstResponseBreached: false,
            firstResponseAt: null,
            firstResponseDueAt: { lt: now },
          }
        : { resolutionBreached: false, resolutionDueAt: { lt: now } };
    const written = await tx.ticket.updateMany({
      where: {
        id: args.ticketId,
        workspaceId: args.workspaceId,
        status: { in: TICKET_ACTIVE_STATUSES as TicketStatus[] },
        slaPausedAt: null,
        ...stillLate,
      },
      data:
        args.leg === "first_response"
          ? { firstResponseBreached: true }
          : { resolutionBreached: true },
    });
    if (written.count === 0) return null;

    const ticket = await readTicket(tx, args.ticketId);
    // An escalated-in ticket can carry SLA due dates with no conversation yet.
    const conversation = ticket.conversationId
      ? await tx.conversation.findUnique({
          where: { id: ticket.conversationId },
          select: { openTicketCount: true },
        })
      : null;
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
export async function allocateNumber(tx: TxClient, workspaceId: string): Promise<number> {
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

export interface DeleteTicketArgs extends EventGates {
  workspaceId: string;
  ticketId: string;
  actor: TicketActor;
}

/**
 * Permanently delete a ticket.
 *
 * A destructive escape hatch for work raised by mistake — distinct from
 * `solved`/`closed`, which keep the ticket for reporting. The database FKs do
 * the careful part: `Message.ticketId` is SetNull (the customer's messages
 * survive, merely unlinked), `Conversation.activeTicketId` is SetNull (the
 * pointer clears itself), and `TicketEvent` cascades (the timeline goes with the
 * ticket it described). All we own here is the denormalized `openTicketCount` —
 * decrement it when the deleted ticket was still counting as open — and the
 * `deleted` frame so the board drops the card and the detail view exits.
 */
export async function deleteTicket(
  db: Db,
  args: DeleteTicketArgs,
): Promise<{ ok: false; reason: "not_found" } | { ok: true }> {
  const existing = await db.ticket.findFirst({
    where: { id: args.ticketId, workspaceId: args.workspaceId },
    select: { id: true, status: true, conversationId: true },
  });
  if (!existing) return { ok: false, reason: "not_found" };

  await db.$transaction(async (tx) => {
    // Snapshot BEFORE the delete — the `deleted` frame carries it so subscribers
    // know which card to drop without re-reading a row that's about to vanish.
    // The snapshot is also the counter authority: deciding the decrement from
    // the PRE-transaction read let a concurrent solve double-decrement
    // `openTicketCount` (solve −1, delete −1 on the stale "active"), and no
    // drift sweeper exists for this counter.
    const snapshot = await readTicket(tx, existing.id);

    const openTicketCount = existing.conversationId
      ? await bumpOpenTicketCount(
          tx,
          existing.conversationId,
          isTicketActive(snapshot.status) ? -1 : 0,
        )
      : 0;

    // Sever the escalation link BEFORE the delete: the twin's timeline must
    // record that its counterpart is gone (the row itself cascades or SetNulls
    // with the delete, so this is the last moment the pair is readable).
    await severTwinLink(tx, existing.id, snapshot, args.actor);

    // Cascade removes TicketEvents; SetNull unlinks Messages and clears the
    // conversation's activeTicketId. One delete, all side effects handled by FKs.
    await tx.ticket.delete({ where: { id: existing.id } });

    await publishTicketEvent(tx, {
      args,
      ticket: snapshot,
      openTicketCount,
      action: "deleted",
      previousStatus: existing.status,
    });
  });
  kickOutbox();
  return { ok: true };
}

export async function readTicket(tx: TxClient, id: string): Promise<Ticket> {
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
export async function loadSlaContext(tx: TxClient, workspaceId: string, priority: TicketPriority) {
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
export async function bumpOpenTicketCount(
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
      // Subject and the cause each get their own timeline verb; a change to
      // both at once (or to custom fields) falls back to the generic
      // `field_changed`. Subject wins the tie because it is the ticket's title.
      if (args.subject !== undefined) return "subject_changed";
      if (args.description !== undefined) return "description_changed";
      return "field_changed";
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

export async function writeTicketEvent(
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

export async function publishTicketEvent(
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

interface TagSnapshot {
  id: string;
  name: string;
  color: string;
}

/**
 * The escalation twin of a ticket, from either side. Null when the ticket is
 * not part of a pair, or when the pair is severed. The names are read here so
 * the mirrored rows can snapshot "who said it" without a join at render time.
 */
async function findEscalationTwin(
  tx: TxClient,
  ticketId: string,
): Promise<{ twinId: string; twinWorkspaceId: string; fromWorkspaceName: string } | null> {
  const escalation = await tx.ticketEscalation.findFirst({
    where: { OR: [{ sourceTicketId: ticketId }, { targetTicketId: ticketId }] },
    select: {
      sourceTicketId: true,
      targetTicketId: true,
      sourceWorkspaceId: true,
      targetWorkspaceId: true,
      sourceWorkspace: { select: { name: true } },
      targetWorkspace: { select: { name: true } },
    },
  });
  if (!escalation) return null;
  const isSource = escalation.sourceTicketId === ticketId;
  const twinId = isSource ? escalation.targetTicketId : escalation.sourceTicketId;
  if (!twinId) return null; // severed — the origin was deleted
  return {
    twinId,
    twinWorkspaceId: isSource ? escalation.targetWorkspaceId : escalation.sourceWorkspaceId,
    fromWorkspaceName: isSource
      ? escalation.sourceWorkspace.name
      : escalation.targetWorkspace.name,
  };
}

/**
 * Publish `ticket.changed { action: "escalation_update" }` about a twin whose
 * timeline just gained a mirrored row. The frame is scoped to the TWIN's own
 * workspace room by the existing fanout rule — no cross-workspace emit exists.
 * `silent`: the twin's own state did not move; a mirrored notification must
 * never chain-trigger workflows or echo a partner webhook as if it had (§9).
 */
async function publishTwinUpdate(tx: TxClient, twinWorkspaceId: string, twinId: string, actor: TicketActor): Promise<void> {
  const twin = await readTicket(tx, twinId);
  const openTicketCount = twin.conversationId
    ? await bumpOpenTicketCount(tx, twin.conversationId, 0)
    : 0;
  await publishInTx(tx, {
    type: "ticket.changed",
    workspaceId: twinWorkspaceId,
    ticketId: twin.id,
    conversationId: twin.conversationId,
    contactId: twin.contactId,
    action: "escalation_update",
    ticket: twin,
    previousStatus: twin.status,
    openTicketCount,
    changedByUserId: actor.userId ?? null,
    changedByApiKeyId: actor.apiKeyId ?? null,
    silent: true,
    skipOutboundWebhook: true,
  });
}

/** Mirror a lifecycle move onto the escalation twin's timeline. */
async function mirrorStatusToTwin(
  tx: TxClient,
  ticketId: string,
  ticket: Ticket,
  actor: TicketActor,
): Promise<void> {
  const twin = await findEscalationTwin(tx, ticketId);
  if (!twin) return;
  await writeTicketEvent(tx, twin.twinWorkspaceId, twin.twinId, "escalation_status", actor, null, {
    status: ticket.status,
    fromWorkspaceName: twin.fromWorkspaceName,
    // "They solved it" is only half the answer — carry the outcome so the
    // source agent can relay it without asking.
    resolutionCode: ticket.resolutionCode,
    resolutionNote: ticket.resolutionNote,
  });
  await publishTwinUpdate(tx, twin.twinWorkspaceId, twin.twinId, actor);
}

/** Record on the twin that its counterpart is being deleted. */
async function severTwinLink(
  tx: TxClient,
  ticketId: string,
  snapshot: Ticket,
  actor: TicketActor,
): Promise<void> {
  const twin = await findEscalationTwin(tx, ticketId);
  if (!twin) return;
  await writeTicketEvent(tx, twin.twinWorkspaceId, twin.twinId, "escalation_severed", actor, null, {
    deletedTicketNumber: snapshot.number,
    fromWorkspaceName: twin.fromWorkspaceName,
  });
  await publishTwinUpdate(tx, twin.twinWorkspaceId, twin.twinId, actor);
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

export async function withUniqueRetry<T>(fn: () => Promise<T>): Promise<T> {
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
    // Race-proof fill-empty-only: the null-assignee read above is only a fast
    // path — this puts the emptiness check in the write's own CAS, so a human
    // assigning the ticket mid-flight wins and the fill becomes a no-op (§18).
    onlyIfUnassigned: true,
    // Loop safety: this write is a CONSEQUENCE of an assignment that already
    // published its own events. Letting it chain-trigger workflows or echo a
    // partner webhook would announce one human action twice (§9).
    silent: true,
    skipOutboundWebhook: true,
  });
}
