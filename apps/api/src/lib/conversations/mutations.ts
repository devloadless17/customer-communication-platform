import { Prisma, type ConversationStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";
import type { User } from "@ccp/shared/types";
import {
  workflowContactSnapshot,
  workflowConversationSnapshotAfterAssign,
  workflowConversationSnapshotAfterStatusChange,
} from "@/lib/workflows/events";

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
 * Framework-agnostic by design (lib/): `db` and `publish` are INJECTED, not
 * imported, so the NestJS service passes `this.db` + `this.bus.publish` and a
 * workflow step passes the lib `db` Proxy + the lib `publish` — both resolve to
 * the same pool + same bus (see lib/db.ts setSharedDb + EventBus wrapping
 * lib/events/bus.publish), so an event published here reaches every subscriber
 * identically. No NestJS exceptions thrown from here — callers map the typed
 * result/outcome to their own error surface (HTTP exception vs. step result).
 */

/** Minimal Prisma surface these helpers touch — satisfied by both DbService
 *  (NestJS) and the lib `db` Proxy. */
type Db = Pick<PrismaClient, "conversation" | "user">;

/** Injected publish — `EventBus.publish` and lib `publish` share this shape. */
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

function toWireUser(u: {
  id: string;
  teamId: string;
  role: User["role"];
  name: string;
  email: string;
  avatarUrl: string | null;
  deactivatedAt: Date | null;
} | null): User | null {
  return u
    ? {
        id: u.id,
        teamId: u.teamId,
        role: u.role,
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
  teamId: string;
  conversationId: string;
  targetUserId: string | null;
  /** Real user id for UI/API actions; `null` for system/workflow actions. */
  changedByUserId: string | null;
  /** Carry through to events so downstream attribution is correct. */
  changedByApiKeyId?: string | null;
  /** When true, workflow-dispatch + outbound-webhooks skip their reactions
   *  (loop avoidance / no echo). Socket fanout + audit still fire. */
  silent?: boolean;
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
    publish,
    teamId,
    conversationId,
    targetUserId,
    changedByUserId,
    changedByApiKeyId,
    silent,
  } = args;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
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

  if (targetUserId !== null) {
    // Reject deactivated assignees — a soft-deleted agent shouldn't be
    // assigned new work even if their User row still exists for history.
    const member = await db.user.findFirst({
      where: { id: targetUserId, teamId, deactivatedAt: null },
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

  let updated;
  try {
    updated = await db.conversation.update({
      // CAS pins BOTH assignedUserId and status, so a concurrent close/assign
      // by someone else surfaces as a conflict instead of a silent clobber.
      where: {
        id: conversationId,
        teamId,
        assignedUserId: previousAssignedUserId,
        status: previousStatus,
      },
      data: statusChanged
        ? { assignedUserId: targetUserId, status: nextStatus }
        : { assignedUserId: targetUserId },
      include: { assignedUser: true },
    });
  } catch (err) {
    if (isP2025(err)) return { ok: false, reason: "conflict" };
    throw err;
  }

  const assignedUser = toWireUser(updated.assignedUser);
  const contact = workflowContactSnapshot(conversation.contact as Contact);

  if (assigneeChanged) {
    // Build the conversation snapshot AT PUBLISH TIME (post-CAS, with the
    // predicted analytics writes baked in) so workflow-dispatch reads from
    // the event payload — not a fresh DB read that could include a concurrent
    // unrelated mutation. See ConversationAssignedEvent.conversation jsdoc.
    const assignedSnapshot = workflowConversationSnapshotAfterAssign(
      { ...updated, assignedUser: updated.assignedUser },
      previousAssignedUserId,
    );
    await publish({
      type: "conversation.assigned",
      teamId,
      conversationId,
      assignedUser,
      previousAssignedUserId,
      newAssignedUserId: targetUserId,
      changedByUserId,
      ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
      contact,
      conversation: assignedSnapshot,
      silent: silent === true,
    });
  }

  if (statusChanged) {
    // After assigned → cause-then-effect ordering for consumers watching both.
    // The status snapshot reflects the row state AFTER the CAS — status
    // already flipped. The assignment-driven status flip path is
    // closed→pending or open→pending, never close, so the closeOverrides in
    // `workflowConversationSnapshotAfterStatusChange` are a no-op here; we
    // still route through it for one source of truth.
    const statusSnapshot = workflowConversationSnapshotAfterStatusChange(
      { ...updated, assignedUser: updated.assignedUser },
      { previousStatus, changedByUserId },
    );
    await publish({
      type: "conversation.status_changed",
      teamId,
      conversationId,
      previousStatus,
      newStatus: nextStatus,
      changedByUserId,
      ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
      contact,
      conversation: statusSnapshot,
      silent: silent === true,
    });
  }

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
 *   - Publishes `conversation.status_changed` then (only when closing cleared
 *     an assignee) `conversation.assigned` with `assignedUser: null`.
 *   - `closedCategory` / `closedSummary` ride on the status event (the
 *     analytics subscriber persists them).
 */
export async function setConversationStatus(args: {
  db: Db;
  publish: Publish;
  teamId: string;
  conversationId: string;
  status: ConversationStatus;
  changedByUserId: string | null;
  changedByApiKeyId?: string | null;
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
    publish,
    teamId,
    conversationId,
    status,
    changedByUserId,
    changedByApiKeyId,
    silent,
    closedCategory,
    closedSummary,
  } = args;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
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

  const unassignOnClose = status === "closed" && previousAssignedUserId !== null;
  // Auto-resume AI Autopilot on close (product decision): closing hands the
  // thread back to the AI so the next time the customer writes the AI handles
  // it fresh. Only flips when currently paused, so no redundant ai_changed.
  const resumeAiOnClose = status === "closed" && conversation.aiEnabled === false;

  const updateData: Prisma.ConversationUncheckedUpdateInput = { status };
  if (unassignOnClose) updateData.assignedUserId = null;
  if (resumeAiOnClose) updateData.aiEnabled = true;

  try {
    await db.conversation.update({
      where: { id: conversationId, teamId, status: previousStatus },
      data: updateData,
    });
  } catch (err) {
    if (isP2025(err)) return { ok: false, reason: "conflict" };
    throw err;
  }

  const contact = workflowContactSnapshot(conversation.contact as Contact);
  // Build the post-CAS conversation snapshot with predicted analytics writes.
  // `conversation` is the pre-update row; spread the new status (and cleared
  // assignee on unassign-on-close) on top so the snapshot reflects what the
  // CAS just committed. See ConversationStatusChangedEvent.conversation jsdoc.
  const statusSnapshot = workflowConversationSnapshotAfterStatusChange(
    {
      ...conversation,
      status,
      assignedUserId: unassignOnClose ? null : previousAssignedUserId,
    },
    { previousStatus, changedByUserId, closedCategory, closedSummary },
  );

  await publish({
    type: "conversation.status_changed",
    teamId,
    conversationId,
    previousStatus,
    newStatus: status,
    changedByUserId,
    ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
    contact,
    conversation: statusSnapshot,
    ...(closedCategory !== undefined ? { closedCategory } : {}),
    ...(closedSummary !== undefined ? { closedSummary } : {}),
    silent: silent === true,
  });

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
    await publish({
      type: "conversation.assigned",
      teamId,
      conversationId,
      assignedUser: null,
      previousAssignedUserId,
      newAssignedUserId: null,
      changedByUserId,
      ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
      contact,
      conversation: assignedSnapshot,
      silent: silent === true,
    });
  }

  if (resumeAiOnClose) {
    // The close handed the thread back to the AI — surface it like any other
    // ai toggle so the inbox pill, socket, and outbound webhook stay in sync.
    await publish({
      type: "conversation.ai_changed",
      teamId,
      conversationId,
      previousAiEnabled: false,
      newAiEnabled: true,
      changedByUserId,
      ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
      contact,
      occurredAt: new Date().toISOString(),
      silent: silent === true,
    });
  }

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
  teamId: string;
  conversationId: string;
  aiEnabled: boolean;
  changedByUserId: string | null;
  changedByApiKeyId?: string | null;
  silent?: boolean;
}): Promise<
  ConversationMutationOutcome<{ changed: boolean; previousAiEnabled: boolean }>
> {
  const {
    db,
    publish,
    teamId,
    conversationId,
    aiEnabled,
    changedByUserId,
    changedByApiKeyId,
    silent,
  } = args;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    include: { contact: { include: { tags: { select: { id: true } } } } },
  });
  if (!conversation) return { ok: false, reason: "not_found" };

  const previousAiEnabled = conversation.aiEnabled;
  if (previousAiEnabled === aiEnabled) {
    return { ok: true, changed: false, previousAiEnabled };
  }

  try {
    await db.conversation.update({
      where: { id: conversationId, teamId, aiEnabled: previousAiEnabled },
      data: { aiEnabled },
    });
  } catch (err) {
    if (isP2025(err)) return { ok: false, reason: "conflict" };
    throw err;
  }

  const contact = workflowContactSnapshot(conversation.contact as Contact);
  await publish({
    type: "conversation.ai_changed",
    teamId,
    conversationId,
    previousAiEnabled,
    newAiEnabled: aiEnabled,
    changedByUserId,
    ...(changedByApiKeyId !== undefined ? { changedByApiKeyId } : {}),
    contact,
    occurredAt: new Date().toISOString(),
    silent: silent === true,
  });

  return { ok: true, changed: true, previousAiEnabled };
}
