import { Prisma, type ConversationStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";
import type { User } from "@ccp/shared/types";
import {
  workflowContactSnapshot,
  workflowConversationSnapshotAfterAssign,
  workflowConversationSnapshotAfterStatusChange,
} from "@/lib/workflows/events";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";
import { fillActiveTicketAssignee } from "@/lib/tickets/mutations";

/**
 * Single source of truth for the two conversation mutations whose business
 * rules MUST stay identical no matter who triggers them — the inbox UI
 * (ConversationsService), the workflow engine (assign_to / set_status steps),
 * and any future caller.
 *
 * Why this file exists (realtime audit 2026-05-25, R2): the service and the
 * workflow steps each had their OWN copy of "assign" and "set status". They
 * had already drifted — the service flips a CLOSED conversation to pending on
 * assign and clears the assignee on close, while the workflow steps did
 * NEITHER. A workflow `close_conversation` left the chat assigned-but-closed;
 * a workflow `assign_to` on a closed chat left it closed. Both now route
 * through these functions, so the rule lives in ONE place and can't drift.
 *
 * Framework-agnostic by design (lib/): `db` is INJECTED, not imported, so the
 * NestJS service passes `this.db` and a workflow step passes the lib `db`
 * Proxy — both resolve to the same pool (see lib/db.ts setSharedDb). Each
 * mutation co-commits its CAS write and its domain event(s) in ONE
 * `db.$transaction` via `publishInTx`, then calls `kickOutbox()` after commit,
 * so a crash between the state write and the emit can't lose the realtime
 * frame, audit row, workflow trigger, or outbound webhook (same durability
 * posture as MessagesService.autoAssignOnAgentSend + NotesService). The outbox
 * drainer dispatches to every subscriber ~1ms after the kick — realtime
 * latency is unchanged. No NestJS exceptions thrown from here — callers map the
 * typed result/outcome to their own error surface (HTTP exception vs. step
 * result).
 */

/** Minimal Prisma surface these helpers touch — satisfied by both DbService
 *  (NestJS) and the lib `db` Proxy. `$transaction` co-commits the CAS write and
 *  the outbox row (publishInTx). */
type Db = Pick<PrismaClient, "conversation" | "user" | "$transaction">;

/** Injected publish — `EventBus.publish` and lib `publish` share this shape.
 *  RETAINED for caller signature compatibility only: events now co-commit via
 *  `publishInTx` inside each helper's transaction, so this is no longer the
 *  delivery path. Drop it from the args + callers in a follow-up. */
type Publish = <K extends DomainEventType>(event: DomainEventOf<K>) => Promise<void>;

type Contact = Parameters<typeof workflowContactSnapshot>[0];

/** A conversation row CAS races against. `not_found` and `conflict` are the
 *  two non-success outcomes both callers must handle. */
export type ConversationMutationOutcome<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict" };

function isP2025(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025"
  );
}

function toWireUser(
  u: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    deactivatedAt: Date | null;
    // Role is per-workspace now, so it arrives as a filtered membership row
    // rather than a column on the user.
    workspaceMemberships: { role: User["role"] }[];
  } | null,
  workspaceId: string,
): User | null {
  return u
    ? {
        id: u.id,
        workspaceId,
        role: u.workspaceMemberships[0]?.role ?? "agent",
        name: u.name,
        email: u.email,
        avatarUrl: u.avatarUrl ?? undefined,
        isActive: u.deactivatedAt === null,
      }
    : null;
}

/**
 * Assign (or unassign, with `targetUserId: null`) a conversation.
 *
 * Rules (identical for UI + workflow + API):
 *   - `targetUserId !== null`: reject a deactivated/cross-team user
 *     (`reason: "invalid_user"`).
 *   - Status side-effect — assignment NEVER sets "open" (only the assignee
 *     chatting does, via MessagesService.autoAssignOnAgentSend):
 *       · assign while CLOSED   → pending (reopen into triage, assigned)
 *       · unassign while OPEN   → pending (back to triage)
 *       · otherwise             → unchanged
 *   - CAS on (assignedUserId, status) so a concurrent assign/close can't be
 *     clobbered → `reason: "conflict"`.
 *   - No-op (target == current assignee AND no status flip) returns
 *     `{ ok: true, changed: false }` WITHOUT publishing — mirrors the
 *     workflow step's idempotency short-circuit.
 *   - Publishes `conversation.assigned` (only when the assignee changed) then
 *     `conversation.status_changed` (only when the status flipped), in that
 *     order (cause → effect for audit/analytics/workflow-dispatch).
 */
export async function assignConversation(args: {
  db: Db;
  publish: Publish;
  workspaceId: string;
  conversationId: string;
  targetUserId: string | null;
  /** Real user id for UI/API actions; `null` for system/workflow actions. */
  changedByUserId: string | null;
  /** Carry through to events so downstream attribution is correct. */
  changedByApiKeyId?: string | null;
  /** Set by workflow steps to the running workflow's id — carried on the
   *  published events so the audit row attributes the change to the automation. */
  changedByWorkflowId?: string | null;
  /** When true, workflow-dispatch + outbound-webhooks skip their reactions
   *  (loop avoidance / no echo). Socket fanout + audit still fire. */
  silent?: boolean;
  /** Fill-empty-only. When true, do NOT reassign a conversation that already
   *  has a DIFFERENT human assignee — the §18 "automation never overrides a
   *  human" guard. Automated callers (workflow `assign_to user` without
   *  `overwrite`) pass it; a manual UI/API assign omits it and stays
   *  authoritative. The check is co-committed with the CAS below, so it can't
   *  race a human claiming the thread. */
  onlyIfUnassigned?: boolean;
}): Promise<
  ConversationMutationOutcome<{
    changed: boolean;
    statusChanged: boolean;
    assignedUser: User | null;
    previousAssignedUserId: string | null;
    previousStatus: ConversationStatus;
    newStatus: ConversationStatus;
  }> | { ok: false; reason: "invalid_user" }
> {
  const {
    db,
    workspaceId,
    conversationId,
    targetUserId,
    changedByUserId,
    changedByApiKeyId,
    changedByWorkflowId,
    silent,
  } = args;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      id: true,
      assignedUserId: true,
      status: true,
      contact: { include: { tags: { select: { id: true } } } },
    },
  });
  if (!conversation) return { ok: false, reason: "not_found" };

  const previousAssignedUserId = conversation.assignedUserId;
  const previousStatus = conversation.status;

  // Fill-empty-only guard (§18): an automated caller must never take a thread
  // away from the human working it. Skip silently — same shape as the
  // idempotent no-op below — when a DIFFERENT assignee already owns it. A manual
  // assign omits `onlyIfUnassigned` and remains authoritative.
  if (
    args.onlyIfUnassigned &&
    targetUserId !== null &&
    previousAssignedUserId !== null &&
    previousAssignedUserId !== targetUserId
  ) {
    return {
      ok: true,
      changed: false,
      statusChanged: false,
      assignedUser: null,
      previousAssignedUserId,
      previousStatus,
      newStatus: previousStatus,
    };
  }

  if (targetUserId !== null) {
    // Reject deactivated assignees — a soft-deleted agent shouldn't be
    // assigned new work even if their User row still exists for history.
    const member = await db.user.findFirst({
      where: { id: targetUserId, workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
      select: { id: true },
    });
    if (!member) return { ok: false, reason: "invalid_user" };
  }

  // Assignment NEVER sets "open" — only chatting does.
  let nextStatus: ConversationStatus = previousStatus;
  if (targetUserId !== null && previousStatus === "closed") {
    nextStatus = "pending";
  } else if (targetUserId === null && previousStatus === "open") {
    nextStatus = "pending";
  }
  const statusChanged = nextStatus !== previousStatus;
  const assigneeChanged = targetUserId !== previousAssignedUserId;

  // Idempotent no-op (same assignee, no status flip) — don't write, don't emit.
  if (!assigneeChanged && !statusChanged) {
    return {
      ok: true,
      changed: false,
      statusChanged: false,
      assignedUser: null,
      previousAssignedUserId,
      previousStatus,
      newStatus: previousStatus,
    };
  }

  const contact = workflowContactSnapshot(conversation.contact as Contact);

  let updated;
  try {
    // CAS update + event publish co-commit in ONE transaction via publishInTx
    // so a crash between the assignment write and the emit can't lose the
    // realtime frame + audit row + outbound webhook. kickOutbox() after commit
    // dispatches the outbox rows in ~1ms (same shape as autoAssignOnAgentSend).
    updated = await db.$transaction(async (tx) => {
      const row = await tx.conversation.update({
        // CAS pins BOTH assignedUserId and status, so a concurrent close/assign
        // by someone else surfaces as a conflict instead of a silent clobber.
        where: {
          id: conversationId,
          workspaceId,
          assignedUserId: previousAssignedUserId,
          status: previousStatus,
        },
        // `lastAssignedUserId` is the DURABLE continuity pointer: set it
        // whenever a real assignee is written, and never clear it. Closing a
        // conversation nulls `assignedUserId`, so without this the "who
        // handled this customer before" history would be destroyed exactly
        // when it becomes useful. See AssignmentPolicy.preferPreviousAgent.
        data: {
          assignedUserId: targetUserId,
          ...(statusChanged ? { status: nextStatus } : {}),
          // BOTH halves of the continuity pointer are written HERE, in the same
          // transaction. `lastAssignedAt` is also maintained by the analytics
          // subscriber, but continuity must not depend on that: `previousAgentFor`
          // gates on `lastAssignedAt >= cutoff`, so a null timestamp silently
          // disables "send the returning customer back to the agent who knows
          // them" — no error, no log, the feature just quietly stops. Leaving the
          // id and the timestamp to two different subsystems means one future
          // change to analytics (e.g. gating it on `silent`, which the workflow
          // and webhook subscribers already do) would kill continuity for every
          // AUTOMATED assignment while manual ones kept working. Writing both
          // together makes the pair atomic and the dependency impossible.
          ...(targetUserId !== null
            ? { lastAssignedUserId: targetUserId, lastAssignedAt: new Date() }
            : {}),
        },
        include: {
          assignedUser: {
            include: {
              workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 },
            },
          },
        },
      });

      if (assigneeChanged) {
        // Build the conversation snapshot AT PUBLISH TIME (post-CAS, with the
        // predicted analytics writes baked in) so workflow-dispatch reads from
        // the event payload — not a fresh DB read that could include a
        // concurrent unrelated mutation. See ConversationAssignedEvent.conversation.
        const assignedSnapshot = workflowConversationSnapshotAfterAssign(
          { ...row, assignedUser: row.assignedUser },
          previousAssignedUserId,
        );
        await publishInTx(tx, {
          type: "conversation.assigned",
          workspaceId,
          conversationId,
          assignedUser: toWireUser(row.assignedUser, workspaceId),
          previousAssignedUserId,
          newAssignedUserId: targetUserId,
          changedByUserId,
          ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
          ...(changedByWorkflowId !== undefined ? { changedByWorkflowId } : {}),
          contact,
          conversation: assignedSnapshot,
          silent: silent === true,
        });
      }

      if (statusChanged) {
        // After assigned → cause-then-effect ordering for consumers watching
        // both. The status snapshot reflects the row state AFTER the CAS —
        // status already flipped. The assignment-driven status flip path is
        // closed→pending or open→pending, never close, so the closeOverrides in
        // `workflowConversationSnapshotAfterStatusChange` are a no-op here; we
        // still route through it for one source of truth.
        const statusSnapshot = workflowConversationSnapshotAfterStatusChange(
          { ...row, assignedUser: row.assignedUser },
          { previousStatus, changedByUserId, changedByApiKeyId },
        );
        await publishInTx(tx, {
          type: "conversation.status_changed",
          workspaceId,
          conversationId,
          previousStatus,
          newStatus: nextStatus,
          changedByUserId,
          ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
          ...(changedByWorkflowId !== undefined ? { changedByWorkflowId } : {}),
          contact,
          conversation: statusSnapshot,
          silent: silent === true,
        });
      }

      return row;
    });
  } catch (err) {
    if (isP2025(err)) return { ok: false, reason: "conflict" };
    throw err;
  }
  kickOutbox();

  // Give the thread's live work an owner too, when it has none.
  //
  // FILL-EMPTY-ONLY, never a reassignment: a ticket can legitimately belong to
  // someone other than whoever owns the thread (an escalation handed to a
  // specialist), and silently dragging it along with the conversation would
  // take work away from the person doing it — the §18 rule that automated
  // assignment never overrides a human, applied to the ticket.
  //
  // Deliberately AFTER the transaction, not inside it: `updateTicket` opens its
  // own transaction, and the assignment must not fail because ticketing did.
  // A few ms of eventual consistency costs nothing here (the conversation is
  // the source of truth for assignment), and the worst case is a ticket that
  // stays unassigned — visible and fixable, never corrupt.
  if (targetUserId !== null) {
    await fillActiveTicketAssignee(workspaceId, conversationId, targetUserId).catch(
      (err: unknown) => {
        console.warn("[assign] ticket assignee follow-through failed", conversationId, err);
      },
    );
  }

  const assignedUser = toWireUser(updated.assignedUser, workspaceId);

  return {
    ok: true,
    changed: true,
    statusChanged,
    assignedUser,
    previousAssignedUserId,
    previousStatus,
    newStatus: nextStatus,
  };
}

/**
 * Set a conversation's status (open / pending / closed).
 *
 * Rules (identical for UI + workflow + API):
 *   - Closing UNASSIGNS in the SAME write (a closed thread has no owner; it
 *     reopens into triage unassigned). Cleared regardless of who it was
 *     assigned to. Only the close transition unassigns.
 *   - CAS on previous status → `reason: "conflict"`.
 *   - Idempotent no-op (already in target status, no closed metadata to set)
 *     returns `{ ok: true, changed: false }` without writing/emitting.
 *   - Publishes `conversation.status_changed` (only when the status actually
 *     flipped) then (only when closing cleared an assignee) `conversation.assigned`
 *     with `assignedUser: null`.
 *   - `closedCategory` / `closedSummary` are persisted in the CAS write itself
 *     (and still ride the status event on a fresh close, where the analytics
 *     subscriber double-writes the same values). This is what makes a RE-close
 *     that only (re)annotates an already-closed thread — e.g. a workflow
 *     close_conversation step against a chat an agent already closed — actually
 *     record its category/summary: that path writes the metadata but publishes
 *     NO status_changed (previousStatus === newStatus), so the analytics
 *     subscriber (which early-returns on an unchanged status) never runs.
 */
export async function setConversationStatus(args: {
  db: Db;
  publish: Publish;
  workspaceId: string;
  conversationId: string;
  status: ConversationStatus;
  changedByUserId: string | null;
  changedByApiKeyId?: string | null;
  /** Set by workflow steps to the running workflow's id — carried on the
   *  published events so the audit row attributes the change to the automation. */
  changedByWorkflowId?: string | null;
  silent?: boolean;
  closedCategory?: string | null;
  closedSummary?: string | null;
}): Promise<
  ConversationMutationOutcome<{
    changed: boolean;
    unassigned: boolean;
    previousStatus: ConversationStatus;
    previousAssignedUserId: string | null;
  }>
> {
  const {
    db,
    workspaceId,
    conversationId,
    status,
    changedByUserId,
    changedByApiKeyId,
    changedByWorkflowId,
    silent,
    closedCategory,
    closedSummary,
  } = args;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: { contact: { include: { tags: { select: { id: true } } } } },
  });
  if (!conversation) return { ok: false, reason: "not_found" };

  const previousStatus = conversation.status;
  const previousAssignedUserId = conversation.assignedUserId;

  // Idempotent: already in target status AND no closed metadata to (re)write.
  if (previousStatus === status && !closedCategory && !closedSummary) {
    return {
      ok: true,
      changed: false,
      unassigned: false,
      previousStatus,
      previousAssignedUserId,
    };
  }

  // Whether the status actually transitions. A re-close (already-closed thread
  // re-annotated with category/summary) passes the idempotency carve-out above
  // but does NOT flip status — so no status_changed event is published for it.
  const statusFlipped = previousStatus !== status;
  const unassignOnClose = status === "closed" && previousAssignedUserId !== null;
  // Auto-resume AI Autopilot on close (product decision): closing hands the
  // thread back to the AI so the next time the customer writes the AI handles
  // it fresh. Only flips when currently paused, so no redundant ai_changed.
  const resumeAiOnClose = status === "closed" && conversation.aiEnabled === false;

  const updateData: Prisma.ConversationUncheckedUpdateInput = { status };
  if (unassignOnClose) updateData.assignedUserId = null;
  if (resumeAiOnClose) updateData.aiEnabled = true;
  // Persist close context in the CAS write itself. On a FRESH close the
  // analytics subscriber also writes these (harmless same-value double-write);
  // on a RE-close (metadata-only rewrite, no status_changed emitted below) this
  // is the ONLY writer — otherwise a workflow close_conversation step's
  // category/summary on an already-closed thread would be silently dropped.
  if (status === "closed") {
    if (closedCategory !== undefined) updateData.closedCategory = closedCategory;
    if (closedSummary !== undefined) updateData.closedSummary = closedSummary;
  }

  const contact = workflowContactSnapshot(conversation.contact as Contact);

  try {
    // CAS update + event publish co-commit in ONE transaction via publishInTx
    // so a crash between the close write and the emit can't lose the realtime
    // frame + audit row + workflow trigger + outbound webhook. kickOutbox()
    // after commit dispatches the outbox rows in ~1ms.
    await db.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId, workspaceId, status: previousStatus },
        data: updateData,
      });

      if (statusFlipped) {
        // Build the post-CAS conversation snapshot with predicted analytics
        // writes. `conversation` is the pre-update row; spread the new status
        // (and cleared assignee on unassign-on-close) on top so the snapshot
        // reflects what the CAS just committed. See
        // ConversationStatusChangedEvent.conversation jsdoc.
        const statusSnapshot = workflowConversationSnapshotAfterStatusChange(
          {
            ...conversation,
            status,
            assignedUserId: unassignOnClose ? null : previousAssignedUserId,
          },
          { previousStatus, changedByUserId, changedByApiKeyId, closedCategory, closedSummary },
        );

        await publishInTx(tx, {
          type: "conversation.status_changed",
          workspaceId,
          conversationId,
          previousStatus,
          newStatus: status,
          changedByUserId,
          ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
          ...(changedByWorkflowId !== undefined ? { changedByWorkflowId } : {}),
          contact,
          conversation: statusSnapshot,
          ...(closedCategory !== undefined ? { closedCategory } : {}),
          ...(closedSummary !== undefined ? { closedSummary } : {}),
          silent: silent === true,
        });
      }

      if (unassignOnClose) {
        // After status_changed: the unassign is a side-effect of the close.
        // Snapshot mirrors the assignmentSnapshot rules — but the unassign here
        // doesn't count as a "new assignment" (assignmentsCount not bumped),
        // since the new value is null.
        const assignedSnapshot = workflowConversationSnapshotAfterAssign(
          {
            ...conversation,
            status,
            assignedUserId: null,
          },
          previousAssignedUserId,
        );
        await publishInTx(tx, {
          type: "conversation.assigned",
          workspaceId,
          conversationId,
          assignedUser: null,
          previousAssignedUserId,
          newAssignedUserId: null,
          changedByUserId,
          ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
          ...(changedByWorkflowId !== undefined ? { changedByWorkflowId } : {}),
          contact,
          conversation: assignedSnapshot,
          silent: silent === true,
        });
      }

      if (resumeAiOnClose) {
        // The close handed the thread back to the AI — surface it like any
        // other ai toggle so the inbox pill, socket, and outbound webhook stay
        // in sync.
        await publishInTx(tx, {
          type: "conversation.ai_changed",
          workspaceId,
          conversationId,
          previousAiEnabled: false,
          newAiEnabled: true,
          changedByUserId,
          ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
          ...(changedByWorkflowId !== undefined ? { changedByWorkflowId } : {}),
          contact,
          occurredAt: new Date().toISOString(),
          silent: silent === true,
        });
      }
    });
  } catch (err) {
    if (isP2025(err)) return { ok: false, reason: "conflict" };
    throw err;
  }
  kickOutbox();

  return {
    ok: true,
    changed: true,
    unassigned: unassignOnClose,
    previousStatus,
    previousAssignedUserId,
  };
}

/**
 * Toggle AI Autopilot for a conversation. CAS on the previous value so a
 * concurrent toggle / auto-pause can't double-fire, idempotent when already in
 * the target state (no event). Mirrors setConversationStatus: framework-
 * agnostic, publishes `conversation.ai_changed` (drives the inbox toggle via
 * socket, the activity-log pill via the audit subscriber, and the outbound
 * webhook). `silent` skips only the outbound-webhook echo — used by the AI's
 * own /v1 self-pause so it doesn't loop a delivery back to itself.
 */
export async function setConversationAiEnabled(args: {
  db: Db;
  publish: Publish;
  workspaceId: string;
  conversationId: string;
  aiEnabled: boolean;
  changedByUserId: string | null;
  changedByApiKeyId?: string | null;
  /** Set by a workflow step to the running workflow's id — carried on the
   *  published event so the audit row attributes the toggle to the automation. */
  changedByWorkflowId?: string | null;
  /** Audit-row `at` override. The auto-claim-on-send path passes a time strictly
   *  after the message so the "paused AI" pill sorts under the reply even on a
   *  refreshed page. Defaults to now() (the inbox toggle / manual paths). */
  occurredAt?: string;
  silent?: boolean;
}): Promise<
  ConversationMutationOutcome<{ changed: boolean; previousAiEnabled: boolean }>
> {
  const {
    db,
    workspaceId,
    conversationId,
    aiEnabled,
    changedByUserId,
    changedByApiKeyId,
    changedByWorkflowId,
    occurredAt,
    silent,
  } = args;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: { contact: { include: { tags: { select: { id: true } } } } },
  });
  if (!conversation) return { ok: false, reason: "not_found" };

  const previousAiEnabled = conversation.aiEnabled;
  if (previousAiEnabled === aiEnabled) {
    return { ok: true, changed: false, previousAiEnabled };
  }

  const contact = workflowContactSnapshot(conversation.contact as Contact);
  try {
    // CAS update + event publish co-commit in ONE transaction via publishInTx
    // so a crash between the toggle write and the emit can't lose the realtime
    // frame + audit row + outbound webhook. kickOutbox() dispatches in ~1ms.
    await db.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId, workspaceId, aiEnabled: previousAiEnabled },
        data: { aiEnabled },
      });
      await publishInTx(tx, {
        type: "conversation.ai_changed",
        workspaceId,
        conversationId,
        previousAiEnabled,
        newAiEnabled: aiEnabled,
        changedByUserId,
        ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
        ...(changedByWorkflowId !== undefined ? { changedByWorkflowId } : {}),
        contact,
        occurredAt: occurredAt ?? new Date().toISOString(),
        silent: silent === true,
      });
    });
  } catch (err) {
    if (isP2025(err)) return { ok: false, reason: "conflict" };
    throw err;
  }
  kickOutbox();

  return { ok: true, changed: true, previousAiEnabled };
}



/**
 * THE team-wide mark-read: conditional CAS-zero of `unreadCount` + a
 * `conversation.read` publish only when THIS call cleared it.
 *
 * One definition for the two agent-side readers — thread mount
 * (`ConversationsService.markRead`, which adds its own 404 probe + Meta read
 * receipt around this core) and reply-send
 * (`MessagesService.markReadOnAgentSend`, fire-and-forget). They were two
 * hand-mirrored copies that cited each other by line number; this is the
 * intended end-state. The WHERE predicate IS the gate: `unreadCount > 0`
 * makes the common already-read case one no-op round-trip, and the CAS
 * protects against the read-vs-incoming-bump race — the loser skips the
 * publish and the next `message.received` re-syncs the badge.
 */
export async function markConversationRead(args: {
  db: Pick<PrismaClient, "conversation">;
  publish: Publish;
  workspaceId: string;
  conversationId: string;
  readByUserId: string;
}): Promise<{ cleared: boolean }> {
  const result = await args.db.conversation.updateMany({
    where: {
      id: args.conversationId,
      workspaceId: args.workspaceId,
      unreadCount: { gt: 0 },
    },
    data: { unreadCount: 0 },
  });
  if (result.count === 0) return { cleared: false };
  await args.publish({
    type: "conversation.read",
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    readByUserId: args.readByUserId,
  } as DomainEventOf<"conversation.read">);
  return { cleared: true };
}
