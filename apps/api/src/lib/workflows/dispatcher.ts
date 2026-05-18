import { Prisma, type WorkflowTriggerEvent } from "@prisma/client";

import { db } from "@/lib/db";
import { evaluateConditions } from "@/lib/workflows/conditions";
import type { EventPayload, PayloadFor } from "@/lib/workflows/events";
import { enqueueWorkflowRun } from "@/lib/workflows/queue";

/**
 * Public entry point. Call from any place in the app that produces a domain
 * event:
 *
 *   await dispatch(teamId, "message_received", { message, conversation, ... });
 *
 * Behavior per workflow on this team+trigger:
 *   1. Filter to enabled AND published
 *   2. Evaluate triggerConditions against the payload (fail-closed on garbage)
 *   3. If triggerOncePerContact: check WorkflowContactState (skip if fired)
 *   4. Create a WorkflowRun row with the snapshot payload + queued state
 *   5. Enqueue a BullMQ job carrying just the runId
 *   6. If triggerOncePerContact: write the WorkflowContactState row to
 *      mark this contact as having fired (race-safe via unique index)
 *
 * Failures during dispatch are logged but NEVER thrown — workflows are
 * additive infrastructure. A degraded Redis or Postgres degrades workflows
 * only; messages still ingest, replies still send.
 */
export async function dispatch<E extends WorkflowTriggerEvent>(
  teamId: string,
  event: E,
  payload: PayloadFor<E>,
): Promise<void> {
  try {
    const workflows = await retry(
      () =>
        db.workflow.findMany({
          where: { teamId, trigger: event, enabled: true, published: true },
          select: {
            id: true,
            triggerConditions: true,
            triggerOncePerContact: true,
          },
        }),
      RULE_LOOKUP_RETRIES,
      `[workflows] lookup team=${teamId} event=${event}`,
    );
    if (workflows.length === 0) return;

    const contactId = (payload as { contact?: { id?: string } })?.contact?.id ?? null;
    const conversationId = (payload as { conversation?: { id?: string } })?.conversation?.id ?? null;

    const matched = workflows.filter((w) =>
      evaluateConditions(w.triggerConditions, payload as EventPayload),
    );

    // Once-per-contact filter — only meaningful when we have a contactId.
    let toRun = matched;
    if (contactId) {
      const oncePerContactIds = matched
        .filter((w) => w.triggerOncePerContact)
        .map((w) => w.id);
      if (oncePerContactIds.length > 0) {
        const already = await db.workflowContactState.findMany({
          where: {
            workflowId: { in: oncePerContactIds },
            contactId,
          },
          select: { workflowId: true },
        });
        const skip = new Set(already.map((r) => r.workflowId));
        toRun = matched.filter((w) => !skip.has(w.id));
      }
    }

    // Create the runs in parallel. Each enqueue is independent — Promise.allSettled
    // keeps one workflow's permanent failure from shadowing siblings.
    const results = await Promise.allSettled(
      toRun.map((w) =>
        createAndEnqueue({
          workflowId: w.id,
          teamId,
          trigger: event,
          contactId,
          conversationId,
          payload,
          oncePerContact: w.triggerOncePerContact,
        }),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "rejected") {
        console.error(
          `[workflows] enqueue PERMANENTLY FAILED for workflow=${toRun[i]!.id} team=${teamId} event=${event} — run will NOT execute:`,
          r.reason instanceof Error ? r.reason.message : r.reason,
        );
      }
    }
  } catch (err) {
    console.error(
      `[workflows] dispatch failed for team=${teamId} event=${event}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

interface CreateAndEnqueueArgs {
  workflowId: string;
  teamId: string;
  trigger: WorkflowTriggerEvent;
  contactId: string | null;
  conversationId: string | null;
  payload: unknown;
  oncePerContact: boolean;
}

async function createAndEnqueue(args: CreateAndEnqueueArgs): Promise<void> {
  // Write the once-per-contact marker FIRST when applicable, in the same tx
  // as the run create. If the marker insert hits the unique index, another
  // call already won — abandon this run silently so we never enqueue twice.
  if (args.oncePerContact && args.contactId) {
    try {
      await db.$transaction(async (tx) => {
        await tx.workflowContactState.create({
          data: {
            workflowId: args.workflowId,
            contactId: args.contactId!,
            teamId: args.teamId,
          },
        });
        const run = await tx.workflowRun.create({
          data: {
            workflowId: args.workflowId,
            teamId: args.teamId,
            trigger: args.trigger,
            contactId: args.contactId,
            conversationId: args.conversationId,
            eventPayload: args.payload as Prisma.InputJsonValue,
            status: "queued",
          },
          select: { id: true },
        });
        await retry(
          () => enqueueWorkflowRun(run.id),
          ENQUEUE_RETRIES,
          `[workflows] enqueue team=${args.teamId} workflow=${args.workflowId}`,
        );
      });
    } catch (err) {
      // P2002 = race lost on the once-per-contact unique index. Expected
      // and benign — another dispatcher invocation already fired this
      // workflow for this contact.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return;
      }
      throw err;
    }
    return;
  }

  const run = await db.workflowRun.create({
    data: {
      workflowId: args.workflowId,
      teamId: args.teamId,
      trigger: args.trigger,
      contactId: args.contactId,
      conversationId: args.conversationId,
      eventPayload: args.payload as Prisma.InputJsonValue,
      status: "queued",
    },
    select: { id: true },
  });
  await retry(
    () => enqueueWorkflowRun(run.id),
    ENQUEUE_RETRIES,
    `[workflows] enqueue team=${args.teamId} workflow=${args.workflowId}`,
  );
}

const RULE_LOOKUP_RETRIES = [200] as const;
const ENQUEUE_RETRIES = [200, 1000, 5000] as const;

async function retry<T>(
  fn: () => Promise<T>,
  delays: readonly number[],
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        console.warn(`${label} recovered after ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
      }
      return result;
    } catch (err) {
      lastErr = err;
      const delay = delays[attempt];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Manual / synchronous dispatch entry points
// ---------------------------------------------------------------------------

/**
 * Fire a single workflow on a specific contact/conversation. Used by:
 *   - /api/team/workflows/[id]/manual-trigger
 *   - /api/team/workflows/[id]/test
 *   - the `trigger_workflow` step
 *
 * Bypasses the trigger-conditions filter — the caller has already decided
 * this workflow should fire — but still respects `enabled` + `published`.
 * Returns the runId so the caller can show progress.
 */
export async function dispatchManualTrigger(args: {
  teamId: string;
  workflowId: string;
  contactId: string;
  conversationId: string | null;
  triggeredByUserId: string | null;
  metadata?: Record<string, string>;
}): Promise<string> {
  const wf = await db.workflow.findFirst({
    where: { id: args.workflowId, teamId: args.teamId },
    select: { id: true, enabled: true, published: true },
  });
  if (!wf) throw new Error("workflow not found");
  if (!wf.enabled || !wf.published) {
    throw new Error("workflow is disabled or unpublished");
  }

  const [contact, conversation] = await Promise.all([
    db.contact.findFirst({
      where: { id: args.contactId, teamId: args.teamId },
      include: { tags: { select: { id: true } } },
    }),
    args.conversationId
      ? db.conversation.findFirst({
          where: { id: args.conversationId, teamId: args.teamId },
        })
      : Promise.resolve(null),
  ]);
  if (!contact) throw new Error("contact not found");

  // Build a manual_trigger payload from the live rows. Note: this still
  // routes through `dispatch()` so it inherits the once-per-contact ledger.
  // If a manual-trigger workflow is configured with triggerOncePerContact,
  // the second manual trigger for the same contact is a no-op — surprising
  // but matches respond.io's "once per contact" semantics.
  const payload = {
    contact: {
      id: contact.id,
      phoneNumber: contact.phoneNumber,
      identityProvider: contact.identityProvider,
      externalContactId: contact.externalContactId,
      name: contact.name,
      email: contact.email,
      stageId: contact.stageId,
      tagIds: contact.tags.map((t) => t.id),
      customFields: normalizeStringMap(contact.customFields),
    },
    conversation: conversation
      ? {
          id: conversation.id,
          status: conversation.status,
          assignedUserId: conversation.assignedUserId,
          unreadCount: conversation.unreadCount,
          lastMessageAt: conversation.lastMessageAt.toISOString(),
          firstAssignedAt: conversation.firstAssignedAt?.toISOString() ?? null,
          firstAssignedUserId: conversation.firstAssignedUserId,
          lastAssignedAt: conversation.lastAssignedAt?.toISOString() ?? null,
          firstResponseAt: conversation.firstResponseAt?.toISOString() ?? null,
          firstResponseByUserId: conversation.firstResponseByUserId,
          closedAt: conversation.closedAt?.toISOString() ?? null,
          closedByUserId: conversation.closedByUserId,
          closedCategory: conversation.closedCategory,
          closedSummary: conversation.closedSummary,
          assignmentsCount: conversation.assignmentsCount,
          incomingMessagesCount: conversation.incomingMessagesCount,
          outgoingMessagesCount: conversation.outgoingMessagesCount,
          responsesCount: conversation.responsesCount,
        }
      : null,
    triggeredByUserId: args.triggeredByUserId ?? "system",
    metadata: args.metadata ?? {},
  };

  // Create the run directly (without re-going through dispatch's
  // conditions check — manual triggers skip that gate by design).
  const run = await db.workflowRun.create({
    data: {
      workflowId: wf.id,
      teamId: args.teamId,
      trigger: "manual_trigger",
      contactId: args.contactId,
      conversationId: args.conversationId,
      eventPayload: payload as unknown as Prisma.InputJsonValue,
      status: "queued",
    },
    select: { id: true },
  });
  await enqueueWorkflowRun(run.id);
  return run.id;
}

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
