import { Prisma, type PrismaClient } from "@prisma/client";

import type { TicketPriority, TicketSource, TicketStatus } from "@ccp/shared/tickets/types";
import { isTicketActive, TICKET_ACTIVE_STATUSES } from "@ccp/shared/tickets/types";
import { asWorkHours } from "@ccp/shared/work-hours";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";
import { notifyUsers, ticketAudience } from "@/lib/notifications/notifications";
import { db as sharedDb } from "@/lib/db";

import { ticketByIdWhere } from "./access";
import { resolveActorDisplayName } from "@/lib/workspaces/operator-mask";
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
  | "team"
  | "$transaction"
>;

export type TxClient = Parameters<Parameters<Db["$transaction"]>[0]>[0];

/** Who is making the change. See FlagActor — same contract. */
export interface TicketActor {
  userId?: string | null;
  apiKeyId?: string | null;
  /**
   * The workspace the actor is acting IN. On a shared ticket this is not
   * necessarily the ticket's owning workspace — it is the department that did
   * the thing, and it is what the timeline attributes the entry to.
   */
  workspaceId?: string | null;
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
  /** Shared with another workspace — the ticket gained a participant. */
  | "escalated"
  /** A change to the SHARING or the ATTACHMENTS of the ticket; its own
   *  lifecycle did not move (a comment, a file, an access grant/revoke). */
  | "escalation_update";

export type TicketOutcome =
  | { ok: true; ticket: Ticket; openTicketCount: number; action: TicketAction }
  | { ok: false; reason: "ticket_not_found" }
  | { ok: false; reason: "conversation_not_found" }
  | { ok: false; reason: "assignee_not_found" }
  | { ok: false; reason: "version_conflict" }
  | { ok: false; reason: "team_not_found" }
  | { ok: false; reason: "ticket_terminal" }
  /** The cause is WRITTEN ONCE — it can be filled in while empty, never
   *  rewritten. History moves forward through comments and notes instead. */
  | { ok: false; reason: "cause_immutable" }
  | { ok: false; reason: "tags_owner_only" }
  | { ok: false; reason: "teams_owner_only" }
  /** `requireNoActiveTicket` was asked for and the thread already has one.
   *  Raced-safe: decided by a CAS on the pointer, not a prior read. */
  | { ok: false; reason: "already_has_active_ticket" };

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
  /** Hand it straight to a team's queue (an Team id). */
  assignedTeamId?: string | null;
  source?: TicketSource;
  tagIds?: string[];
  customFields?: Record<string, string>;
  /**
   * Refuse if the thread already has an active ticket — decided ATOMICALLY.
   *
   * A caller that checks `Conversation.activeTicketId` first and then creates
   * has a read-then-write window: two inbound messages a few ms apart put two
   * workflow runs through the gap together, and the thread ends up with two
   * open tickets, one of which is no longer anybody's `activeTicketId`. So the
   * guard is a CAS on the pointer inside this transaction instead — the loser
   * rolls its ticket back rather than discovering the collision afterwards.
   */
  requireNoActiveTicket?: boolean;
}

/**
 * Open a new ticket on a conversation and make it the active one.
 *
 * Retried once on a unique violation: `allocateNumber` serializes on the
 * counter row, but a workspace whose counter drifted behind an existing ticket
 * (a restored backup, a hand-inserted row) would collide on
 * `@@unique([workspaceId, number])`. A P2002 inside a Postgres transaction
 * poisons it, so the retry has to re-run the whole thing — including a FRESH
 * allocation, by which point the counter has advanced past the collision.
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

  try {
    return await withUniqueRetry(async () => {
      // Allocated BEFORE the transaction opens, so the counter's row lock is held
      // for one statement rather than for the whole create — see allocateNumber's
      // header for the measurement that motivated this and for why a burnt number
      // is the sanctioned tradeoff. Inside the retry, so a P2002 re-allocates
      // (which is the entire point of retrying).
      const number = await allocateNumber(db, args.workspaceId);
      const created = await db.$transaction(async (tx) =>
        createTicketInTx(tx, args, conversation, number),
      );
      kickOutbox();

      // The BELL for an assigned-at-birth ticket. `updateTicket` already tells
      // a NEW assignee they own something; a ticket RAISED onto someone (an
      // explicit pick, or inheriting the conversation's owner — the default)
      // was handed over in silence, and they found out by going to look, which
      // is precisely what the bell exists to end. After the transaction,
      // best-effort, never the actor — the same three rules as every other
      // notification here.
      const assignee = created.ok ? created.ticket.assignedUserId : null;
      if (created.ok && assignee && assignee !== (args.actor.userId ?? null)) {
        void (async () => {
          // OPERATOR MASK: the bell row is append-only, so the name must be
          // masked at WRITE time (lib/workspaces/operator-mask.ts).
          const actorName = args.actor.userId
            ? await resolveActorDisplayName(sharedDb, args.actor.userId, [args.workspaceId])
            : null;
          await notifyUsers(sharedDb, {
            kind: "ticket_assigned",
            recipients: [{ userId: assignee, workspaceId: args.workspaceId }],
            actorUserId: args.actor.userId ?? null,
            actorName,
            ticketId: created.ticket.id,
            ticketNumber: created.ticket.number,
            ticketSubject: created.ticket.subject,
            summary: "assigned this ticket to you",
          });
        })().catch(() => undefined);
      }
      return created;
    });
  } catch (err) {
    // The CAS lost — a concurrent create claimed the thread first. Its
    // transaction rolled back, so nothing was written; this is a normal
    // outcome, not a failure. Caught OUTSIDE the transaction (a Postgres tx is
    // aborted by the failing statement, so nothing may be read inside it — the
    // trap this repo has hit four times).
    if (err instanceof ActiveTicketRaceLost) {
      return { ok: false, reason: "already_has_active_ticket" };
    }
    throw err;
  }
}

/** Internal signal: the `requireNoActiveTicket` CAS found the pointer taken. */
class ActiveTicketRaceLost extends Error {
  constructor() {
    super("active_ticket_race_lost");
    this.name = "ActiveTicketRaceLost";
  }
}

interface ConversationRef {
  id: string;
  contactId: string;
  channel: string;
  /** Inherited as the new ticket's owner when the caller names none. */
  assignedUserId?: string | null;
}

/**
 * The create, INSIDE the caller's transaction.
 *
 * `number` is allocated by the caller, OUTSIDE this transaction, so the
 * counter's row lock does not span everything below — see `allocateNumber`.
 *
 * (This used to say it was split out "because the ingest path opens a ticket in
 * the same transaction as the message write". That has not been true since
 * auto-open was removed on 2026-07-25 (and auto-reopen on 2026-08-01): ingest
 * only ATTACHES, and `createTicket` is now the sole caller.)
 */
async function createTicketInTx(
  tx: TxClient,
  args: CreateTicketArgs,
  conversation: ConversationRef,
  number: number,
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
      // Validated above and then silently DROPPED until 2026-08-02 — the raise
      // dialog's "Send to team" returned a 201 with the ticket in nobody's
      // queue. The one column the whole team-queue feature hangs on.
      assignedTeamId: args.assignedTeamId ?? null,
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
  if (args.requireNoActiveTicket) {
    // CAS: claim the pointer only while it is still free. `updateMany` so a
    // miss is a count of 0 rather than a throw, and the throw below is what
    // rolls this whole transaction (ticket row included) back.
    const claimed = await tx.conversation.updateMany({
      where: { id: conversation.id, activeTicketId: null },
      data: { activeTicketId: row.id },
    });
    if (claimed.count === 0) throw new ActiveTicketRaceLost();
  } else {
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { activeTicketId: row.id },
    });
  }

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
}

export interface RouteMessageResult {
  ticketId: string | null;
}

/**
 * Decide which ticket a newly-arrived message belongs to, INSIDE the caller's
 * transaction.
 *
 * The rule, whole:
 *   1. An active (non-terminal) ticket on the thread → attach to it.
 *   2. Otherwise, the message carries no ticketId.
 *
 * NOTHING here opens a ticket, and nothing here reopens one. Auto-open went on
 * 2026-07-25; auto-REOPEN went on 2026-08-01 — a customer's follow-up used to
 * drag a solved ticket back to `open` with a "System reopened #10" line nobody
 * asked for. A ticket is a deliberate act: an agent pressing "Raise a ticket",
 * or a workflow's `create_ticket` step. Those are the only two doors.
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
    },
  });
  if (!conversation) return { ticketId: null };

  if (conversation.activeTicketId) {
    const active = await tx.ticket.findFirst({
      where: { id: conversation.activeTicketId, workspaceId: args.workspaceId },
      select: { id: true, status: true },
    });
    // The pointer is only trusted while it points at live work.
    if (active && isTicketActive(active.status)) {
      return { ticketId: active.id };
    }
  }

  // Pointer null or stale — but the ROUTING RULE is "an active ticket on the
  // thread → attach" (CLAUDE.md §2; this function's own header states it), and
  // the pointer is only a hot-path cache of it. With two tickets raised on one thread, solving the
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
    return { ticketId: fallbackActive.id };
  }

  // NOTHING opens a ticket but a person raising one.
  //
  // A ticket is a deliberate act — an agent pressing "Raise a ticket" in the
  // inbox, or a workflow's `create_ticket` step. It is never minted, and never
  // RESURRECTED, just because a customer wrote again.
  //
  // Auto-reopen used to live here: an inbound within
  // `ticketReopenWindowHours` of a solve pulled the solved ticket back to
  // `open` and wrote a "System reopened #10" line. It was removed 2026-08-01 at
  // the maintainer's instruction, having watched it happen: solved means the
  // customer got their answer and the work is done, so a later message is
  // either small talk or a NEW issue — and a new issue deserves a ticket
  // somebody chose to raise, with its own cause and its own number.
  //
  // So an inbound either ATTACHES to the thread's live ticket, or leaves the
  // thread ticket-free. The inbox already tracks every conversation; nothing is
  // lost by not having a ticket on it.
  return { ticketId: null };
}

/**
 * Stamp the first-response clock when an agent replies.
 *
 * Called from the outbound path with the ticket the message was routed to. CAS
 * on `firstResponseAt: null` so an at-least-once redelivery, or two agents
 * replying at the same instant, can't move a stamped time — the first response
 * happened once.
 */
/**
 * Mark that something HAPPENED on a ticket.
 *
 * Sorting the board by this is the whole point: the ticket someone just
 * answered rises above the ones nobody has touched in a week. Deliberately a
 * bare column write — it bumps no `version` (a reply must not 409 a colleague's
 * open editor), publishes nothing, and never fails a caller: an ordering hint
 * is not worth losing the write it decorates.
 *
 * Callers that are ALREADY writing the row set the field inline instead, so a
 * status change stays one statement.
 */
/**
 * One human line for the bell: "changed the status to Solved".
 *
 * Deliberately terse and deliberately INCOMPLETE — a bell entry says enough to
 * decide whether to open the ticket, not what the audit log says. Returns null
 * when nothing worth telling anyone about changed (an assignment is announced
 * by its own, more specific notification).
 */
function describeTicketChange(args: UpdateTicketArgs): string | null {
  if (args.status) return `changed the status to ${args.status.replace(/_/g, " ")}`;
  if (args.priority) return `set the priority to ${args.priority}`;
  if (args.assignedTeamId !== undefined) {
    return args.assignedTeamId ? "handed this to another team" : "took this out of every queue";
  }
  if (args.assignedUserId === null) return "unassigned this ticket";
  if (args.description !== undefined) return "filled in the cause";
  if (args.subject !== undefined) return "renamed this ticket";
  if (args.tagIds !== undefined) return "changed the tags";
  if (args.customFields !== undefined) return "edited a field";
  if (args.resolutionCode !== undefined || args.resolutionNote !== undefined) {
    return "recorded the resolution";
  }
  return null;
}

export async function touchTicketActivity(
  // Only `ticket.updateMany` is used, so the parameter asks for exactly that —
  // a transaction client, the module's `Db`, and the shared client all satisfy
  // it, and no caller needs a cast to hand one over.
  tx: Pick<PrismaClient, "ticket">,
  ticketId: string,
  at: Date = new Date(),
): Promise<void> {
  await tx.ticket
    .updateMany({ where: { id: ticketId }, data: { lastActivityAt: at } })
    .catch(() => undefined);
}

export async function markFirstResponse(
  tx: TxClient,
  workspaceId: string,
  ticketId: string,
  at: Date,
): Promise<void> {
  await tx.ticket.updateMany({
    where: { id: ticketId, workspaceId, firstResponseAt: null },
    // Answering the customer is activity on the work, not just on the thread.
    data: { firstResponseAt: at, lastActivityAt: at },
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
    // ACCESS-gated, not `workspaceId`-scoped: on a shared ticket the guest
    // department works the same row, and its writes ARE the change. `workspaceId`
    // is read off the row below for the audit/event, so ownership never moves.
    where: ticketByIdWhere(args.workspaceId, args.ticketId),
    select: {
      id: true,
      // The OWNING workspace — every audit row and event on a shared ticket
      // carries it, whichever department acted.
      workspaceId: true,
      // THIS workspace's share, when it is a guest: its own assignee lives
      // there, because the ticket's belongs to the owner's roster.
      shares: {
        where: { guestWorkspaceId: args.workspaceId },
        select: { id: true, assignedUserId: true },
      },
      version: true,
      status: true,
      priority: true,
      conversationId: true,
      // The cause's write-once gate reads the current value.
      description: true,
      // The PREVIOUS assignee: on a reassignment their board must drop the
      // card live, so their user room is co-targeted on the frame.
      assignedUserId: true,
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
  // The CAUSE is written once. It is the ticket's founding context — what the
  // receiving team (or workspace) was told the issue IS — and everything after
  // it (comments, notes, status moves) reasons against it. Rewriting it would
  // silently change what the whole history was about. Filling it in while
  // empty is allowed; a same-value write is a no-op, not a violation.
  if (
    args.description !== undefined &&
    existing.description &&
    args.description !== existing.description
  ) {
    return { ok: false, reason: "cause_immutable" };
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
  // A department the ticket was escalated TO. Its writes are the same writes
  // (one ticket, one truth) except for the two dimensions that are per-side:
  // the assignee and the team queue.
  const isGuest = existing.workspaceId !== args.workspaceId;
  // WHOSE assignee "the previous one" is. A guest's person lives on its own
  // TicketShare row, so comparing an incoming assignee against the ticket's
  // column (the OWNER's roster) made a guest re-asserting its CURRENT assignee
  // — a /v1 full-state sync, any PATCH echoing current state — look like a
  // fresh assignment: a spurious `assigned` audit row and a duplicate bell
  // entry, every time. Same fix the owner side got at the derive/notify sites.
  const prevAssignee = isGuest
    ? existing.shares[0]?.assignedUserId ?? null
    : existing.assignedUserId;
  // TAGS are the OWNER's vocabulary. `tags: { set }` replaces the whole list,
  // and a guest's ids resolve against a different catalogue — so a guest
  // submitting the tag editor scoped every id away, wrote an empty set, and
  // silently destroyed the owner's tags (while any id that DID resolve attached
  // another workspace's tag to the row). Refused rather than ignored: a write
  // the caller believes happened is the failure mode this whole model avoids.
  if (args.tagIds !== undefined && isGuest) {
    return { ok: false, reason: "tags_owner_only" };
  }
  // TEAMS are the owner's queues, same reasoning — and the same posture:
  // REFUSED rather than accepted-and-ignored (the /v1 surface names
  // accepted-and-ignored as the shape this API refuses; this arm used to
  // silently drop a guest's assignedTeamId — audit 2026-08-10).
  if (args.assignedTeamId !== undefined && isGuest) {
    return { ok: false, reason: "teams_owner_only" };
  }
  const result = await db.$transaction(async (tx) => {
    const nextStatus = args.status;
    const statusMoves = nextStatus !== undefined && nextStatus !== existing.status;

    const data: Prisma.TicketUncheckedUpdateInput = {
      // Every edit is activity. Set inline so a status change stays ONE
      // statement rather than a write plus a decorating touch.
      lastActivityAt: new Date(),
      ...(args.subject !== undefined ? { subject: args.subject } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.resolutionCode !== undefined ? { resolutionCode: args.resolutionCode } : {}),
      ...(args.resolutionNote !== undefined ? { resolutionNote: args.resolutionNote } : {}),
      ...(args.customFields !== undefined
        ? { customFields: args.customFields as Prisma.InputJsonValue }
        : {}),
      version: { increment: 1 },
    };

    // WHOSE assignee is being set. A GUEST department owns its own side of a
    // shared ticket (TicketShare.assignedUserId): the ticket's column belongs
    // to the owner's roster, so writing it from a guest cleared the owner's
    // person and left both pickers showing a blank. Applied after the CAS, with
    // the same "a claimed ticket is being worked" nudge.
    const guestShare = isGuest ? existing.shares[0] : undefined;
    if (args.assignedUserId !== undefined && !isGuest) {
      data.assignedUserId = args.assignedUserId;
      // Continuity is never cleared — unassigning must not erase who handled it.
      if (args.assignedUserId) data.lastAssignedUserId = args.assignedUserId;
      // A `new` ticket that gets an owner is being worked; move it out of the
      // untriaged column unless the caller is explicitly setting a status too.
      if (args.assignedUserId && existing.status === "new" && !statusMoves) {
        data.status = "open";
      }
    }
    // Same nudge for the guest's claim — the work is being done, by them.
    // Truthiness matters, exactly as in the owner branch: a guest CLEARING
    // their side's assignee is the opposite of a claim.
    if (args.assignedUserId && isGuest && existing.status === "new" && !statusMoves) {
      data.status = "open";
    }

    // Teams are the OWNER's queues (a Team belongs to one workspace); a
    // guest's write was already refused above (`teams_owner_only`).
    if (args.assignedTeamId !== undefined && !isGuest) {
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
        // (`lastSolvedAt` is no longer written — it existed solely to drive the
        // auto-reopen window query, removed 2026-08-01. Column kept per §18.)
        data.resolvedById = args.actor.userId ?? null;
        // closed → solved is a correction, not a second life: without this the
        // ticket reported as BOTH closed and solved (closedAt kept).
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
        // Fill-empty-only applies to the column being written. A guest's claim
        // targets its share, which the CAS below cannot express — automation
        // never assigns across a workspace boundary, so it never gets here.
        ...(args.onlyIfUnassigned && !isGuest ? { assignedUserId: null } : {}),
        // WRITE-ONCE CAUSE, race half (audit 2026-08-10). The JS pre-check
        // above (`cause_immutable`) reads a snapshot; two concurrent fills of
        // an empty cause — or a fill racing an escalation's fill — both pass
        // it and the last writer silently rewrote the founding context. When
        // this write SETS a cause onto a ticket the snapshot said was empty,
        // pin emptiness in the CAS itself so the loser conflicts instead of
        // overwriting. (A same-value or first write still succeeds; a written
        // cause is already refused by the pre-check.)
        ...(args.description !== undefined &&
        args.description !== existing.description &&
        !existing.description
          ? { OR: [{ description: null }, { description: "" }] }
          : {}),
      },
      data: data as Prisma.TicketUncheckedUpdateManyInput,
    });
    if (written.count === 0) {
      // Someone else moved it first. Report the conflict rather than reapplying
      // against a state the caller never saw — an unconditional retry here is
      // how a "set to pending" silently overwrites a colleague's "closed".
      return { conflict: true as const };
    }

    if (guestShare && args.assignedUserId !== undefined) {
      await tx.ticketShare.update({
        where: { id: guestShare.id },
        data: {
          assignedUserId: args.assignedUserId,
          ...(args.assignedUserId ? { lastAssignedUserId: args.assignedUserId } : {}),
        },
      });
    }

    let tagDiff: { added: TagSnapshot[]; removed: TagSnapshot[] } | null = null;
    if (args.tagIds !== undefined) {
      // Read the pre-set tags WITH names so the timeline can say which tag
      // moved (snapshotted — history keeps reading after a rename).
      const current = await tx.ticket.findUniqueOrThrow({
        where: { id: existing.id },
        select: { tags: { select: { id: true, name: true, color: true } } },
      });
      // Scope to the OWNER's tags — `set` by id doesn't filter, so a foreign id
      // would attach another workspace's tag. (Guests never reach here; the
      // owner-only refusal above is the gate. Reading the owner's id rather
      // than the actor's keeps this correct on its own terms.) Empty stays
      // empty (clears all tags), the intended meaning of `tagIds: []`.
      const safeTagIds = await workspaceScopedTagIds(tx, existing.workspaceId, args.tagIds);
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
              where: { id: { in: addedIds }, workspaceId: existing.workspaceId },
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
    const action = deriveAction(existing.status, statusMoves ? finalStatus : null, args, prevAssignee);

    // Tag edits earn their own timeline verbs — the generic `field_changed`
    // used to swallow them, leaving "something changed" where the reader needs
    // "the VIP tag was removed". Snapshotted name/color, same rule as the
    // conversation audit's tag rows.
    const tagEvents = tagDiff ? tagDiff.added.length + tagDiff.removed.length : 0;
    // The LAST TicketEvent written below — used to re-align `lastActivityAt`
    // to the evidence's own timestamp (see the alignment write after the
    // events). At least one event is always written: tagsOnly implies
    // tagEvents > 0, and !tagsOnly writes the generic row.
    let lastEventId: string | null = null;
    if (tagDiff) {
      for (const tag of tagDiff.added) {
        lastEventId = await writeTicketEvent(tx, existing.workspaceId, existing.id, "tag_added", args.actor, null, {
          tagId: tag.id,
          name: tag.name,
          color: tag.color,
        });
      }
      for (const tag of tagDiff.removed) {
        lastEventId = await writeTicketEvent(tx, existing.workspaceId, existing.id, "tag_removed", args.actor, null, {
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
      lastEventId = await writeTicketEvent(
        tx,
        existing.workspaceId,
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
    // Align `lastActivityAt` with the LAST event's own timestamp — same rule
    // as markSlaBreached and the attachment paths ("the column and the
    // evidence must agree to the millisecond or phantom corrections bury real
    // ones"). The inline `new Date()` in `data` above is built ms before the
    // event rows, so every human edit drifted once and the nightly
    // ticket-last-activity-drift sweeper "corrected" it — permanently non-zero
    // corrected-counts on any active workspace (audit 2026-08-10).
    if (lastEventId) {
      const evt = await tx.ticketEvent.findUnique({
        where: { id: lastEventId },
        select: { createdAt: true },
      });
      if (evt) await touchTicketActivity(tx, existing.id, evt.createdAt);
    }
    const pill = conversationPillFor(existing.status, statusMoves ? finalStatus : null);
    if (pill && existing.conversationId) {
      // The PILL belongs to the owner's conversation, so it is written with the
      // owner's workspaceId — a guest's status change still shows on the
      // customer thread it describes.
      await writeConversationPill(tx, existing.workspaceId, existing.conversationId, pill, args.actor, ticket);
    }
    await publishTicketEvent(tx, {
      // The event is published for the OWNING workspace (the ticket belongs to
      // it); guests receive it through `sharedWithWorkspaceIds`.
      args: { ...args, workspaceId: existing.workspaceId },
      ticket,
      openTicketCount,
      action,
      previousStatus: existing.status,
      // A reassignment must reach the PREVIOUS assignee too — a restricted
      // agent's board only hears through their user room, and the audience
      // computed from the post-write row no longer contains them.
      ...(existing.assignedUserId && existing.assignedUserId !== ticket.assignedUserId
        ? { alsoNotifyUserIds: [existing.assignedUserId] }
        : {}),
    });
    // NOTHING to mirror: a shared ticket IS one row, so every workspace with
    // access just read the change that landed above. (This replaced the
    // twin-pair sync of 2026-07-28 — two rows kept in step were two truths
    // that could drift.) Guests receive the realtime frame through the fanout
    // rule, which reads the ticket's shares.
    return { conflict: false as const, ticket, openTicketCount, action };
  });

  if (result.conflict) return { ok: false, reason: "version_conflict" };
  kickOutbox();

  // The BELL. After the transaction, never inside it: a courtesy must not hold
  // a lock, and `notifyUsers` swallows its own failure so it can never fail the
  // write it decorates.
  //
  // Two audiences, both deliberate:
  //  - a NEW ASSIGNEE is told they now own this. That is the one notification
  //    people asked for by name, and it goes only to them.
  //  - everyone else on the ticket — above all whoever RAISED it — is told
  //    something changed, because the person who asked the question is the one
  //    waiting on the answer and is usually neither assignee nor editor.
  void (async () => {
    const audience = await ticketAudience(sharedDb, existing.id);
    if (!audience) return;
    // OPERATOR MASK: append-only bell rows — masked at write time.
    const actorName = args.actor.userId
      ? await resolveActorDisplayName(sharedDb, args.actor.userId, [args.workspaceId])
      : null;
    const base = {
      actorUserId: args.actor.userId ?? null,
      actorName,
      ticketId: existing.id,
      ticketNumber: audience.number,
      ticketSubject: audience.subject,
    };

    // Only a CHANGED assignee is news. A /v1 partner syncing full state
    // re-asserts the current assignee routinely; without the comparison every
    // hourly sync wrote another identical "assigned this ticket to you" row
    // (audit 2026-08-10). The UI and workflow steps already no-op'd on their
    // side; this closes the API path at the write site.
    if (args.assignedUserId && args.assignedUserId !== prevAssignee) {
      // Compared against the CALLER's side (`prevAssignee`): a guest's person
      // is their share's `assignedUserId`, so the ticket's column would call
      // every guest re-assert news. Placement comes from the audience — it is
      // the one thing that knows which bell each person reads.
      const assignee = audience.recipients.find((r) => r.userId === args.assignedUserId);
      if (assignee) {
        await notifyUsers(sharedDb, {
          ...base,
          kind: "ticket_assigned",
          recipients: [assignee],
          summary: "assigned this ticket to you",
        });
      }
    }
    const summary = describeTicketChange(args);
    if (summary) {
      await notifyUsers(sharedDb, {
        ...base,
        kind: "ticket_changed",
        // The new assignee already got the more specific line above.
        recipients: audience.recipients.filter((r) => r.userId !== args.assignedUserId),
        summary,
      });
    }
  })().catch((err) => {
    console.warn("[tickets] notification fan-out failed:", err instanceof Error ? err.message : err);
  });

  // NOTE: solving the last ticket does NOT close the conversation. Closing a
  // thread is an AGENT's judgement that they are done with the customer, and
  // that is a different question from whether the work items are finished — a
  // customer is frequently still writing while the last ticket is solved.
  // Deriving one from the other hid live threads, so the setting that did it
  // (`Workspace.ticketCloseConversationOnLastSolved`) was removed 2026-08-19
  // rather than left off-by-default as a trap.

  return {
    ok: true,
    ticket: result.ticket,
    openTicketCount: result.openTicketCount,
    action: result.action,
  };
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
          // A missed promise is something that HAPPENED and needs a person, so
          // it floats the ticket up the board like any other activity.
          ? { firstResponseBreached: true, lastActivityAt: new Date() }
          : { resolutionBreached: true, lastActivityAt: new Date() },
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
    const breachEventId = await writeTicketEvent(
      tx,
      args.workspaceId,
      args.ticketId,
      "sla_breached",
      {},
      null,
      { leg: args.leg },
    );
    // Align `lastActivityAt` with the event's OWN timestamp. The updateMany
    // above stamped `new Date()` a few ms before the event row's DB-default
    // `createdAt`, and the drift sweeper's truth is GREATEST(events, …) — so
    // every breached ticket "drifted" by milliseconds and was silently
    // corrected nightly, which buries real corrections in noise.
    const breachEvent = await tx.ticketEvent.findUnique({
      where: { id: breachEventId },
      select: { createdAt: true },
    });
    if (breachEvent) {
      await tx.ticket.updateMany({
        where: { id: args.ticketId },
        data: { lastActivityAt: breachEvent.createdAt },
      });
    }
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
 *
 * WHERE YOU CALL THIS DECIDES HOW LONG THAT LOCK IS HELD, and it matters.
 * Postgres holds the row lock until the enclosing transaction COMMITS — not
 * until this statement returns. Called from inside the create transaction, the
 * lock therefore covered the tag lookup, the ticket insert, the openTicketCount
 * bump, the conversation update, the read-back, the TicketEvent, the timeline
 * pill and the outbox insert — so N concurrent creates in one workspace cost
 * the Nth caller N × (a whole create), not N × (one increment). Measured
 * 2026-07-29: eight concurrent creates blew the 15 s interactive-transaction
 * ceiling (`lockwait=7` in pg_stat_activity), which in production is a 500 for
 * whoever is at the back of the queue. Raising that ceiling had already been
 * tried twice (5 s → 15 s) and treats the symptom.
 *
 * So `createTicket` calls this on the BASE client, before opening its
 * transaction: the lock lives for one statement and concurrent creates then
 * proceed in parallel. The cost is that a create which fails after allocating
 * burns its number.
 *
 * THAT COST WAS ALREADY BEING PAID, which is what makes it acceptable rather
 * than merely tolerable. `deleteTicket` — reachable from the UI and from
 * `DELETE /v1/tickets/:id` — removes a ticket without renumbering survivors,
 * and this counter is only ever incremented, never decremented. Deleting #5
 * leaves a permanent, user-visible gap through a far more common path than a
 * failed create. Nothing derives from contiguity either: every consumer renders
 * `#{number}` and none does arithmetic on it. The guarantee that matters is
 * `@@unique([workspaceId, number])`, and it is untouched.
 *
 * (This previously cited docs/ticketing.md's "Gaps are fine; collisions are
 * not." That file was deleted as stale, so the reasoning now stands on the
 * code — `deleteTicket` and the unique constraint — which cannot go stale
 * without someone changing the behaviour it describes.) The collision backstop is unchanged
 * (`@@unique([workspaceId, number])` + the P2002 retry, which re-allocates).
 *
 * The ONLY caller is `createTicket` (escalation no longer allocates — it
 * grants a share to the SAME ticket row, one number for every participant;
 * the twin-pair design this docblock once referenced was removed 2026-07-28).
 */
export async function allocateNumber(
  tx: Pick<TxClient, "ticketNumberCounter">,
  workspaceId: string,
): Promise<number> {
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
  // OWNER only, deliberately not access-gated: destroying a record several
  // departments are working (and its shared history) is the owning workspace's
  // call. A guest that is finished revokes its own access instead.
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

/**
 * The ticket as its OWNING workspace sees it — the shape the domain event
 * carries. A guest's realtime frame is re-mapped for that guest by the fanout
 * rule, which is the only place that knows who it is emitting to.
 */
export async function readTicket(tx: TxClient, id: string): Promise<Ticket> {
  const row = await tx.ticket.findUniqueOrThrow({ where: { id }, select: TICKET_SELECT });
  return mapTicket(row, row.workspaceId);
}

/**
 * The same ticket, mapped for EACH workspace that may see it.
 *
 * `readTicket` is owner-perspective by construction, and `mapTicket` exists
 * precisely because the owner's view is not the guest's: `contactId` /
 * `contactName` / `conversationId` / `assignedUserId` all differ, and three of
 * those are boundaries rather than preferences (a guest gets the frozen
 * snapshot's name, never a live pointer into the owner's directory). Broadcast
 * one owner DTO to every guest room and that boundary is simply gone.
 *
 * One extra read per publish, on shared tickets only. Ticket changes happen at
 * human cadence, so this is not a hot path — and re-mapping in the fanout layer
 * is not an option: it must stay a pure function of the event (§10).
 */
async function readTicketPerWorkspace(
  tx: TxClient,
  id: string,
  workspaceIds: string[],
): Promise<Record<string, Ticket>> {
  if (workspaceIds.length === 0) return {};
  // `findUnique`, not `…OrThrow`: `deleteTicket` publishes its `deleted` frame
  // from inside the transaction that removed the row, so there is legitimately
  // nothing left to map. The fanout rule blanks the owner-only fields when this
  // returns no entry — an empty map must never mean "forward the owner's DTO".
  const row = await tx.ticket.findUnique({ where: { id }, select: TICKET_SELECT });
  if (!row) return {};
  const byWorkspace: Record<string, Ticket> = {};
  for (const workspaceId of new Set(workspaceIds)) {
    byWorkspace[workspaceId] = mapTicket(row, workspaceId);
  }
  return byWorkspace;
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
  prevAssignedUserId: string | null,
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
  // A re-assert of the CURRENT assignee is not an assignment — without the
  // comparison a /v1 full-state sync wrote a spurious `assigned` event per
  // sync (audit 2026-08-10). Falls through to priority/updated.
  if (args.assignedUserId !== undefined && args.assignedUserId !== prevAssignedUserId)
    return "assigned";
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
  /** The ticket's OWNING workspace — one history per ticket, all rows carrying
   *  it, however many workspaces have access. */
  workspaceId: string,
  ticketId: string,
  kind: Prisma.TicketEventCreateInput["kind"],
  actor: TicketActor,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  /** Note text, or the "why" on a handoff. */
  body?: string | null,
): Promise<string> {
  const row = await tx.ticketEvent.create({
    data: {
      workspaceId,
      ticketId,
      // WHICH workspace acted. On a shared ticket this is what makes the log
      // readable ("Billing changed the status"); on an unshared one it equals
      // `workspaceId` and nothing renders it.
      actorWorkspaceId: actor.workspaceId ?? null,
      kind,
      before: (before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      after: (after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      ...(body ? { body } : {}),
      actorUserId: actor.userId ?? null,
      actorApiKeyId: actor.apiKeyId ?? null,
    },
    select: { id: true },
  });
  return row.id;
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

  // Access-gated: a guest department may leave an internal note on a ticket
  // shared with it. A ticket id it has no access to must 404, not append.
  const ticket = await db.ticket.findFirst({
    where: ticketByIdWhere(args.workspaceId, args.ticketId),
    select: { id: true, workspaceId: true },
  });
  if (!ticket) return { ok: false, reason: "ticket_not_found" };

  const event = await db.ticketEvent.create({
    data: {
      // The ticket's owning workspace — one history per ticket.
      workspaceId: ticket.workspaceId,
      // ...but WHO wrote it is the acting workspace, which is what makes an
      // internal note distinguishable from a shared comment in the log.
      actorWorkspaceId: args.workspaceId,
      ticketId: args.ticketId,
      kind: "note",
      body,
      actorUserId: args.actor.userId ?? null,
      actorApiKeyId: args.actor.apiKeyId ?? null,
    },
    select: { createdAt: true },
  });
  // A note is work on the ticket even though it changes no field — leaving it
  // out would sink a ticket someone is actively annotating. Aligned to the
  // event's OWN timestamp so the drift sweeper's GREATEST agrees to the ms.
  await touchTicketActivity(db, args.ticketId, event.createdAt);
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
    /**
     * Workspaces to notify BEYOND the ticket's current audience. Exactly one
     * caller needs it: revoking a share must reach the workspace that just lost
     * access, so its board drops the card — and by then the share row is gone,
     * so the fanout rule can no longer derive it.
     */
    alsoNotifyWorkspaceIds?: string[];
    /** Extra per-user co-targets the caller knows and this function cannot
     *  derive — today: the PREVIOUS assignee on a reassignment, so their board
     *  drops the card live. */
    alsoNotifyUserIds?: string[];
  },
): Promise<void> {
  const { args, ticket, openTicketCount, action, previousStatus } = params;

  /**
   * The per-user co-target list for the realtime fanout.
   *
   * Restricted agents (visibility "assigned") deliberately never join the
   * workspace room, so a workspace-only emit never reached them: an agent
   * ASSIGNED a ticket had to refresh the page to see it — the exact reported
   * bug. The list mirrors `ticketVisibilityWhere`'s arms (assignee, share
   * assignees, raiser/escalators, conversation assignee), so everyone the query
   * layer would show the ticket to also receives its frames.
   *
   * The raiser and conversation assignee are not on the DTO, so one indexed
   * read fetches them. Tolerates a missing row (the DELETE action publishes
   * after the row is gone) by degrading to the DTO-derived arms.
   */
  const row = await tx.ticket
    .findUnique({
      where: { id: ticket.id },
      select: {
        createdById: true,
        conversation: { select: { assignedUserId: true } },
        shares: { select: { createdById: true } },
      },
    })
    .catch(() => null);
  const notifyUserIds = [
    ...new Set(
      [
        ticket.assignedUserId,
        ...(ticket.sharing?.guests.map((g) => g.assignedUserId) ?? []),
        row?.createdById,
        row?.conversation?.assignedUserId,
        ...(row?.shares.map((sh) => sh.createdById) ?? []),
        ...(params.alsoNotifyUserIds ?? []),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const otherWorkspaceIds = [
    ...(ticket.sharing?.guests.map((g) => g.workspaceId) ?? []),
    ...(params.alsoNotifyWorkspaceIds ?? []),
  ].filter((id) => id !== ticket.sharing?.ownerWorkspaceId);
  // Each recipient workspace gets the ticket as IT sees it — see
  // `readTicketPerWorkspace`. Built here, in the transaction, so the fanout
  // stays a pure function of the event.
  const ticketByWorkspace = await readTicketPerWorkspace(tx, ticket.id, otherWorkspaceIds);
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
    // Who else may see this ticket. Carried ON the event so the realtime fanout
    // does not have to re-read the shares (and cannot read a state the
    // transaction has already changed) — the same rule as `openTicketCount`.
    sharedWithWorkspaceIds: [
      ...(ticket.sharing?.guests.map((g) => g.workspaceId) ?? []),
      ...(params.alsoNotifyWorkspaceIds ?? []),
    ],
    ticketByWorkspace,
    notifyUserIds,
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

/** An assignee must be a live member of THIS workspace — otherwise a crafted id
 *  could hand work to someone in another tenant. */
/**
 * Does this team (Team) belong to this workspace, and is it live?
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
  const policy = await db.team.findFirst({
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
 * DETACHED in the background tier, so a ticket raised before the routing
 * settles can miss the thread's owner. Without this, such a ticket on an
 * auto-assigned thread would sit unassigned forever and the board's "Mine"
 * filter would be empty for everyone.
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
  // `updateTicket` REPORTS failure, it doesn't throw — so the caller's
  // `.catch()` never fires and a refused fill used to vanish without trace. The
  // refusal that actually happens is `assignee_not_found`: the assignee must be
  // a workspace member, and a non-member (the platform operator, §18) or a
  // just-removed member fails that gate. The conversation-side claim is now
  // gated on the same membership fact (`onAgentSendSideEffects`), so the two
  // can no longer disagree — but a discarded outcome is how that disagreement
  // stayed invisible, so say it out loud instead.
  const filled = await updateTicket(sharedDb, {
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
  if (!filled.ok) {
    console.warn(
      `[tickets] fillActiveTicketAssignee: ticket ${ticket.id} not filled for ${userId} (${filled.reason})`,
    );
  }
}
