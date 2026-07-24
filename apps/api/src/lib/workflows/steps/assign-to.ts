import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { assignByPolicy } from "@/lib/assignment/apply";
import { assignConversation } from "@/lib/conversations/mutations";

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
 *   { mode: "round_robin" }                  — route with the team's routing
 *                                              rules / default policy
 *   { mode: "policy", policyId }             — route with a NAMED assignment
 *                                              policy ("Escalations",
 *                                              "Sales — weighted")
 *
 * `round_robin` and `policy` are the same code path — the only difference is
 * whether the workflow pins a policy or lets the team's routing rules choose.
 * Both honor strategy, weights, capacity, eligibility and overflow, so a
 * workflow can't route in a way the admin's settings forbid.
 *
 * `overwrite` (default false) decides whether the step may move a conversation
 * that ALREADY has an assignee. Automation defaults to "fill an empty slot
 * only" so a workflow can't quietly take a thread away from the agent working
 * it; set it when the workflow's whole purpose is a re-route (escalation).
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
  | { mode: "user"; userId: string; overwrite?: boolean }
  | { mode: "unassign" }
  | { mode: "round_robin"; overwrite?: boolean }
  | { mode: "policy"; policyId: string; overwrite?: boolean };

export const assignToStepHandler: StepHandler<AssignToStepConfig> = {
  type: "assign_to",
  sideEffect: "irreversible",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("assign_to config must be an object");
    }
    const r = raw as Record<string, unknown>;
    const overwrite = r.overwrite === true;
    if (r.mode === "unassign") return { mode: "unassign" };
    if (r.mode === "round_robin") return { mode: "round_robin", overwrite };
    if (r.mode === "policy") {
      if (typeof r.policyId !== "string" || !r.policyId) {
        throw new StepConfigError("assign_to.policyId required when mode=policy");
      }
      return { mode: "policy", policyId: r.policyId, overwrite };
    }
    if (r.mode === "user") {
      if (typeof r.userId !== "string" || !r.userId) {
        throw new StepConfigError("assign_to.userId required when mode=user");
      }
      return { mode: "user", userId: r.userId, overwrite };
    }
    throw new StepConfigError(
      "assign_to.mode must be 'user', 'unassign', 'round_robin', or 'policy'",
    );
  },
  describeConfig(config) {
    if (config.mode === "unassign") return "Unassign";
    if (config.mode === "round_robin") return "Assign (auto-route)";
    if (config.mode === "policy") return `Assign via policy ${config.policyId}`;
    return `Assign to ${config.userId}`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    const conv = envelopeConversation(envelope);
    if (!conv) return advanceWithError(400, "envelope missing conversation");
    const conversationId = conv.id;

    // Policy-driven modes go through the assignment engine, which owns the
    // pick AND the write (validation retry, CAS-conflict handling, the
    // "never steal from a human" guard). Doing the write there rather than
    // resolving an id here is what keeps the workflow step in lockstep with
    // the AI handoff and the auto-router — one implementation of the race
    // rules, not three.
    if (config.mode === "round_robin" || config.mode === "policy") {
      const outcome = await assignByPolicy({
        db,
        publish,
        workspaceId: ctx.workspaceId,
        conversationId,
        source: "workflow",
        policyId: config.mode === "policy" ? config.policyId : null,
        onlyIfUnassigned: config.overwrite !== true,
        changedByUserId: null,
        changedByWorkflowId: ctx.workflowId,
        // silent so workflow-dispatch doesn't chain-trigger another workflow
        // mid-run (audit + socket + analytics still fire) — same contract as
        // the fixed-user branch below.
        silent: true,
      });
      if (!outcome.applied) {
        switch (outcome.skipped) {
          case "not_found":
            return advanceWithError(404, "conversation not found");
          case "already_assigned":
          case "lost_race":
            return advance({ skipped: "already_assigned_to_target" });
          default:
            return advance({ skipped: "no_eligible_agent" });
        }
      }
      return advance({
        conversationId,
        assignedUserId: outcome.userId,
        assignedVia: outcome.decision.policyName,
        ...(outcome.statusChanged ? { statusChangedTo: "pending" } : {}),
      });
    }

    let targetUserId: string | null = null;
    if (config.mode === "user") {
      targetUserId = config.userId;
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
      workspaceId: ctx.workspaceId,
      conversationId,
      targetUserId,
      changedByUserId: null,
      // Attribute the assignment to the running workflow on the audit row.
      changedByWorkflowId: ctx.workflowId,
      // §18 "automation never overrides a human": a fixed-user assign fills an
      // empty slot only, unless the workflow author explicitly set overwrite
      // (a deliberate re-route). Without this a keyword rule could silently yank
      // an active thread from the agent working it — the exact thing the
      // policy/round_robin modes already guard and this branch used not to.
      // `unassign` (targetUserId null) is unaffected: the guard only applies to
      // assigning a named user onto an already-owned thread.
      onlyIfUnassigned: config.mode === "user" ? config.overwrite !== true : false,
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
