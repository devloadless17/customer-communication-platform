import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";

/**
 * Per-conversation native-AI state machine (correction #2).
 *
 *   ai_active     — the assistant may auto-reply.
 *   human_active  — an agent replied; the assistant is quiet, but this is NOT a
 *                   permanent pause. It CANCELS any in-flight AI turn and yields.
 *   ai_paused     — an agent explicitly paused; sticky until an agent resumes.
 *   disabled      — the assistant is off for this thread entirely.
 *
 * Default resumption: a human reply -> human_active; the NEXT customer inbound
 * auto-resumes to ai_active. Only an explicit agent pause (ai_paused) survives
 * further customer messages.
 */

export type AiConvState = "ai_active" | "human_active" | "ai_paused" | "disabled";

export interface AiConvStateRow {
  conversationId: string;
  teamId: string;
  state: AiConvState;
  pausedByUserId: string | null;
  pausedAt: Date | null;
  autoReplyCount: number;
}

/** Fire-and-forget realtime signal that a conversation's AI state changed. */
function emitState(teamId: string, conversationId: string, state: AiConvState): void {
  void publish({ type: "ai.state_changed", teamId, conversationId, state }).catch(() => {});
}

async function ensureState(teamId: string, conversationId: string): Promise<AiConvStateRow> {
  const existing = await db.aiConversationState.findUnique({ where: { conversationId } });
  if (existing) return existing as AiConvStateRow;
  try {
    return (await db.aiConversationState.create({
      data: { teamId, conversationId, state: "ai_active" },
    })) as AiConvStateRow;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      const row = await db.aiConversationState.findUnique({ where: { conversationId } });
      if (row) return row as AiConvStateRow;
    }
    throw err;
  }
}

export async function getState(conversationId: string): Promise<AiConvStateRow | null> {
  return (await db.aiConversationState.findUnique({
    where: { conversationId },
  })) as AiConvStateRow | null;
}

/**
 * A human agent sent a message. Cancel any pending AI turn by moving ai_active
 * -> human_active (the orchestrator's pre-send re-check reads this and aborts).
 * paused/disabled are left as-is. Never permanently pauses.
 */
export async function onHumanReply(
  teamId: string,
  conversationId: string,
  userId?: string | null,
): Promise<AiConvStateRow> {
  const s = await ensureState(teamId, conversationId);
  if (s.state === "ai_active") {
    const row = (await db.aiConversationState.update({
      where: { conversationId },
      data: {
        state: "human_active",
        stateChangedAt: new Date(),
        autoReplyCount: 0,
        pausedByUserId: userId ?? null,
      },
    })) as AiConvStateRow;
    emitState(teamId, conversationId, "human_active");
    return row;
  }
  // human_active / ai_paused / disabled: just reset the auto-reply counter.
  return (await db.aiConversationState.update({
    where: { conversationId },
    data: { autoReplyCount: 0 },
  })) as AiConvStateRow;
}

/**
 * A customer sent an inbound. Auto-resume human_active -> ai_active (the default
 * resumption). paused/disabled stay put. Returns the post-transition state.
 */
export async function onCustomerInbound(
  teamId: string,
  conversationId: string,
): Promise<AiConvStateRow> {
  const s = await ensureState(teamId, conversationId);
  if (s.state === "human_active") {
    const row = (await db.aiConversationState.update({
      where: { conversationId },
      data: { state: "ai_active", stateChangedAt: new Date(), autoReplyCount: 0 },
    })) as AiConvStateRow;
    emitState(teamId, conversationId, "ai_active");
    return row;
  }
  return s;
}

// --- explicit agent controls (inbox header actions) ---

export async function pauseByAgent(teamId: string, conversationId: string, userId: string) {
  await ensureState(teamId, conversationId);
  const row = await db.aiConversationState.update({
    where: { conversationId },
    data: { state: "ai_paused", pausedByUserId: userId, pausedAt: new Date(), stateChangedAt: new Date() },
  });
  emitState(teamId, conversationId, "ai_paused");
  return row;
}

export async function resumeByAgent(teamId: string, conversationId: string) {
  await ensureState(teamId, conversationId);
  const row = await db.aiConversationState.update({
    where: { conversationId },
    data: { state: "ai_active", pausedByUserId: null, pausedAt: null, stateChangedAt: new Date(), autoReplyCount: 0 },
  });
  emitState(teamId, conversationId, "ai_active");
  return row;
}

/** "Take over" = agent grabs the thread (human_active). */
export async function takeOverByAgent(teamId: string, conversationId: string, userId: string) {
  await ensureState(teamId, conversationId);
  const row = await db.aiConversationState.update({
    where: { conversationId },
    data: { state: "human_active", pausedByUserId: userId, stateChangedAt: new Date() },
  });
  emitState(teamId, conversationId, "human_active");
  return row;
}

export async function setDisabled(teamId: string, conversationId: string, disabled: boolean) {
  await ensureState(teamId, conversationId);
  const nextState: AiConvState = disabled ? "disabled" : "ai_active";
  const row = await db.aiConversationState.update({
    where: { conversationId },
    data: { state: nextState, stateChangedAt: new Date() },
  });
  emitState(teamId, conversationId, nextState);
  return row;
}

/**
 * Escalation handoff: the customer asked for a human, so the assistant yields
 * the thread and stays quiet. Uses ai_paused (STICKY) rather than human_active
 * so the AI does NOT auto-resume on the customer's next message — the human now
 * owns it until an agent explicitly resumes. `agentUserId` is the auto-assigned
 * agent (recorded as who it was handed to), or null if none was available.
 */
export async function handoffToHuman(
  teamId: string,
  conversationId: string,
  agentUserId: string | null,
) {
  await ensureState(teamId, conversationId);
  const row = await db.aiConversationState.update({
    where: { conversationId },
    data: {
      state: "ai_paused",
      pausedByUserId: agentUserId,
      pausedAt: new Date(),
      stateChangedAt: new Date(),
    },
  });
  emitState(teamId, conversationId, "ai_paused");
  return row;
}

/**
 * CURRENTLY UNUSED — superseded by `handoffToHuman` above. The live escalate
 * path (orchestrator.ts) calls `handoffToHuman` + `assignConversation`, not this.
 * Kept only as the intended system-initiated variant (no assignee yet, sticky
 * `ai_paused`, idempotent on already paused/disabled). Do NOT edit this expecting
 * a production effect — wire it up first, or change `handoffToHuman` instead.
 */
export async function escalateToHuman(
  teamId: string,
  conversationId: string,
): Promise<AiConvStateRow> {
  const s = await ensureState(teamId, conversationId);
  if (s.state === "ai_paused" || s.state === "disabled") return s;
  const row = (await db.aiConversationState.update({
    where: { conversationId },
    data: { state: "ai_paused", pausedByUserId: null, pausedAt: new Date(), stateChangedAt: new Date() },
  })) as AiConvStateRow;
  emitState(teamId, conversationId, "ai_paused");
  return row;
}

export async function incrementAutoReply(conversationId: string) {
  return db.aiConversationState.update({
    where: { conversationId },
    data: { autoReplyCount: { increment: 1 } },
  });
}
