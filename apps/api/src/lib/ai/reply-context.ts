import { db } from "@/lib/db";

import type { MemoryItem, RecentMessage } from "./prompt-builder";
import { loadConversationMeta, loadRecentMessages } from "./thread";

/**
 * Shared reply-context loader used by both the orchestrator and Regenerate, so
 * a regenerated draft is grounded in exactly the same context the original was.
 */
export async function loadReplyContext(
  workspaceId: string,
  conversationId: string,
): Promise<{ memory: MemoryItem[]; recentMessages: RecentMessage[] }> {
  const meta = await loadConversationMeta(conversationId);
  const memory = meta?.customerId
    ? (
        await db.aiCustomerMemory.findMany({
          where: { workspaceId, customerId: meta.customerId, status: "confirmed" },
          orderBy: { updatedAt: "desc" },
          take: 40,
          select: { kind: true, value: true },
        })
      ).map((m) => ({ kind: m.kind as string, value: m.value }))
    : [];
  const recentMessages = await loadRecentMessages(conversationId, 20);
  return { memory, recentMessages };
}

/**
 * The inbound customer text for a message — its body, or (for a voice note) the
 * corrected/raw transcript. Used by Regenerate to re-run generation on the same
 * input. Returns null when there is no usable text.
 */
export async function getInboundText(
  messageId: string,
): Promise<{ text: string; isVoice: boolean } | null> {
  const msg = await db.message.findUnique({
    where: { id: messageId },
    select: { body: true, mediaKind: true },
  });
  if (!msg) return null;
  if (msg.mediaKind === "audio") {
    const t = await db.aiMessageTranscription.findUnique({
      where: { messageId },
      select: { transcript: true, correctedText: true },
    });
    return { text: (t?.correctedText || t?.transcript || "").trim(), isVoice: true };
  }
  return { text: (msg.body ?? "").trim(), isVoice: false };
}
