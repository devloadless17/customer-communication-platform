import { type ConversationEventKind, Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";

/**
 * Conversation audit timeline writer.
 *
 *   recordConversationEvent({ conversationId, teamId, userId, kind, before?, after? })
 *
 * Writes the ConversationEvent row and emits `conversation:event` to the
 * team room so any live history-panel viewer can prepend it without a
 * refetch. Best-effort: a DB failure here logs and continues — the original
 * state mutation (assign / status / tag) has already succeeded by the time
 * we get here and the audit gap on a single event isn't worth surfacing as
 * an error to the agent.
 *
 * `before` / `after` shapes are documented per-kind on the Prisma model.
 * Callers pass plain JSON-serializable objects; the schema column is JSONB.
 */

interface RecordArgs {
  conversationId: string;
  teamId: string;
  userId: string | null;
  /** Set on external /v1 mutations so the audit row attributes the change
   *  to the API key instead of leaving userId null + opaque. */
  apiKeyId?: string | null;
  kind: ConversationEventKind;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export async function recordConversationEvent(args: RecordArgs): Promise<void> {
  try {
    // Prisma differentiates explicit JSON-null from "leave as DB default" —
    // `Prisma.JsonNull` is the explicit-null sentinel; `undefined` skips the
    // column. We pass `JsonNull` when the caller didn't supply a payload so
    // both `before` and `after` are explicitly present on read paths.
    const created = await db.conversationEvent.create({
      data: {
        conversationId: args.conversationId,
        teamId: args.teamId,
        userId: args.userId,
        apiKeyId: args.apiKeyId ?? null,
        kind: args.kind,
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
    const author =
      created.userId != null
        ? await db.user.findUnique({
            where: { id: created.userId },
            select: { name: true },
          })
        : null;

    // Detach the inner publish so we don't tie up the outer subscriber's
    // call frame.
    //
    // recordConversationEvent is most commonly invoked from the audit bus
    // subscriber (audit.ts), which itself runs INSIDE an outer `publish()`
    // call frame (the conversation.assigned/status_changed/note.* event).
    // The bus runs subscribers serially with `await`, so a synchronous
    // `await publish(conversation.event_recorded)` here delays every
    // subsequent subscriber of the outer event — analytics + workflow-
    // dispatch + outbound-webhooks all wait on the nested DB write +
    // socket emit chain finishing first.
    //
    // Fire-and-forget is safe: the DB row has been committed above, so the
    // history panel re-fetches the row on next render even if the realtime
    // emit gets lost. The publish itself never throws (bus catches inside
    // the subscriber loop) — the `.catch` is belt-and-braces logging only.
    void publish({
      type: "conversation.event_recorded",
      teamId: args.teamId,
      conversationId: args.conversationId,
      event: {
        id: created.id,
        kind: created.kind,
        userId: created.userId,
        userName: author?.name ?? null,
        before: created.before,
        after: created.after,
        at: created.at.toISOString(),
      },
    }).catch((err) => {
      console.warn("[recordConversationEvent] inner publish failed", {
        conversationId: args.conversationId,
        eventId: created.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err) {
    console.warn("[recordConversationEvent] failed", {
      conversationId: args.conversationId,
      kind: args.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

