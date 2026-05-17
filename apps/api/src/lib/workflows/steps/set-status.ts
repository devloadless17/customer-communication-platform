import { Prisma, type ConversationStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
  envelopeConversation,
} from "./types";

const VALID_STATUSES: readonly ConversationStatus[] = ["open", "pending", "closed"];

export interface SetStatusStepConfig {
  status: ConversationStatus;
}

/**
 * `set_status` step. The most generic conversation-status mutator.
 *
 * `open_conversation` and `close_conversation` are thin specializations
 * sharing this implementation — they construct their config and delegate.
 * Exporting `runSetStatus` lets them reuse the CAS update + emit + audit
 * without re-implementing.
 */
export async function runSetStatus(
  envelope: Parameters<StepHandler["run"]>[0],
  status: ConversationStatus,
  extras: { closedCategory?: string | null; closedSummary?: string | null },
  ctx: Parameters<StepHandler["run"]>[2],
): Promise<StepResult> {
  const conv = envelopeConversation(envelope);
  if (!conv) return advanceWithError(400, "envelope missing conversation");
  const conversationId = conv.id;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId: ctx.teamId },
    include: { contact: { include: { tags: { select: { id: true } } } } },
  });
  if (!conversation) return advanceWithError(404, "conversation not found");
  const previousStatus = conversation.status as ConversationStatus;
  if (previousStatus === status && !extras.closedCategory && !extras.closedSummary) {
    return advance({ skipped: "already_in_target_status" });
  }

  // Only flip the status here. The analytics subscriber writes closedAt /
  // closedByUserId / closedCategory / closedSummary (and wipes them on
  // reopen) using the closed metadata carried on the event payload.
  try {
    await db.conversation.update({
      where: { id: conversationId, teamId: ctx.teamId, status: previousStatus },
      data: { status },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return advanceWithError(409, "conversation status changed by someone else");
    }
    throw err;
  }

  // `silent: true` — step-driven status change. Without this, workflow-
  // dispatch would re-fire `conversation_status_changed`/`_opened`/`_closed`
  // and trigger a downstream workflow inside the current run. Socket fanout,
  // audit, and analytics still run (those are user-visible effects).
  await publish({
    type: "conversation.status_changed",
    teamId: ctx.teamId,
    conversationId,
    previousStatus,
    newStatus: status,
    changedByUserId: null,
    contact: workflowContactSnapshot(conversation.contact),
    ...(extras.closedCategory !== undefined ? { closedCategory: extras.closedCategory } : {}),
    ...(extras.closedSummary !== undefined ? { closedSummary: extras.closedSummary } : {}),
    silent: true,
  });

  return advance({ conversationId, previousStatus, newStatus: status });
}

export const setStatusStepHandler: StepHandler<SetStatusStepConfig> = {
  type: "set_status",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("set_status config must be an object");
    }
    const r = raw as Record<string, unknown>;
    const status = r.status as ConversationStatus | undefined;
    if (!status || !VALID_STATUSES.includes(status)) {
      throw new StepConfigError(`set_status.status must be one of ${VALID_STATUSES.join(", ")}`);
    }
    return { status };
  },
  describeConfig(config) {
    return `Set status to ${config.status}`;
  },
  async run(envelope, config, ctx) {
    return runSetStatus(envelope, config.status, {}, ctx);
  },
};
