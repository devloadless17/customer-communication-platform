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

export const triggerWorkflowStepHandler: StepHandler<TriggerWorkflowStepConfig> = {
  type: "trigger_workflow",
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
      select: { id: true, trigger: true, enabled: true, published: true },
    });
    if (!target) return advanceWithError(404, "target workflow not found");
    if (target.trigger !== "manual_trigger") {
      return advanceWithError(
        400,
        "target_not_manual",
        `target workflow's trigger is ${target.trigger}; only manual_trigger workflows can be invoked from another workflow`,
      );
    }
    if (!target.enabled || !target.published) {
      return advanceWithError(409, "target_not_runnable", "target workflow is disabled or unpublished");
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
      metadata: { sourceRunId: ctx.runId, sourceWorkflowId: ctx.workflowId },
    });

    return advance({ targetWorkflowId: target.id, dispatchedRunId: runId });
  },
};
