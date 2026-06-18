import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { assignConversation } from "@/lib/conversations/mutations";
import { pickRoundRobinAssignee } from "@/lib/conversations/round-robin";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
  envelopeConversation,
} from "./types";

/**
 * `assign_to` step. Mode picks the assignment strategy:
 *
 *   { mode: "user",       userId: string }   — specific teammate
 *   { mode: "unassign" }                     — remove current assignee
 *   { mode: "round_robin" }                  — next eligible agent (shared
 *                                              rotation; see round-robin.ts)
 *
 * Reserved for Round 2c:
 *   { mode: "ai", agentId: string } — assign to a configured AI agent
 *
 * Idempotency: no-op short-circuit if the target equals the current
 * assignee. The wider re-dispatch into conversation_assigned happens in
 * the call sites (assign route) — workflow steps deliberately do NOT
 * re-dispatch, since the workflow that runs this step already owns the
 * chain semantics and we don't want a step inside workflow X to trigger
 * workflow Y mid-run (loops). Use `trigger_workflow` step if that's the
 * intent.
 */

export type AssignToStepConfig =
  | { mode: "user"; userId: string }
  | { mode: "unassign" }
  | { mode: "round_robin" };

export const assignToStepHandler: StepHandler<AssignToStepConfig> = {
  type: "assign_to",
  sideEffect: "irreversible",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("assign_to config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (r.mode === "unassign") return { mode: "unassign" };
    if (r.mode === "round_robin") return { mode: "round_robin" };
    if (r.mode === "user") {
      if (typeof r.userId !== "string" || !r.userId) {
        throw new StepConfigError("assign_to.userId required when mode=user");
      }
      return { mode: "user", userId: r.userId };
    }
    throw new StepConfigError(
      "assign_to.mode must be 'user', 'unassign', or 'round_robin'",
    );
  },
  describeConfig(config) {
    if (config.mode === "unassign") return "Unassign";
    if (config.mode === "round_robin") return "Assign (round-robin)";
    return `Assign to ${config.userId}`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    const conv = envelopeConversation(envelope);
    if (!conv) return advanceWithError(400, "envelope missing conversation");
    const conversationId = conv.id;

    let targetUserId: string | null = null;
    if (config.mode === "user") {
      targetUserId = config.userId;
    } else if (config.mode === "round_robin") {
      // Shared rotation primitive (also used by the customer-handoff policy).
      targetUserId = await pickRoundRobinAssignee({ db, teamId: ctx.teamId });
      if (!targetUserId) {
        return advance({ skipped: "no_eligible_agent" });
      }
    }

    // Shared business rule (member validation, CAS, status-flip on
    // assign-to-closed → pending, event publishing) lives in
    // lib/conversations/mutations.ts so this step stays in lockstep with the
    // inbox UI + /v1 API and can't drift. `changedByUserId: null` = system
    // actor; `silent: true` so workflow-dispatch doesn't chain-trigger another
    // workflow mid-run (audit + socket + analytics still fire). Note: unlike
    // the old hand-rolled version, an assign onto a CLOSED conversation now
    // correctly reopens it to pending (matching the UI).
    const result = await assignConversation({
      db,
      publish,
      teamId: ctx.teamId,
      conversationId,
      targetUserId,
      changedByUserId: null,
      // Attribute the assignment to the running workflow on the audit row.
      changedByWorkflowId: ctx.workflowId,
      silent: true,
    });

    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          return advanceWithError(404, "conversation not found");
        case "invalid_user":
          return advanceWithError(400, "configured user not in team or deactivated");
        case "conflict":
          return advanceWithError(409, "conversation reassigned by someone else");
      }
    }

    if (!result.changed) {
      return advance({ skipped: "already_assigned_to_target" });
    }

    return advance({
      conversationId,
      assignedUserId: targetUserId,
      previousAssignedUserId: result.previousAssignedUserId,
      ...(result.statusChanged ? { statusChangedTo: result.newStatus } : {}),
    });
  },
};
