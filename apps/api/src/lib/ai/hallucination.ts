import { db } from "@/lib/db";

/**
 * Per-conversation hallucination rollup, built on the same per-message
 * self-score the reply generator writes to AiMessageMetadata (see
 * reply-schema.ts). Kept off Message/Conversation (correction #1 pattern —
 * same reason AiMessageMetadata itself is a side table) and computed on read
 * rather than denormalized, since it's a light aggregate over a handful of
 * AI-authored messages per conversation, not a hot list-view field.
 */

// Messages scored at/above this are surfaced to the agent as "worth a second
// look" — chosen to match the reply prompt's own framing (any claim NOT
// grounded gets flagged there, so even a modest score is worth a re-check;
// a lower bar than raw 0.5 would bury a real flag among rounding noise).
export const HALLUCINATION_FLAG_THRESHOLD = 0.35;

export interface FlaggedMessage {
  messageId: string;
  risk: number;
  notes: string | null;
}

export interface ConversationHallucinationSummary {
  /** Average risk across scored AI messages, 0-100. Null when none are scored yet. */
  ratePercent: number | null;
  scoredCount: number;
  flagged: FlaggedMessage[];
}

/**
 * How far back the rollup looks. AiMessageMetadata carries only a scalar
 * `messageId` (no `conversation` relation to filter through — see the note on
 * assertMessageVisible in ai-inbox.service.ts), so the scope is an IN list of
 * message ids, and that list has to be BOUNDED: this runs on every AI-panel
 * hydrate and every suggestion frame, and an unbounded one loaded every id in
 * a year-old thread to score a handful of AI replies. Outbound only — metadata
 * is written by the reply paths, which only ever author outbound rows. The
 * window is served by the ([conversationId, timestamp desc, id desc]) index.
 */
const SCAN_MESSAGES = 300;
/** The panel lists these; a runaway thread must not ship hundreds of rows. */
const MAX_FLAGGED = 25;

export async function getConversationHallucinationSummary(
  workspaceId: string,
  conversationId: string,
): Promise<ConversationHallucinationSummary> {
  const messages = await db.message.findMany({
    where: { workspaceId, conversationId, direction: "out" },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: SCAN_MESSAGES,
    select: { id: true },
  });
  if (!messages.length) return { ratePercent: null, scoredCount: 0, flagged: [] };

  const rows = await db.aiMessageMetadata.findMany({
    where: {
      workspaceId,
      messageId: { in: messages.map((m) => m.id) },
      aiGenerated: true,
      hallucinationRisk: { not: null },
    },
    select: { messageId: true, hallucinationRisk: true, hallucinationNotes: true },
  });
  if (!rows.length) return { ratePercent: null, scoredCount: 0, flagged: [] };

  const sum = rows.reduce((acc, r) => acc + (r.hallucinationRisk ?? 0), 0);
  const flagged = rows
    .filter((r) => (r.hallucinationRisk ?? 0) >= HALLUCINATION_FLAG_THRESHOLD)
    .map((r) => ({
      messageId: r.messageId,
      risk: r.hallucinationRisk ?? 0,
      notes: r.hallucinationNotes,
    }))
    .slice(0, MAX_FLAGGED);

  return {
    ratePercent: Math.round((sum / rows.length) * 100),
    scoredCount: rows.length,
    flagged,
  };
}
