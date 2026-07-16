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
      teamId: string;
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
  teamId: string;
  conversationId: string;
  inboundMessageId: string;
  text: string;
  isVoice: boolean;
}): Promise<void> {
  await getAiQueue().add(
    "reply",
    { kind: "reply", ...data },
    { jobId: `ai-reply-${data.inboundMessageId}` },
  );
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
 * Idempotent: the memory job dedups on (teamId, customerId, kind, value), and
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
