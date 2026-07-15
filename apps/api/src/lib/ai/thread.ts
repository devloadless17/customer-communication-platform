import { db } from "@/lib/db";

/**
 * Shared read helpers for the AI subsystem: recent thread messages (labeled
 * with AI-authored provenance via AiMessageMetadata) and conversation meta
 * (incl. the person-level customerId resolved through the Contact).
 */

export interface ThreadMessage {
  id: string;
  direction: "in" | "out";
  body: string;
  senderUserId: string | null;
  timestamp: Date;
  aiGenerated: boolean;
}

export async function loadRecentMessages(
  conversationId: string,
  take = 40,
): Promise<ThreadMessage[]> {
  const rows = await db.message.findMany({
    where: { conversationId },
    orderBy: { timestamp: "desc" },
    take,
    select: { id: true, direction: true, body: true, senderUserId: true, timestamp: true },
  });
  const ids = rows.map((r) => r.id);
  const aiMeta = ids.length
    ? await db.aiMessageMetadata.findMany({
        where: { messageId: { in: ids }, aiGenerated: true },
        select: { messageId: true },
      })
    : [];
  const aiSet = new Set(aiMeta.map((m) => m.messageId));
  return rows
    .reverse()
    .map((r) => ({
      id: r.id,
      direction: r.direction as "in" | "out",
      body: r.body,
      senderUserId: r.senderUserId,
      timestamp: r.timestamp,
      aiGenerated: aiSet.has(r.id),
    }));
}

export interface ConversationMeta {
  id: string;
  teamId: string;
  status: string;
  contactId: string;
  channel: string;
  customerId: string | null;
}

export async function loadConversationMeta(
  conversationId: string,
): Promise<ConversationMeta | null> {
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, teamId: true, status: true, contactId: true, channel: true },
  });
  if (!conv) return null;
  const contact = await db.contact.findUnique({
    where: { id: conv.contactId },
    select: { customerId: true },
  });
  return {
    id: conv.id,
    teamId: conv.teamId,
    status: conv.status as string,
    contactId: conv.contactId,
    channel: conv.channel as string,
    customerId: contact?.customerId ?? null,
  };
}

/** Is a given message AI-authored? (loop guard — correction #15, last case.) */
export async function isAiGenerated(messageId: string): Promise<boolean> {
  const row = await db.aiMessageMetadata.findUnique({
    where: { messageId },
    select: { aiGenerated: true },
  });
  return row?.aiGenerated === true;
}
