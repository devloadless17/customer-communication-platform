import { type ConversationStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { setConversationStatus } from "@/lib/conversations/mutations";

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

  // Shared business rule (CAS, idempotency, unassign-on-close, event
  // publishing — incl. closedCategory/closedSummary carried to the analytics
  // subscriber) lives in lib/conversations/mutations.ts so a workflow close
  // stays in lockstep with the inbox UI + /v1. `changedByUserId: null` =
  // system; `silent: true` so workflow-dispatch doesn't chain-trigger another
  // workflow mid-run (socket + audit + analytics still fire). Note: unlike the
  // old hand-rolled version, a `close_conversation` step now correctly
  // UNASSIGNS the closed thread (matching the UI close behavior).
  const result = await setConversationStatus({
    db,
    publish,
    teamId: ctx.teamId,
    conversationId,
    status,
    changedByUserId: null,
    silent: true,
    ...(extras.closedCategory !== undefined ? { closedCategory: extras.closedCategory } : {}),
    ...(extras.closedSummary !== undefined ? { closedSummary: extras.closedSummary } : {}),
  });

  if (!result.ok) {
    if (result.reason === "not_found") {
      return advanceWithError(404, "conversation not found");
    }
    return advanceWithError(409, "conversation status changed by someone else");
  }

  if (!result.changed) {
    return advance({ skipped: "already_in_target_status" });
  }

  return advance({
    conversationId,
    previousStatus: result.previousStatus,
    newStatus: status,
    ...(result.unassigned ? { unassigned: true } : {}),
  });
}

export const setStatusStepHandler: StepHandler<SetStatusStepConfig> = {
  type: "set_status",
  sideEffect: "irreversible",
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
