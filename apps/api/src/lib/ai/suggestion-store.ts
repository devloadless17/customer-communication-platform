import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";

import type { ReplyPayload } from "./reply-schema";

/**
 * Persistence for AI reply drafts, with Regenerate history (P4). "Only one
 * UNRESOLVED (pending) suggestion per inbound" is a partial unique index; to
 * never violate it, persisting a new draft supersedes the current pending one
 * and bumps `attempt` inside a single transaction. Superseded rows are kept as
 * history.
 */

const SUGGESTION_TTL_MS = 24 * 60 * 60 * 1000;

export interface PersistSuggestionArgs {
  workspaceId: string;
  conversationId: string;
  inboundMessageId: string;
  payload: ReplyPayload;
  usedChunkIds: string[];
  channelMode: "text" | "voice" | "match_customer" | "text_and_voice";
  audioR2Key?: string | null;
}

export async function persistSuggestion(args: PersistSuggestionArgs) {
  const { workspaceId, conversationId, inboundMessageId } = args;
  const expiresAt = new Date(Date.now() + SUGGESTION_TTL_MS);

  const created = await db.$transaction(async (tx) => {
    const current = await tx.aiReplySuggestion.findFirst({
      where: { workspaceId, inboundMessageId, state: "pending" },
    });
    const agg = await tx.aiReplySuggestion.aggregate({
      where: { workspaceId, inboundMessageId },
      _max: { attempt: true },
    });
    if (current) {
      // Supersede before inserting the new pending row (partial-unique safety).
      await tx.aiReplySuggestion.update({
        where: { id: current.id },
        data: { state: "superseded" },
      });
    }
    const attempt = (agg._max.attempt ?? 0) + 1;
    return tx.aiReplySuggestion.create({
      data: {
        workspaceId,
        conversationId,
        inboundMessageId,
        text: args.payload.replyText,
        replyLanguage: args.payload.replyLanguage,
        replyScript: args.payload.replyScript,
        channelMode: args.channelMode,
        usedChunkIds: args.usedChunkIds,
        audioR2Key: args.audioR2Key ?? null,
        state: "pending",
        attempt,
        expiresAt,
      },
    });
  });

  void publish({
    type: "ai.suggestion_changed",
    workspaceId,
    conversationId,
    suggestionId: created.id,
    state: "pending",
  }).catch(() => {});

  return created;
}

/**
 * A pending draft is only offerable while it is UNEXPIRED. A draft answers one
 * message at one moment; a day later the thread has moved on, so serving it
 * would put stale text in front of an agent one click from the customer. Every
 * read of a pending draft (here, the inbox overview) and the accept CAS in
 * AiInboxService compose this clause — expiry that nothing reads is not a TTL.
 * Expired rows are left in place (they are the Regenerate history); reaping
 * them is a follow-up sweeper, not this gate.
 */
export function unexpiredPendingWhere(now = new Date()) {
  return { state: "pending" as const, expiresAt: { gt: now } };
}

export async function getPendingSuggestion(workspaceId: string, conversationId: string) {
  return db.aiReplySuggestion.findFirst({
    where: { workspaceId, conversationId, ...unexpiredPendingWhere() },
    orderBy: { createdAt: "desc" },
  });
}
