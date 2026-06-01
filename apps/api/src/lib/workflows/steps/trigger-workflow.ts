import { db } from "@/lib/db";

import { dispatchManualTrigger } from "@/lib/workflows/dispatcher";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
  envelopeContact,
  envelopeConversation,
} from "./types";

/**
 * `trigger_workflow` step. Fires another workflow on the same contact /
 * conversation as a `manual_trigger` event. Use this to compose
 * sub-workflows ("on close → run cleanup workflow") without inlining
 * everything in one canvas.
 *
 *   Config: { workflowId: string }
 *
 * Loop guard: the dispatched workflow runs in its own WorkflowRun with its
 * own jumps + step counter. The parent's step counter still ticks, so
 * compound loops (A triggers B triggers A) are bounded by the 100-step
 * per-run global ceiling. A future cycle-detector could short-circuit
 * earlier; not needed for round 2.
 */
export interface TriggerWorkflowStepConfig {
  workflowId: string;
}

/**
 * Hard cap on workflow-to-workflow dispatch chain length. Catches the
 * authoring footgun where A triggers B triggers A (or any longer cycle):
 * each child run carries `metadata.depth = parent.depth + 1`, and we
 * refuse to dispatch past TRIGGER_DEPTH_MAX. The 100-step-per-run cap
 * inside the runtime can't prevent this on its own — a chain of N tiny
 * workflows is N small step budgets, not one big one.
 */
const TRIGGER_DEPTH_MAX = 8;

export const triggerWorkflowStepHandler: StepHandler<TriggerWorkflowStepConfig> = {
  type: "trigger_workflow",
  sideEffect: "irreversible",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("trigger_workflow config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.workflowId !== "string" || !r.workflowId) {
      throw new StepConfigError("trigger_workflow.workflowId must be a non-empty string");
    }
    return { workflowId: r.workflowId };
  },
  describeConfig(c) {
    return `Trigger workflow ${c.workflowId}`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    const target = await db.workflow.findFirst({
      where: { id: config.workflowId, teamId: ctx.teamId },
      select: { id: true, trigger: true, published: true },
    });
    if (!target) return advanceWithError(404, "target workflow not found");
    if (target.trigger !== "manual_trigger") {
      return advanceWithError(
        400,
        "target_not_manual",
        `target workflow's trigger is ${target.trigger}; only manual_trigger workflows can be invoked from another workflow`,
      );
    }
    if (!target.published) {
      return advanceWithError(409, "target_not_runnable", "target workflow is not published");
    }

    // Workflow-chain depth read DIRECTLY from envelope.workflowDepth (set
    // by `buildEnvelope` from `eventPayload._workflowDepth`, which the
    // dispatcher stamps on every chained run regardless of the chained
    // workflow's trigger event). 0 for top-level user-initiated runs;
    // strictly positive for any chained run.
    //
    // Pre-2026-05-29 this read only from `manual_trigger`'s metadata.depth,
    // which meant a chain through a non-manual trigger (`messageReceived
    // → trigger_workflow → workflow B (any trigger) → trigger_workflow →
    // workflow C → …`) reset the counter at every non-manual hop and
    // bypassed TRIGGER_DEPTH_MAX. Now the depth survives every chain
    // hop.
    const parentDepth = envelope.workflowDepth ?? 0;
    const nextDepth = parentDepth + 1;
    if (nextDepth > TRIGGER_DEPTH_MAX) {
      // Log loud + with full provenance (originating workflow, run, target,
      // team) before advancing with the audit-shaped error. The runner's
      // stepLog already captures the failure with status=409, but that's
      // per-run — a structured log line lets us grep across a chain to find
      // the originating workflow id when a customer reports "my flows
      // stopped firing." Counting alone isn't enough; we want the WHO.
      console.warn(
        `[workflows] trigger_depth_exceeded ` +
          `(team=${ctx.teamId} originatingWorkflow=${ctx.workflowId} ` +
          `originatingRun=${ctx.runId} step=${ctx.stepId} ` +
          `targetWorkflow=${target.id} depth=${nextDepth} max=${TRIGGER_DEPTH_MAX}) — ` +
          `refusing to dispatch a deeper hop; likely a workflow chain loop.`,
      );
      return advanceWithError(
        409,
        "trigger_depth_exceeded",
        `chain depth ${nextDepth} exceeds the max of ${TRIGGER_DEPTH_MAX} — likely a workflow loop (originating workflow ${ctx.workflowId})`,
      );
    }

    const c = envelopeContact(envelope);
    if (!c) return advanceWithError(400, "envelope missing contact");
    const contactId = c.id;

    const conversationId = envelopeConversation(envelope)?.id ?? null;

    const runId = await dispatchManualTrigger({
      teamId: ctx.teamId,
      workflowId: target.id,
      contactId,
      conversationId,
      triggeredByUserId: null,
      metadata: {
        sourceRunId: ctx.runId,
        sourceWorkflowId: ctx.workflowId,
        // Kept for backwards-compat (older runs may have read this). The
        // real chain-depth carrier is `workflowDepth` below, propagated
        // via `eventPayload._workflowDepth` and read off the envelope.
        depth: String(nextDepth),
      },
      workflowDepth: nextDepth,
      // Chain calls MUST respect the target workflow's
      // `triggerOncePerContact` ledger. Without this, a workflow with
      // once-per-contact set could be re-fired infinitely (up to
      // TRIGGER_DEPTH_MAX) for the same contact via composition — the
      // ledger only protects `dispatch()`-driven entries, not
      // trigger_workflow-step entries.
      enforceOncePerContact: true,
      // Carry the HTTP-chain depth forward. Without this a chained
      // workflow's own http_request step would reset the X-CCP-Depth
      // counter to 0, so a hostile compose
      // (incoming_webhook → trigger_workflow → workflow B with
      // http_request → external → incoming_webhook → …) would clear the
      // cross-system loop guard at every workflow boundary. Now each
      // trigger_workflow hop adds one to the HTTP chain depth too, so
      // the two ceilings (workflow-chain=8, http-chain=8) compose
      // multiplicatively the hard way (still bounded) rather than the
      // soft way (each restart).
      chainDepth: (envelope.depth ?? 0) + 1,
    });

    if (runId === null) {
      // Target is once-per-contact AND this contact already fired it.
      // Advance with a 409-shaped log entry so the operator can spot the
      // skip in the run timeline without the workflow stalling.
      return advanceWithError(
        409,
        "target_once_per_contact_already_fired",
        `target workflow "${target.id}" is once-per-contact and contact "${contactId}" has already fired it`,
      );
    }

    return advance({ targetWorkflowId: target.id, dispatchedRunId: runId });
  },
};
