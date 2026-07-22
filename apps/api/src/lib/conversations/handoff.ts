import type { PrismaClient } from "@prisma/client";

import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";

import { assignByPolicy } from "@/lib/assignment/apply";
import { loadAssignmentSettings } from "@/lib/assignment/resolve";

import { assignConversation } from "./mutations";

/**
 * Customer → human handoff. Applies the team's configured `aiHandoffAction`
 * after the AI yields the thread to a person — the customer asked for a human,
 * or the assistant escalated.
 *
 * ONE shared implementation so every AI path assigns identically:
 *   - the native AI Assistant, when its reply orchestrator decides `escalate`,
 *   - the legacy n8n autopilot, via the `/v1` `set-ai` "human" branch.
 *
 * Action mapping:
 *   none         → leave the conversation as-is (just pause the AI)
 *   unassign     → clear the assignee (lands in the Unassigned triage queue)
 *   assign_fixed → `Team.aiHandoffAssigneeId` (a named escalation owner)
 *   round_robin  → run the ASSIGNMENT POLICY engine. This used to be one
 *                  hardcoded least-busy rotation; it is now whichever policy
 *                  the admin picked (`AssignmentSettings.aiHandoffPolicyId`,
 *                  or the routing rules, or the team default), so an escalation
 *                  respects weights, capacity and eligibility like every other
 *                  assignment. The UI labels it "Route with assignment policy".
 *
 * Every action routes through the shared `assignConversation` mutation, so
 * `conversation.assigned` fires and the inbox updates live (same
 * realtime/audit/analytics path as a manual assign). System actor
 * (`changedByUserId: null`); `changedByApiKeyId` attributes the n8n call when
 * present, and is null for the in-process native escalate.
 *
 * Framework-agnostic (lib/): `db` + `publish` are injected. Best-effort by
 * contract — the caller's critical action (pausing the AI) has already
 * committed, so a handoff failure must degrade to "paused but unassigned",
 * never throw. Errors surface via the optional `onError` sink.
 */

type Db = Pick<
  PrismaClient,
  | "workspace"
  | "conversation"
  | "user"
  | "$transaction"
  | "assignmentPolicy"
  | "assignmentRule"
  | "assignmentSettings"
  | "assignmentPolicyMember"
>;
type Publish = <K extends DomainEventType>(event: DomainEventOf<K>) => Promise<void>;

export async function runHandoffPolicy(args: {
  db: Db;
  publish: Publish;
  workspaceId: string;
  conversationId: string;
  /** Attributes the assignment to the calling API key (n8n); null for native. */
  changedByApiKeyId?: string | null;
  /** Optional log sink for the non-fatal degradations below. */
  onError?: (message: string) => void;
}): Promise<void> {
  const { db, publish, workspaceId, conversationId, changedByApiKeyId = null, onError } = args;

  const team = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { aiHandoffAction: true, aiHandoffAssigneeId: true },
  });
  if (!team || team.aiHandoffAction === "none") return;

  if (team.aiHandoffAction === "round_robin") {
    const settings = await loadAssignmentSettings(db, workspaceId);
    // `onlyIfUnassigned: false` — an escalation deliberately RE-routes: the
    // thread may still carry the assignee from an earlier session, and the
    // whole point of handing off now is to put it in front of someone
    // available. This is the one automated path allowed to move an existing
    // assignee, and it is admin-configured.
    const outcome = await assignByPolicy({
      db,
      publish,
      workspaceId,
      conversationId,
      source: "ai_handoff",
      policyId: settings.aiHandoffPolicyId,
      onlyIfUnassigned: false,
      changedByUserId: null,
      changedByApiKeyId,
    });
    if (!outcome.applied && outcome.skipped === "no_assignee") {
      // Nobody eligible (everyone offline / at capacity) and the policy's
      // overflow said leave-unassigned. Correct outcome: the customer sits in
      // the visible triage queue, not on an agent who's gone home.
      onError?.(
        `handoff found no eligible agent for team ${workspaceId} (policy ${outcome.decision?.policyName ?? "?"}); leaving unassigned`,
      );
    }
    return;
  }

  let targetUserId: string | null = null;
  if (team.aiHandoffAction === "assign_fixed") {
    targetUserId = team.aiHandoffAssigneeId;
    if (!targetUserId) return; // misconfigured (no member set) → leave as-is
  }
  // "unassign" falls through with targetUserId = null.

  const assigned = await assignConversation({
    db,
    publish,
    workspaceId,
    conversationId,
    targetUserId,
    changedByUserId: null,
    changedByApiKeyId,
  });

  // A configured fixed assignee who's been deactivated/removed → don't fail the
  // handoff; fall back to leaving the thread unassigned for triage.
  if (!assigned.ok && "reason" in assigned && assigned.reason === "invalid_user") {
    onError?.(
      `handoff assign_fixed target ${targetUserId} invalid for team ${workspaceId}; leaving unassigned`,
    );
    await assignConversation({
      db,
      publish,
      workspaceId,
      conversationId,
      targetUserId: null,
      changedByUserId: null,
      changedByApiKeyId,
    });
  }
}
