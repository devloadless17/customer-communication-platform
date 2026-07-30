import { COMMENT_PRIVATE_REPLY_WINDOW_MS as PRIVATE_REPLY_WINDOW_MS } from "@ccp/shared/providers/capabilities";
import { db } from "@/lib/db";
import type { MessageStructured } from "@ccp/shared/types";

/**
 * INSTAGRAM PRIVATE REPLIES — answering someone who commented but never messaged.
 *
 * ## The rule this encodes
 *
 * A comment does not open a conversation. Meta grants exactly ONE reply addressed
 * at the comment (`recipient: { comment_id }`), within 7 days of the comment
 * being created, and only once the person answers THAT does the ordinary 24-hour
 * messaging window begin. So for a commenter there are three states, and the send
 * path has to tell them apart:
 *
 *   1. window open (they have DM'd)          → ordinary send, ignore comments
 *   2. window closed, an unanswered comment   → private reply to that comment
 *   3. window closed, nothing to reply to     → refuse, with the usual message
 *
 * Only state 2 is new. It exists ABOVE the window gate rather than inside it,
 * because the whole point is that there is no window yet.
 *
 * ## Why "already replied" is tracked by a message link
 *
 * Meta enforces one-reply-per-comment on its side, so a second attempt fails —
 * but it fails as an opaque Graph error after a billed round trip, and the agent
 * is told nothing useful. Recording the reply as `Message.replyToMessageId`
 * pointing at the comment row gives us a local, indexed answer to "have we used
 * this comment already", reuses a column that already means exactly this, and
 * renders the reply visually under the comment it answers for free.
 */

// Meta's 7-day window comes from @ccp/shared (imported above) rather than being
// redeclared here: the composer decides whether to UNLOCK off the same number,
// and two copies would eventually disagree about whether an agent may type.

export interface PrivateReplyTarget {
  /** Meta's comment id — the send address. */
  commentId: string;
  /** Our `Message.id` for the comment, so the reply can be linked to it. */
  commentMessageId: string;
  /** True for a LIVE comment, whose window is the broadcast, not 7 days. */
  isLive: boolean;
}

/**
 * The comment this conversation may still be answered through, or null.
 *
 * Returns the MOST RECENT eligible comment: if someone commented three times, the
 * newest is both the freshest context and the one with the most window left.
 *
 * Deliberately conservative in two places. A comment older than 7 days is not
 * returned at all — Meta would reject it, and a local refusal is a better error
 * than a billed one. And a comment we have already replied to is skipped rather
 * than retried, because Meta permits exactly one.
 */
export async function resolvePrivateReplyTarget(
  workspaceId: string,
  conversationId: string,
  now: number = Date.now(),
): Promise<PrivateReplyTarget | null> {
  const since = new Date(now - PRIVATE_REPLY_WINDOW_MS);
  // Inbound comments still inside the 7-day window, newest first. The JSON path
  // filter keeps this to comment rows rather than scanning every inbound.
  const comments = await db.message.findMany({
    where: {
      workspaceId,
      conversationId,
      direction: "in",
      createdAt: { gte: since },
      structured: { path: ["kind"], equals: "comment" },
    },
    select: { id: true, structured: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  if (comments.length === 0) return null;

  // Which of them have we already answered? One query for the batch, not one per
  // comment — a thread with several comments is the normal case, not the edge.
  const answered = new Set(
    (
      await db.message.findMany({
        where: {
          workspaceId,
          conversationId,
          direction: "out",
          replyToMessageId: { in: comments.map((c) => c.id) },
        },
        select: { replyToMessageId: true },
      })
    ).flatMap((m) => (m.replyToMessageId ? [m.replyToMessageId] : [])),
  );

  for (const row of comments) {
    if (answered.has(row.id)) continue;
    const comment = asCommentStructured(row.structured);
    if (!comment) continue;
    return {
      commentId: comment.commentId,
      commentMessageId: row.id,
      isLive: comment.isLive === true,
    };
  }
  return null;
}

/** The one variant of {@link MessageStructured} a comment reply can act on. */
export type CommentStructured = Extract<MessageStructured, { kind: "comment" }>;

/**
 * Narrow a JSONB `structured` column to the comment variant, or null.
 *
 * Prisma types the column as `JsonValue`, so getting to `MessageStructured` used
 * to take an `as unknown as` — which asserts a shape nothing has checked. That is
 * a bad trade HERE specifically: `commentId` is the address Meta sends the
 * private reply to, and the row can predate the current writer, be hand-edited,
 * or come from a webhook shape that has since changed. A cast would carry an
 * `undefined` straight into the send as `recipient: { comment_id: undefined }`.
 *
 * So the check is a real one at runtime, and the column stays untrusted input.
 *
 * Exported because every path that answers a comment needs the same narrowing
 * (the public reply in `reply-to-comment.ts` reads the identical column for the
 * identical field) — one definition, so the two cannot disagree about what
 * counts as a repliable comment.
 */
export function asCommentStructured(value: unknown): CommentStructured | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Partial<Record<keyof CommentStructured, unknown>>;
  if (v.kind !== "comment") return null;
  if (typeof v.commentId !== "string" || v.commentId.length === 0) return null;
  return {
    kind: "comment",
    commentId: v.commentId,
    // Only the two fields this module reads are carried through; the rest of the
    // variant is display metadata the caller never touches.
    ...(v.isLive === true ? { isLive: true } : {}),
  };
}
