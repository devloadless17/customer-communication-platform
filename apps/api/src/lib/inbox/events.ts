import { type ConversationEventKind, Prisma } from "@prisma/client";

import { db } from "@/lib/db";

/**
 * Conversation audit timeline writer.
 *
 *   recordConversationEvent({ conversationId, workspaceId, userId, kind, before?, after? })
 *
 * Writes the ConversationEvent row. Best-effort: a DB failure here logs and
 * continues — the original state mutation (assign / status / tag) has
 * already succeeded by the time we get here and the audit gap on a single
 * event isn't worth surfacing as an error to the agent.
 *
 * `before` / `after` shapes are documented per-kind on the Prisma model.
 * Callers pass plain JSON-serializable objects; the schema column is JSONB.
 */

interface RecordArgs {
  conversationId: string;
  workspaceId: string;
  userId: string | null;
  /** Set on external /v1 mutations so the audit row attributes the change
   *  to the API key instead of leaving userId null + opaque. */
  apiKeyId?: string | null;
  /** Set on workflow-step-driven mutations so the audit row attributes the
   *  change to the automation instead of leaving every actor field null. */
  workflowId?: string | null;
  kind: ConversationEventKind;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** When the action actually happened. Defaults to write-time `now()` when
   *  omitted — but the audit subscriber runs ASYNC (drainer + background tier),
   *  so write-time can land AFTER a message the agent sent a beat later,
   *  inverting the timeline order. Callers that have the action time (e.g. the
   *  ai_changed handler via the event's occurredAt) pass it so the pill sorts
   *  where it happened, not where it was written. */
  at?: Date | string;
}

export async function recordConversationEvent(args: RecordArgs): Promise<void> {
  try {
    // Prisma differentiates explicit JSON-null from "leave as DB default" —
    // `Prisma.JsonNull` is the explicit-null sentinel; `undefined` skips the
    // column. We pass `JsonNull` when the caller didn't supply a payload so
    // both `before` and `after` are explicitly present on read paths.
    await db.conversationEvent.create({
      data: {
        conversationId: args.conversationId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        apiKeyId: args.apiKeyId ?? null,
        workflowId: args.workflowId ?? null,
        kind: args.kind,
        ...(args.at ? { at: new Date(args.at) } : {}),
        before:
          args.before == null
            ? Prisma.JsonNull
            : (args.before as Prisma.InputJsonValue),
        after:
          args.after == null
            ? Prisma.JsonNull
            : (args.after as Prisma.InputJsonValue),
      },
    });
  } catch (err) {
    console.warn("[recordConversationEvent] failed", {
      conversationId: args.conversationId,
      kind: args.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

