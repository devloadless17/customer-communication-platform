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
  teamId: string;
  conversationId: string;
  inboundMessageId: string;
  payload: ReplyPayload;
  usedChunkIds: string[];
  channelMode: "text" | "voice" | "match_customer" | "text_and_voice";
  audioR2Key?: string | null;
}

export async function persistSuggestion(args: PersistSuggestionArgs) {
  const { teamId, conversationId, inboundMessageId } = args;
  const expiresAt = new Date(Date.now() + SUGGESTION_TTL_MS);

  const created = await db.$transaction(async (tx) => {
    const current = await tx.aiReplySuggestion.findFirst({
      where: { teamId, inboundMessageId, state: "pending" },
    });
    const agg = await tx.aiReplySuggestion.aggregate({
      where: { teamId, inboundMessageId },
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
        teamId,
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
    teamId,
    conversationId,
    suggestionId: created.id,
    state: "pending",
  }).catch(() => {});

  return created;
}

export async function getPendingSuggestion(teamId: string, conversationId: string) {
  return db.aiReplySuggestion.findFirst({
    where: { teamId, conversationId, state: "pending" },
    orderBy: { createdAt: "desc" },
  });
}
