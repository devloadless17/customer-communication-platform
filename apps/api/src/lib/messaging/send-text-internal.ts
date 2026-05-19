// Note: no `server-only` import — pulled in by the BullMQ workflow worker
// which boots from server.ts, outside the Next bundler context.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import type { Message } from "@ccp/shared/types";
import { computeWindowStatus } from "@ccp/shared/utils/window";

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
    select: {
      id: true,
      // lastMessageAt feeds the timestamp-ordering guard below. Pulling it
      // here avoids a second roundtrip after the Meta send returns.
      lastMessageAt: true,
      contact: { select: { phoneNumber: true, lastInboundAt: true } },
    },
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
  const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
  const win = computeWindowStatus(lastInboundAt);
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

  // Force the outbound's timestamp to be strictly later than the most
  // recent message on the conversation. Without this, a workflow that
  // replies inside the same wall-clock second as the inbound it's
  // responding to ends up with `new Date()` (ms-precision) BEFORE the
  // inbound's Meta timestamp (seconds-precision, rounded up):
  //
  //   inbound:  timestamp = 14:46:53.000  (Meta's second-precision ts)
  //   outbound: timestamp = 14:46:52.939  (new Date(), happens to be earlier)
  //
  // Inbox sorts by `timestamp ASC`, so the welcome appeared above the
  // message that triggered it. The +1ms bump guarantees strict ordering
  // even when the conversation last-message tick lands later than our
  // wall clock.
  const lastTs = conversation.lastMessageAt ?? null;
  const messageTimestamp =
    lastTs && lastTs >= receivedAt
      ? new Date(lastTs.getTime() + 1)
      : receivedAt;

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
    timestamp: messageTimestamp,
  });

  const previewBody = body.slice(0, 200);
  // Compute the bump inside a tx using FRESH `lastMessageAt` — the value
  // we snapshotted in `conversation.lastMessageAt` above is stale by the
  // Meta-call duration, so a bare UPDATE here could REGRESS the
  // conversation's clock if an inbound webhook landed in that window.
  // Read-then-write guarantees strict monotonicity even under race.
  const bumped = await db.$transaction(async (tx) => {
    const current = await tx.conversation.findUnique({
      where: { id: args.conversationId },
      select: { lastMessageAt: true, unreadCount: true },
    });
    if (!current) {
      throw new SendTextValidationError(
        "conversation_not_found",
        "conversation_disappeared_mid_send",
      );
    }
    const effectiveBump =
      current.lastMessageAt >= messageTimestamp
        ? new Date(current.lastMessageAt.getTime() + 1)
        : messageTimestamp;
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: { lastMessageAt: effectiveBump, lastMessagePreview: previewBody },
    });
    return { lastMessageAt: effectiveBump, unreadCount: current.unreadCount };
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
    timestamp: messageTimestamp.toISOString(),
  };

  // Publish through the bus so socket-fanout emits `message:new` AND the
  // analytics subscriber bumps counters + firstResponseAt. Workflow auto-
  // sends ride exactly the same subscriber chain as user-driven sends.
  await publish({
    type: "message.sent",
    teamId: args.teamId,
    conversationId: args.conversationId,
    message,
    preview: previewBody,
    // The conversation's recency reflects the effective bump (which may be
    // > messageTimestamp if a concurrent write raced ahead). Publishing the
    // stale messageTimestamp here would race the frontend out of sync.
    lastMessageAt: bumped.lastMessageAt.toISOString(),
    // Outbound doesn't bump unread; the row's current value is the
    // accurate absolute count.
    unreadCount: bumped.unreadCount,
    senderUserId: null,
  });

  return { messageId: created.id, externalId: send.externalId, previewBody };
}
