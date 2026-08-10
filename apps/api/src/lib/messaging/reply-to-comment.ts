import {
  conversationRelationWhere,
  type ConversationViewer,
} from "@/lib/conversations/visibility";
import { db } from "@/lib/db";
import { getProviderBinding } from "@/lib/providers";
import { recordConversationEvent } from "@/lib/inbox/events";
import { asCommentStructured } from "@/lib/messaging/private-reply";

/**
 * Reply PUBLICLY to an Instagram comment, from the thread it landed in.
 *
 * The comments feature has two answers, and they are not interchangeable:
 *
 *   - PRIVATE reply (`send-text-internal`) — opens a DM with that one person,
 *     one per comment within 7 days, seen by nobody else.
 *   - PUBLIC reply (this) — a sub-thread comment everyone reading the post sees,
 *     no cap, and it starts no conversation at all.
 *
 * A team answering "where do you ship?" usually wants both: the DM to that
 * customer, and the public answer for the twenty people about to ask the same
 * thing. Shipping only the private one would have made the public answer
 * impossible without leaving the product.
 *
 * Deliberately NOT written as an outbound `Message`. A public reply is not part
 * of the conversation — it has no recipient, it does not consume the messaging
 * window, and Meta returns a COMMENT id, not a message id. Recording it as a
 * message would put a bubble in a thread the customer never received, and would
 * make it look like the private reply had been spent. It lands on the audit
 * timeline instead, which is exactly what it is: something an agent did.
 */

export class ReplyToCommentError extends Error {
  code:
    | "message_not_found"
    | "not_a_comment"
    | "public_reply_not_supported"
    | "provider_rejected";
  detail?: string;

  constructor(code: ReplyToCommentError["code"], message: string, detail?: string) {
    super(message);
    this.name = "ReplyToCommentError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export async function replyToCommentPublicly(args: {
  workspaceId: string;
  /** OUR `Message.id` for the inbound comment being answered. */
  messageId: string;
  body: string;
  userId: string | null;
  apiKeyId?: string | null;
  /**
   * The session, when a person (not an API key) is replying. The route is
   * keyed on a bare message id, so the controller's conversation-visibility
   * guard never fires — without this filter a restricted agent could post a
   * PUBLIC reply on a colleague's comment thread (and confirm the message
   * exists). Same shape as `forward`/`dismissReaction`.
   */
  viewer?: ConversationViewer | null;
}): Promise<{ commentId: string }> {
  const { workspaceId, messageId } = args;
  const body = args.body.trim();
  if (!body) {
    throw new ReplyToCommentError("provider_rejected", "reply text is required");
  }

  const message = await db.message.findFirst({
    where: {
      id: messageId,
      workspaceId,
      ...(args.viewer ? conversationRelationWhere(args.viewer) : {}),
    },
    select: {
      id: true,
      structured: true,
      channel: true,
      conversationId: true,
      // The account the comment ARRIVED on — the reply must go out through the
      // same handle's credentials, not the workspace default.
      channelConnectionId: true,
    },
  });
  if (!message) {
    throw new ReplyToCommentError("message_not_found", "message not found");
  }

  // ONE definition of "is this a repliable comment", shared with the private-reply
  // path. Both read the same JSONB column for the same field, and both send the
  // `commentId` straight to Meta as an address — so a cast here (which asserts a
  // shape nothing checked) could carry an `undefined` into the request as
  // `/undefined/replies`. The column is untrusted input: rows can predate the
  // current writer, be hand-edited, or come from a webhook shape that has changed.
  const comment = asCommentStructured(message.structured);
  if (!comment) {
    // Answering a DM "publicly" is meaningless — there is no public surface.
    throw new ReplyToCommentError("not_a_comment", "this message is not a comment");
  }

  const binding = getProviderBinding(message.channel);
  if (!binding.provider.capabilities.publicCommentReply || !binding.provider.replyToComment) {
    throw new ReplyToCommentError(
      "public_reply_not_supported",
      `public comment replies are not supported on ${message.channel}`,
    );
  }

  const config = await binding.getSendConfig(workspaceId, message.channelConnectionId);
  let result: { commentId: string };
  try {
    result = await binding.provider.replyToComment(comment.commentId, body, config);
  } catch (err) {
    throw new ReplyToCommentError(
      "provider_rejected",
      "the provider rejected the reply",
      err instanceof Error ? err.message.slice(0, 300) : String(err),
    );
  }

  await recordConversationEvent({
    conversationId: message.conversationId,
    workspaceId,
    userId: args.userId,
    apiKeyId: args.apiKeyId ?? null,
    kind: "note_added",
    after: {
      action: "public_comment_reply",
      inReplyToMessageId: message.id,
      commentId: result.commentId,
      body,
    },
  });

  return result;
}
