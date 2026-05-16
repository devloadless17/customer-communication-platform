import { Prisma, type ConversationStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { recordConversationEvent } from "@/lib/inbox/events";
import { emitToTeam } from "@/lib/socket/server";

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
    select: { id: true, status: true },
  });
  if (!conversation) return advanceWithError(404, "conversation not found");
  const previousStatus = conversation.status as ConversationStatus;
  if (previousStatus === status && !extras.closedCategory && !extras.closedSummary) {
    return advance({ skipped: "already_in_target_status" });
  }

  try {
    await db.conversation.update({
      where: { id: conversationId, teamId: ctx.teamId, status: previousStatus },
      data: {
        status,
        // Analytics: stamp closedAt + close metadata when transitioning to closed;
        // wipe them on reopen so the next close cycle measures from scratch.
        ...(status === "closed"
          ? {
              closedAt: new Date(),
              closedByUserId: null,
              ...(extras.closedCategory !== undefined
                ? { closedCategory: extras.closedCategory }
                : {}),
              ...(extras.closedSummary !== undefined
                ? { closedSummary: extras.closedSummary }
                : {}),
            }
          : {}),
        ...(previousStatus === "closed" && status !== "closed"
          ? {
              closedAt: null,
              closedByUserId: null,
              closedCategory: null,
              closedSummary: null,
            }
          : {}),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return advanceWithError(409, "conversation status changed by someone else");
    }
    throw err;
  }

  emitToTeam(ctx.teamId, "conversation:status", {
    teamId: ctx.teamId,
    conversationId,
    status,
  });

  await recordConversationEvent({
    conversationId,
    teamId: ctx.teamId,
    userId: null,
    kind: "status_changed",
    before: { status: previousStatus },
    after: { status },
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
