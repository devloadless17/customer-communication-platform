import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";

/**
 * Per-conversation native-AI state machine (correction #2).
 *
 *   ai_active     — the assistant may auto-reply.
 *   human_active  — an agent replied; the assistant is quiet, but this is NOT a
 *                   permanent pause. It CANCELS any in-flight AI turn and yields.
 *   ai_paused     — an agent explicitly paused; sticky until an agent resumes,
 *                   OR until the conversation closes and the customer reopens
 *                   it (see `resumeOnReopen`, called from ingest.ts).
 *
 * There is deliberately no separate "disable" action anymore — pause/resume
 * is the only agent-facing control (removed 2026-07). `AiConvAutomationState`
 * still carries a `disabled` DB enum member for historic rows only; nothing
 * in application code sets it.
 *
 * Default resumption: a human reply -> human_active; the NEXT customer inbound
 * auto-resumes to ai_active. Only an explicit agent pause (ai_paused) survives
 * further customer messages — except a close+reopen, which also resumes it.
 */

export type AiConvState = "ai_active" | "human_active" | "ai_paused" | "disabled";

export interface AiConvStateRow {
  conversationId: string;
  workspaceId: string;
  state: AiConvState;
  pausedByUserId: string | null;
  pausedAt: Date | null;
  autoReplyCount: number;
}

/** Fire-and-forget realtime signal that a conversation's AI state changed. */
function emitState(workspaceId: string, conversationId: string, state: AiConvState): void {
  void publish({ type: "ai.state_changed", workspaceId, conversationId, state }).catch(() => {});
}

/**
 * `conversationId` is the only unique on this table, so every write below adds
 * `workspaceId` as a non-unique filter (§7: workspaceId in every where). A
 * mismatch can only mean a caller resolved the conversation outside its tenant,
 * which must be loud rather than silently adopted.
 */
async function ensureState(workspaceId: string, conversationId: string): Promise<AiConvStateRow> {
  const existing = await db.aiConversationState.findUnique({ where: { conversationId } });
  if (existing) {
    if (existing.workspaceId !== workspaceId) {
      throw new Error(`ai state workspace mismatch for conversation ${conversationId}`);
    }
    return existing as AiConvStateRow;
  }
  try {
    return (await db.aiConversationState.create({
      data: { workspaceId, conversationId, state: "ai_active" },
    })) as AiConvStateRow;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      const row = await db.aiConversationState.findFirst({ where: { conversationId, workspaceId } });
      if (row) return row as AiConvStateRow;
    }
    throw err;
  }
}

export async function getState(
  workspaceId: string,
  conversationId: string,
): Promise<AiConvStateRow | null> {
  return (await db.aiConversationState.findFirst({
    where: { conversationId, workspaceId },
  })) as AiConvStateRow | null;
}

/**
 * A human agent sent a message. Cancel any pending AI turn by moving ai_active
 * -> human_active (the orchestrator's pre-send re-check reads this and aborts).
 * paused/disabled are left as-is. Never permanently pauses.
 */
export async function onHumanReply(
  workspaceId: string,
  conversationId: string,
  userId?: string | null,
): Promise<AiConvStateRow> {
  const s = await ensureState(workspaceId, conversationId);
  if (s.state === "ai_active") {
    const row = (await db.aiConversationState.update({
      where: { conversationId, workspaceId },
      data: {
        state: "human_active",
        stateChangedAt: new Date(),
        autoReplyCount: 0,
        pausedByUserId: userId ?? null,
      },
    })) as AiConvStateRow;
    emitState(workspaceId, conversationId, "human_active");
    return row;
  }
  // human_active / ai_paused / disabled: just reset the auto-reply counter.
  return (await db.aiConversationState.update({
    where: { conversationId, workspaceId },
    data: { autoReplyCount: 0 },
  })) as AiConvStateRow;
}

/**
 * A customer sent an inbound. Auto-resume human_active -> ai_active (the default
 * resumption). paused/disabled stay put. Returns the post-transition state.
 */
export async function onCustomerInbound(
  workspaceId: string,
  conversationId: string,
): Promise<AiConvStateRow> {
  const s = await ensureState(workspaceId, conversationId);
  if (s.state === "human_active") {
    const row = (await db.aiConversationState.update({
      where: { conversationId, workspaceId },
      data: { state: "ai_active", stateChangedAt: new Date(), autoReplyCount: 0 },
    })) as AiConvStateRow;
    emitState(workspaceId, conversationId, "ai_active");
    return row;
  }
  return s;
}

// --- explicit agent controls (inbox header actions) ---

export async function pauseByAgent(workspaceId: string, conversationId: string, userId: string) {
  await ensureState(workspaceId, conversationId);
  const row = await db.aiConversationState.update({
    where: { conversationId, workspaceId },
    data: { state: "ai_paused", pausedByUserId: userId, pausedAt: new Date(), stateChangedAt: new Date() },
  });
  emitState(workspaceId, conversationId, "ai_paused");
  return row;
}

export async function resumeByAgent(workspaceId: string, conversationId: string) {
  await ensureState(workspaceId, conversationId);
  const row = await db.aiConversationState.update({
    where: { conversationId, workspaceId },
    data: { state: "ai_active", pausedByUserId: null, pausedAt: null, stateChangedAt: new Date(), autoReplyCount: 0 },
  });
  emitState(workspaceId, conversationId, "ai_active");
  return row;
}

/** "Take over" = agent grabs the thread (human_active). */
export async function takeOverByAgent(workspaceId: string, conversationId: string, userId: string) {
  await ensureState(workspaceId, conversationId);
  const row = await db.aiConversationState.update({
    where: { conversationId, workspaceId },
    data: { state: "human_active", pausedByUserId: userId, stateChangedAt: new Date() },
  });
  emitState(workspaceId, conversationId, "human_active");
  return row;
}

/**
 * A closed conversation reopened because the customer messaged again
 * (ingest.ts). Native AI pause is sticky against everything EXCEPT this — a
 * thread the customer walked away from and came back to should have the
 * assistant listening again rather than silently staying paused forever.
 * Only flips ai_paused -> ai_active; human_active is untouched (an agent who
 * took the thread over stays in control across the reopen). No-op (and no
 * event) when the conversation wasn't paused.
 */
export async function resumeOnReopen(workspaceId: string, conversationId: string): Promise<boolean> {
  const res = await db.aiConversationState.updateMany({
    where: { conversationId, workspaceId, state: "ai_paused" },
    data: {
      state: "ai_active",
      pausedByUserId: null,
      pausedAt: null,
      stateChangedAt: new Date(),
      autoReplyCount: 0,
    },
  });
  if (res.count > 0) emitState(workspaceId, conversationId, "ai_active");
  return res.count > 0;
}

/**
 * Escalation handoff: the customer asked for a human, so the assistant yields
 * the thread and stays quiet. Uses ai_paused (STICKY) rather than human_active
 * so the AI does NOT auto-resume on the customer's next message — the human now
 * owns it until an agent explicitly resumes. `agentUserId` is the auto-assigned
 * agent (recorded as who it was handed to), or null if none was available.
 */
export async function handoffToHuman(
  workspaceId: string,
  conversationId: string,
  agentUserId: string | null,
) {
  await ensureState(workspaceId, conversationId);
  const row = await db.aiConversationState.update({
    where: { conversationId, workspaceId },
    data: {
      state: "ai_paused",
      pausedByUserId: agentUserId,
      pausedAt: new Date(),
      stateChangedAt: new Date(),
    },
  });
  emitState(workspaceId, conversationId, "ai_paused");
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
  workspaceId: string,
  conversationId: string,
): Promise<AiConvStateRow> {
  const s = await ensureState(workspaceId, conversationId);
  if (s.state === "ai_paused" || s.state === "disabled") return s;
  const row = (await db.aiConversationState.update({
    where: { conversationId, workspaceId },
    data: { state: "ai_paused", pausedByUserId: null, pausedAt: new Date(), stateChangedAt: new Date() },
  })) as AiConvStateRow;
  emitState(workspaceId, conversationId, "ai_paused");
  return row;
}

export async function incrementAutoReply(workspaceId: string, conversationId: string) {
  return db.aiConversationState.update({
    where: { conversationId, workspaceId },
    data: { autoReplyCount: { increment: 1 } },
  });
}
