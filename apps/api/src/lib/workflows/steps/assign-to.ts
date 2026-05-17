import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import type { User } from "@ccp/shared/types";
import { workflowContactSnapshot } from "@/lib/workflows/events";

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
 *
 * Reserved for Round 2c:
 *   { mode: "round_robin" }       — pick the next active agent
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
  | { mode: "unassign" };

export const assignToStepHandler: StepHandler<AssignToStepConfig> = {
  type: "assign_to",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("assign_to config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (r.mode === "unassign") return { mode: "unassign" };
    if (r.mode === "user") {
      if (typeof r.userId !== "string" || !r.userId) {
        throw new StepConfigError("assign_to.userId required when mode=user");
      }
      return { mode: "user", userId: r.userId };
    }
    throw new StepConfigError("assign_to.mode must be 'user' or 'unassign'");
  },
  describeConfig(config) {
    return config.mode === "unassign" ? "Unassign" : `Assign to ${config.userId}`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    const conv = envelopeConversation(envelope);
    if (!conv) return advanceWithError(400, "envelope missing conversation");
    const conversationId = conv.id;
    const targetUserId = config.mode === "user" ? config.userId : null;

    const conversation = await db.conversation.findFirst({
      where: { id: conversationId, teamId: ctx.teamId },
      select: {
        id: true,
        assignedUserId: true,
        contact: { include: { tags: { select: { id: true } } } },
      },
    });
    if (!conversation) return advanceWithError(404, "conversation not found");

    if (targetUserId !== null) {
      const member = await db.user.findFirst({
        where: { id: targetUserId, teamId: ctx.teamId },
        select: { id: true },
      });
      if (!member) return advanceWithError(400, "configured user not in team");
    }

    if (conversation.assignedUserId === targetUserId) {
      return advance({ skipped: "already_assigned_to_target" });
    }

    let updated;
    try {
      updated = await db.conversation.update({
        where: {
          id: conversationId,
          teamId: ctx.teamId,
          assignedUserId: conversation.assignedUserId,
        },
        data: { assignedUserId: targetUserId },
        include: { assignedUser: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return advanceWithError(409, "conversation reassigned by someone else");
      }
      throw err;
    }

    const assignedUser: User | null = updated.assignedUser
      ? {
          id: updated.assignedUser.id,
          teamId: updated.assignedUser.teamId,
          role: updated.assignedUser.role,
          name: updated.assignedUser.name,
          email: updated.assignedUser.email,
          avatarUrl: updated.assignedUser.avatarUrl ?? undefined,
          isActive: updated.assignedUser.deactivatedAt === null,
        }
      : null;

    // `silent: true` — step-driven assignment. Without this, workflow-
    // dispatch would fire `conversation_assigned` and the next workflow
    // could re-assign → loop. Audit + socket-fanout + analytics still run.
    await publish({
      type: "conversation.assigned",
      teamId: ctx.teamId,
      conversationId,
      assignedUser,
      previousAssignedUserId: conversation.assignedUserId,
      newAssignedUserId: targetUserId,
      changedByUserId: null,
      contact: workflowContactSnapshot(conversation.contact),
      silent: true,
    });

    return advance({
      conversationId,
      assignedUserId: targetUserId,
      previousAssignedUserId: conversation.assignedUserId,
    });
  },
};
