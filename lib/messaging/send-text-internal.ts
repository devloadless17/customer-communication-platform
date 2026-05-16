// Note: no `server-only` import — pulled in by the BullMQ workflow worker
// which boots from server.ts, outside the Next bundler context.

import { Prisma } from "@prisma/client";

import { trackOnOutboundMessage } from "@/lib/conversations/analytics";
import { db } from "@/lib/db";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { emitToTeam } from "@/lib/socket/server";
import type { Message } from "@/lib/types";
import { computeWindowStatus } from "@/lib/window";

/**
 * Slim "send a free-form text to this conversation" helper used by the
 * `send_message` workflow step (and any future internal caller).
 *
 * Differences from /api/messages/route.ts:
 *   - No reply-quoting (workflow steps don't quote)
 *   - Strict 24h window check — outside-window returns a typed error so the
 *     step records a 422 and advances rather than throwing
 *   - senderUserId is always null (system action)
 *
 * Errors are typed; callers map to step results / HTTP responses.
 */

export interface SendTextInternalArgs {
  teamId: string;
  conversationId: string;
  body: string;
  /** Provenance label for raw_payload.sentVia. e.g. "workflow/<id>". */
  sentVia: string;
}

export interface SendTextInternalResult {
  messageId: string;
  externalId: string;
  previewBody: string;
}

export class SendTextValidationError extends Error {
  code:
    | "conversation_not_found"
    | "contact_has_no_phone"
    | "provider_not_configured"
    | "outside_24h_window"
    | "empty_body";
  detail?: string;

  constructor(
    code: SendTextValidationError["code"],
    message: string,
    detail?: string,
  ) {
    super(message);
    this.name = "SendTextValidationError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export async function sendTextInternal(
  args: SendTextInternalArgs,
): Promise<SendTextInternalResult> {
  const receivedAt = new Date();
  const body = args.body.trim();
  if (!body) {
    throw new SendTextValidationError("empty_body", "body is required");
  }

  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, teamId: args.teamId },
    select: { id: true, contact: { select: { phoneNumber: true } } },
  });
  if (!conversation) {
    throw new SendTextValidationError(
      "conversation_not_found",
      "conversation not found",
    );
  }
  if (!conversation.contact.phoneNumber) {
    throw new SendTextValidationError(
      "contact_has_no_phone",
      "contact has no WhatsApp number",
    );
  }

  // 24h window — pre-check on our side so we surface a clean error code
  // instead of letting Meta 422 us with their cryptic body.
  const lastInbound = await db.message.findFirst({
    where: { conversationId: args.conversationId, direction: "in" },
    orderBy: { timestamp: "desc" },
    select: { timestamp: true },
  });
  const win = computeWindowStatus(lastInbound?.timestamp.toISOString() ?? null);
  if (win.state === "closed" || win.state === "never") {
    throw new SendTextValidationError(
      "outside_24h_window",
      "outside_24h_window",
      "24h customer-service window closed — use a template step instead.",
    );
  }

  let sendConfig;
  try {
    sendConfig = await getMetaSendConfig(args.teamId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      throw new SendTextValidationError(
        "provider_not_configured",
        "whatsapp_not_connected",
        err.message,
      );
    }
    throw err;
  }

  const send = await getMetaProvider().sendText(
    { to: conversation.contact.phoneNumber, body },
    sendConfig,
  );

  const created = await createOutboundMessageIdempotent({
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: null,
    body,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: { sentVia: args.sentVia } as Prisma.InputJsonValue,
    timestamp: receivedAt,
  });

  const previewBody = body.slice(0, 200);
  await db.conversation.update({
    where: { id: args.conversationId },
    data: { lastMessageAt: send.timestamp, lastMessagePreview: previewBody },
  });

  const message: Message = {
    id: created.id,
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: null,
    body,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: { sentVia: args.sentVia },
    timestamp: receivedAt.toISOString(),
  };

  emitToTeam(args.teamId, "message:new", {
    teamId: args.teamId,
    conversationId: args.conversationId,
    message,
    preview: previewBody,
    lastMessageAt: send.timestamp.toISOString(),
    unreadDelta: 0,
  });

  void trackOnOutboundMessage({
    conversationId: args.conversationId,
    teamId: args.teamId,
    senderUserId: null,
  });

  return { messageId: created.id, externalId: send.externalId, previewBody };
}
