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
 *   1. Filter to published (live) workflows
 *   2. Evaluate triggerConditions against the payload (fail-closed on garbage)
 *   3. If triggerOncePerContact: check WorkflowContactState (skip if fired)
 *   4. Create a WorkflowRun row with the snapshot payload + queued state
 *   5. Enqueue a BullMQ job carrying just the runId
 *   6. If triggerOncePerContact: write the WorkflowContactState row to
 *      mark this contact as having fired (race-safe via unique index)
 *
 * Snapshot contract (M1):
 *   `payload` is treated as the IMMUTABLE trigger-time snapshot. It is pinned
 *   verbatim onto `WorkflowRun.eventPayload`; the runner (runner.ts) builds the
 *   step envelope from `run.eventPayload`, not from a fresh DB read. Callers
 *   MUST capture the conversation/contact state at trigger time (typically by
 *   building the snapshot in the same subscriber that fires this dispatch) and
 *   pass it in. If the caller does a fresh DB read instead, a concurrent
 *   mutation landing between the read and the run insert produces an
 *   inconsistent snapshot — the runner is correctly using the row that was
 *   committed, but the row was sampled at the wrong moment.
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
    // M8: load-all + in-memory condition filter. Fine at <500 workflows/team
    // (the cap of `findMany` here scales linearly with workflow count, not
    // with traffic). We log a one-line warning when a team crosses
    // WORKFLOW_LOAD_WARN_THRESHOLD on a single dispatch so a noisy team
    // surfaces before it becomes a tail-latency problem. The fix when this
    // trips: push triggerConditions evaluation into the DB (Postgres JSON
    // operators + an expression index on (teamId, trigger, published)), or
    // shard the lookup by a coarse condition key. Both are bigger changes
    // than the current pre-MVP scale warrants.
    const workflows = await retry(
      () =>
        db.workflow.findMany({
          where: { teamId, trigger: event, published: true },
          select: {
            id: true,
            graph: true,
            triggerConditions: true,
            triggerOncePerContact: true,
          },
        }),
      RULE_LOOKUP_RETRIES,
      `[workflows] lookup team=${teamId} event=${event}`,
    );
    if (workflows.length === 0) return;
    if (workflows.length >= WORKFLOW_LOAD_WARN_THRESHOLD) {
      // Single line, no further dedupe — Postgres slow-query logs + this line
      // together pinpoint the team in seconds. Don't suppress per team here;
      // a sudden spike on a single team is the exact signal we want loud.
      console.warn(
        `[workflows] dispatch loaded ${workflows.length} workflows ` +
          `(team=${teamId} event=${event}) — approaching the in-memory filter ` +
          `threshold; consider pushing triggerConditions into the DB.`,
      );
    }

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
            // teamId is redundant with workflowId here (workflowId is a global
            // cuid and oncePerContactIds came from a teamId-scoped lookup),
            // but adding it makes the team boundary explicit at the query and
            // means the row's @@index([teamId]) can serve this filter too.
            teamId,
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
          graph: w.graph as Prisma.InputJsonValue,
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
  // Snapshot of the workflow's graph at dispatch time, pinned onto the run.
  graph: Prisma.InputJsonValue;
  oncePerContact: boolean;
}

async function createAndEnqueue(args: CreateAndEnqueueArgs): Promise<void> {
  // Write the once-per-contact marker + run create inside a tx. The BullMQ
  // enqueue runs AFTER the tx commits — calling Redis from inside a
  // Postgres transaction holds the DB pool slot for the BullMQ command
  // timeout (Redis hiccup = pool starvation). The waiting-runs sweeper
  // recovers any orphaned `queued` row that never made it into Redis.
  let runId: string | null = null;
  if (args.oncePerContact && args.contactId) {
    try {
      runId = await db.$transaction(async (tx) => {
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
            graphSnapshot: args.graph,
            status: "queued",
          },
          select: { id: true },
        });
        return run.id;
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
  } else {
    const run = await db.workflowRun.create({
      data: {
        workflowId: args.workflowId,
        teamId: args.teamId,
        trigger: args.trigger,
        contactId: args.contactId,
        conversationId: args.conversationId,
        eventPayload: args.payload as Prisma.InputJsonValue,
        graphSnapshot: args.graph,
        status: "queued",
      },
      select: { id: true },
    });
    runId = run.id;
  }
  if (!runId) return;
  // Enqueue OUTSIDE the tx so a Redis stall can't pin a Prisma connection.
  // If this fails after retries the row stays `queued` and the
  // workflow-waiting sweeper picks it up on the next tick.
  await retry(
    () => enqueueWorkflowRun(runId!),
    ENQUEUE_RETRIES,
    `[workflows] enqueue team=${args.teamId} workflow=${args.workflowId}`,
  );
}

const RULE_LOOKUP_RETRIES = [200] as const;
const ENQUEUE_RETRIES = [200, 1000, 5000] as const;

// M8 — warn when a single dispatch loads at least this many workflows for
// in-memory triggerConditions filtering. Pre-MVP capacity is 500 per team
// across all triggers, so half of that on ONE trigger is the loud threshold.
const WORKFLOW_LOAD_WARN_THRESHOLD = 250;

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
 *   - /api/team/workflows/[id]/manual-trigger  (UI button)
 *   - /api/team/workflows/[id]/test            (test fire)
 *   - the `trigger_workflow` step              (workflow chaining)
 *
 * Bypasses the trigger-conditions filter — the caller has already decided
 * this workflow should fire — but still respects `published`.
 *
 * `enforceOncePerContact` defaults FALSE. The UI button + test fire are
 * explicit admin intent and should always run, even on a contact that has
 * already fired the workflow. The `trigger_workflow` step passes TRUE so a
 * chain (A → B → A) can't bypass the once-per-contact ledger that the
 * non-manual `dispatch()` path honors — without this, a workflow with
 * `triggerOncePerContact = true` runs N times for the same contact when
 * chained from another workflow's `trigger_workflow` step (it should run
 * once, exactly like the message-received entry point already enforces).
 *
 * Returns the runId on success, OR `null` when `enforceOncePerContact` is
 * true AND the target workflow's ledger says this contact already fired.
 * Throws on hard errors (workflow missing / disabled / unpublished /
 * Redis / Postgres).
 */
export async function dispatchManualTrigger(args: {
  teamId: string;
  workflowId: string;
  contactId: string;
  conversationId: string | null;
  triggeredByUserId: string | null;
  metadata?: Record<string, string>;
  enforceOncePerContact?: boolean;
  /**
   * HTTP-chain depth carried forward from a `trigger_workflow` step in the
   * parent run. Without this, a chained workflow's own `http_request` step
   * starts the X-CCP-Depth counter at 0, defeating the cross-system loop
   * cap when the chain composes `incoming_webhook → trigger_workflow →
   * http_request → external → incoming_webhook`. The trigger_workflow
   * step passes `(envelope.depth ?? 0) + 1` so each chain hop adds one.
   * Undefined / 0 for top-level admin-initiated runs (which can't form an
   * HTTP loop without first being called from `http_request`).
   */
  chainDepth?: number;
  /**
   * In-process workflow-chain depth carried forward from a `trigger_workflow`
   * step. Stored on the chained run's `eventPayload._workflowDepth` so the
   * runner's `buildEnvelope` surfaces it as `envelope.workflowDepth`. The
   * `trigger_workflow` step reads it back to check against TRIGGER_DEPTH_MAX,
   * keeping the chain bounded across non-`manual_trigger` workflows.
   * Undefined on top-level admin runs (treated as 0).
   */
  workflowDepth?: number;
}): Promise<string | null> {
  const wf = await db.workflow.findFirst({
    where: { id: args.workflowId, teamId: args.teamId },
    select: {
      id: true,
      graph: true,
      published: true,
      triggerOncePerContact: true,
    },
  });
  if (!wf) throw new Error("workflow not found");
  if (!wf.published) {
    throw new Error("workflow is not published");
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
      identityChannel: contact.identityChannel,
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
    // Carry the HTTP-chain depth forward when this run was triggered by a
    // `trigger_workflow` step that itself sat inside a chain. The runner
    // reads this off the envelope at run start (runner.ts:_depth) and the
    // http_request step stamps depth+1 outbound. Omitted (undefined) on a
    // top-level admin "Run now" — equivalent to 0, treated identically by
    // both readers.
    ...(typeof args.chainDepth === "number" && args.chainDepth > 0
      ? { _depth: args.chainDepth }
      : {}),
    // Workflow-chain depth — stamped on every chained run regardless of the
    // chained workflow's trigger event. See WorkflowEventEnvelope.workflowDepth
    // for the full rationale. Omitted on top-level runs (treated as 0).
    ...(typeof args.workflowDepth === "number" && args.workflowDepth > 0
      ? { _workflowDepth: args.workflowDepth }
      : {}),
  };

  // Create the run directly (without re-going through dispatch's
  // conditions check — manual triggers skip that gate by design).
  //
  // When `enforceOncePerContact` is true AND the workflow's
  // triggerOncePerContact flag is set, gate the run create on the
  // WorkflowContactState ledger inside the same transaction as the run
  // insert. The unique index on (workflowId, contactId) makes the marker
  // insert a row-level lock — a concurrent caller that already won sees
  // P2002 and we bail with null. Mirrors `createAndEnqueue`'s
  // once-per-contact path so the two entry shapes converge on the same
  // protection.
  if (args.enforceOncePerContact && wf.triggerOncePerContact) {
    try {
      const runId = await db.$transaction(async (tx) => {
        await tx.workflowContactState.create({
          data: {
            workflowId: wf.id,
            contactId: args.contactId,
            teamId: args.teamId,
          },
        });
        const run = await tx.workflowRun.create({
          data: {
            workflowId: wf.id,
            teamId: args.teamId,
            trigger: "manual_trigger",
            contactId: args.contactId,
            conversationId: args.conversationId,
            eventPayload: payload as unknown as Prisma.InputJsonValue,
            graphSnapshot: wf.graph as Prisma.InputJsonValue,
            status: "queued",
          },
          select: { id: true },
        });
        return run.id;
      });
      await enqueueWorkflowRun(runId);
      return runId;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Once-per-contact race-lost OR pre-existing marker — both mean
        // "this contact has already fired this workflow; do not chain
        // again." Return null so the caller (trigger_workflow step) can
        // render a clean 409 rather than queueing a phantom run.
        return null;
      }
      throw err;
    }
  }

  const run = await db.workflowRun.create({
    data: {
      workflowId: wf.id,
      teamId: args.teamId,
      trigger: "manual_trigger",
      contactId: args.contactId,
      conversationId: args.conversationId,
      eventPayload: payload as unknown as Prisma.InputJsonValue,
      graphSnapshot: wf.graph as Prisma.InputJsonValue,
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
