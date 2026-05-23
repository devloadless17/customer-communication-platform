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

    // Trace depth via the envelope payload. The dispatcher writes
    // `metadata.depth` (string) on every manual_trigger child run; a
    // top-level user-initiated run starts at depth 0 (absent). Other
    // trigger kinds (message_received / conversation_closed / etc.)
    // don't carry metadata, but they CAN'T loop back into a
    // trigger_workflow chain without a deliberate `trigger_workflow`
    // step, which is what this gate protects.
    const envMetadata =
      envelope.event === "manual_trigger"
        ? (envelope.data as { metadata?: Record<string, string> }).metadata
        : undefined;
    const parentDepthRaw = envMetadata?.depth;
    const parentDepth =
      typeof parentDepthRaw === "string" ? Number.parseInt(parentDepthRaw, 10) : NaN;
    const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
    if (nextDepth > TRIGGER_DEPTH_MAX) {
      return advanceWithError(
        409,
        "trigger_depth_exceeded",
        `chain depth ${nextDepth} exceeds the max of ${TRIGGER_DEPTH_MAX} — likely a workflow loop`,
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
        depth: String(nextDepth),
      },
      // Chain calls MUST respect the target workflow's
      // `triggerOncePerContact` ledger. Without this, a workflow with
      // once-per-contact set could be re-fired infinitely (up to
      // TRIGGER_DEPTH_MAX) for the same contact via composition — the
      // ledger only protects `dispatch()`-driven entries, not
      // trigger_workflow-step entries.
      enforceOncePerContact: true,
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
