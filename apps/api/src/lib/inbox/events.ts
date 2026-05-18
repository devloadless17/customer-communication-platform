import "server-only";

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

    await publish({
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
    });
  } catch (err) {
    console.warn("[recordConversationEvent] failed", {
      conversationId: args.conversationId,
      kind: args.kind,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Load the audit timeline for one conversation. Most recent first; cap at
 * `take` rows (default 100) so a thread with thousands of edits doesn't
 * ship the whole history at once. Pagination follows the same keyset
 * pattern used elsewhere — `before` is an ISO cutoff for "older than this."
 */
export async function listConversationEvents(
  teamId: string,
  conversationId: string,
  opts: { take?: number; before?: string } = {},
): Promise<
  Array<{
    id: string;
    kind: ConversationEventKind;
    userId: string | null;
    userName: string | null;
    before: Prisma.JsonValue;
    after: Prisma.JsonValue;
    at: string;
  }>
> {
  const take = Math.min(Math.max(1, opts.take ?? 100), 500);
  const cutoff = opts.before ? new Date(opts.before) : null;

  const rows = await db.conversationEvent.findMany({
    where: {
      conversationId,
      teamId,
      ...(cutoff && !Number.isNaN(cutoff.getTime()) ? { at: { lt: cutoff } } : {}),
    },
    orderBy: { at: "desc" },
    take,
    include: { user: { select: { id: true, name: true } } },
  });

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    userId: r.userId,
    userName: r.user?.name ?? null,
    before: r.before,
    after: r.after,
    at: r.at.toISOString(),
  }));
}
