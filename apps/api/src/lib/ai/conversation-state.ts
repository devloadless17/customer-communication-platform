import { db } from "@/lib/db";

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
    return (await db.aiConversationState.update({
      where: { conversationId },
      data: {
        state: "human_active",
        stateChangedAt: new Date(),
        autoReplyCount: 0,
        pausedByUserId: userId ?? null,
      },
    })) as AiConvStateRow;
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
    return (await db.aiConversationState.update({
      where: { conversationId },
      data: { state: "ai_active", stateChangedAt: new Date(), autoReplyCount: 0 },
    })) as AiConvStateRow;
  }
  return s;
}

// --- explicit agent controls (inbox header actions) ---

export async function pauseByAgent(teamId: string, conversationId: string, userId: string) {
  await ensureState(teamId, conversationId);
  return db.aiConversationState.update({
    where: { conversationId },
    data: { state: "ai_paused", pausedByUserId: userId, pausedAt: new Date(), stateChangedAt: new Date() },
  });
}

export async function resumeByAgent(teamId: string, conversationId: string) {
  await ensureState(teamId, conversationId);
  return db.aiConversationState.update({
    where: { conversationId },
    data: { state: "ai_active", pausedByUserId: null, pausedAt: null, stateChangedAt: new Date(), autoReplyCount: 0 },
  });
}

/** "Take over" = agent grabs the thread (human_active). */
export async function takeOverByAgent(teamId: string, conversationId: string, userId: string) {
  await ensureState(teamId, conversationId);
  return db.aiConversationState.update({
    where: { conversationId },
    data: { state: "human_active", pausedByUserId: userId, stateChangedAt: new Date() },
  });
}

export async function setDisabled(teamId: string, conversationId: string, disabled: boolean) {
  await ensureState(teamId, conversationId);
  return db.aiConversationState.update({
    where: { conversationId },
    data: { state: disabled ? "disabled" : "ai_active", stateChangedAt: new Date() },
  });
}

export async function incrementAutoReply(conversationId: string) {
  return db.aiConversationState.update({
    where: { conversationId },
    data: { autoReplyCount: { increment: 1 } },
  });
}
