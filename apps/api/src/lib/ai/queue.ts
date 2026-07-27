import { Queue } from "bullmq";

import { connectionOptions } from "@/lib/workflows/queue";

/**
 * The `ai-replies` BullMQ queue. Three job kinds share it: `reply` (generate +
 * send/suggest, on the critical path), and `summary` / `memory` (post-reply,
 * idempotent, must never block the reply — correction #14). jobIds are keyed by
 * inboundMessageId so at-least-once event delivery can't double-enqueue.
 */

export const AI_QUEUE_NAME = "ai-replies";

export type AiJob =
  | {
      kind: "reply";
      workspaceId: string;
      conversationId: string;
      inboundMessageId: string;
      text: string;
      isVoice: boolean;
    }
  | { kind: "summary"; conversationId: string; inboundMessageId: string }
  | { kind: "memory"; conversationId: string; inboundMessageId: string | null };

const g = globalThis as unknown as { __ccpAiQueue?: Queue<AiJob> };

export function getAiQueue(): Queue<AiJob> {
  if (g.__ccpAiQueue) return g.__ccpAiQueue;
  g.__ccpAiQueue = new Queue<AiJob>(AI_QUEUE_NAME, {
    connection: connectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 24 * 3600, count: 2000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 2000 },
    },
  });
  return g.__ccpAiQueue;
}

export async function enqueueAiReply(data: {
  workspaceId: string;
  conversationId: string;
  inboundMessageId: string;
  text: string;
  isVoice: boolean;
  /** Debounce window: wait this many seconds after the LAST inbound before
   *  replying, so a burst of chunked messages yields ONE answer. 0 = immediate.
   *  Clamped to [0, 120]. */
  waitSeconds?: number;
}): Promise<void> {
  const q = getAiQueue();
  const jobData: AiJob = {
    kind: "reply",
    workspaceId: data.workspaceId,
    conversationId: data.conversationId,
    inboundMessageId: data.inboundMessageId,
    text: data.text,
    isVoice: data.isVoice,
  };
  const wait = Math.max(0, Math.min(120, Math.floor(data.waitSeconds ?? 0)));

  if (wait > 0) {
    // Debounce: coalesce a burst into one reply. Reset the timer by removing
    // the pending delayed reply for THIS conversation, then re-adding with the
    // newest message's data. Keyed by conversation (not message). The atomic
    // claim (claimInbound, per inboundMessageId) still guards against any
    // double-reply if a remove races a job that just started.
    const jobId = `ai-reply-conv-${data.conversationId}`;
    const existing = await q.getJob(jobId).catch(() => null);
    if (existing) {
      const state = await existing.getState().catch(() => "unknown");
      if (state === "delayed" || state === "waiting") {
        await existing.remove().catch(() => {});
      } else {
        // The debounce slot is occupied by a job we CANNOT replace: an active
        // job is locked (remove is a no-op), and a completed/failed one still
        // holds the id, so `add` with the same jobId is silently ignored by
        // BullMQ and returns the OLD job. That silently DROPPED this message —
        // the assistant simply never answered it, and never would unless a
        // third message arrived after the job finished. Fall back to the
        // per-message id so the message is answered instead of lost. Not a
        // double-reply risk: `claimInbound` is keyed per inboundMessageId, and
        // these are two different inbound messages.
        await q.add("reply", jobData, {
          jobId: `ai-reply-${data.inboundMessageId}`,
          delay: wait * 1000,
        });
        return;
      }
    }
    await q.add("reply", jobData, { jobId, delay: wait * 1000 });
    return;
  }

  // Immediate (no debounce): keep the per-message jobId for at-least-once dedup.
  await q.add("reply", jobData, { jobId: `ai-reply-${data.inboundMessageId}` });
}

export async function enqueueAiPost(
  conversationId: string,
  inboundMessageId: string,
): Promise<void> {
  const q = getAiQueue();
  await q.add(
    "summary",
    { kind: "summary", conversationId, inboundMessageId },
    { jobId: `ai-summary-${inboundMessageId}` },
  );
  await q.add(
    "memory",
    { kind: "memory", conversationId, inboundMessageId },
    { jobId: `ai-memory-${inboundMessageId}` },
  );
}

/**
 * Final memory-extraction pass when a chat closes (session end). Consolidates
 * durable interests/preferences for the person so they seed FUTURE chats.
 * Idempotent: the memory job dedups on (workspaceId, customerId, kind, value), and
 * the per-conversation jobId collapses repeated close events.
 */
export async function enqueueAiMemoryOnClose(conversationId: string): Promise<void> {
  await getAiQueue().add(
    "memory",
    { kind: "memory", conversationId, inboundMessageId: null },
    { jobId: `ai-memory-close-${conversationId}` },
  );
}

export async function closeAiQueue(): Promise<void> {
  if (g.__ccpAiQueue) {
    await g.__ccpAiQueue.close();
    g.__ccpAiQueue = undefined;
  }
}
