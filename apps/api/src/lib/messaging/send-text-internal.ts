// Note: no `server-only` import — pulled in by the BullMQ workflow worker in
// the NestJS api process (@swc-node/register), outside the Next bundler
// context.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getProviderBinding } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import type { Message } from "@ccp/shared/types";
import { computeWindowStatus, effectiveSendWindowMs } from "@ccp/shared/utils/window";

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
      contactId: true,
      // Channel is conversation-owned — bind + stamp the send from here, not
      // from the contact (resolveContactChannel only supplies the destination).
      channel: true,
      // lastMessageAt feeds the timestamp-ordering guard below. Pulling it
      // here avoids a second roundtrip after the Meta send returns.
      lastMessageAt: true,
      contact: {
        select: {
          phoneNumber: true,
          identityChannel: true,
          externalContactId: true,
          lastInboundAt: true,
        },
      },
    },
  });
  if (!conversation) {
    throw new SendTextValidationError(
      "conversation_not_found",
      "conversation not found",
    );
  }

  // Resolve the destination ADDRESS from the contact's identity (replaces the
  // bare `phoneNumber` read so non-phone channels route too). The PROVIDER is
  // owned by the conversation row — the source of truth for which channel this
  // thread sends on. They're equal by construction today (siloed, immutable-
  // identity contacts), so this is a WhatsApp no-op; it keeps the conversation
  // authoritative if a contact's channel ever diverges.
  let channel;
  try {
    channel = resolveContactChannel(conversation.contact);
  } catch (err) {
    if (err instanceof NoChannelDestinationError) {
      throw new SendTextValidationError(
        "contact_has_no_phone",
        "contact has no reachable address",
      );
    }
    throw err;
  }
  const provider = conversation.channel;
  const binding = getProviderBinding(provider);

  // Free-form send window — pre-check on our side so we surface a clean error
  // code instead of letting the provider reject with a cryptic body. Driven by
  // the provider's declared window; `null` means the channel has no free-form
  // window restriction (e.g. Telegram), so the check is skipped entirely.
  const windowMs = effectiveSendWindowMs(binding.provider.capabilities);
  if (windowMs !== null) {
    const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
    const win = computeWindowStatus(lastInboundAt, Date.now(), windowMs);
    if (win.state === "closed" || win.state === "never") {
      throw new SendTextValidationError(
        "outside_24h_window",
        "outside_24h_window",
        "24h customer-service window closed — use a template step instead.",
      );
    }
  }

  let sendConfig;
  try {
    sendConfig = await binding.getSendConfig(args.teamId);
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

  const send = await binding.provider.sendText(
    { to: channel.to, body },
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
    channel: provider,
    status: "sent",
    rawPayload: { sentVia: args.sentVia } as Prisma.InputJsonValue,
    timestamp: messageTimestamp,
  });

  const previewBody = body.slice(0, 200);
  const message: Message = {
    id: created.id,
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: null,
    body,
    direction: "out",
    channel: provider,
    status: "sent",
    rawPayload: { sentVia: args.sentVia },
    timestamp: messageTimestamp.toISOString(),
  };

  // Strict-monotonic bump + atomic message.sent publish, unified in
  // commitOutboundSend (see that file for the full rationale).
  await commitOutboundSend({
    conversationId: args.conversationId,
    bumpTimestamp: messageTimestamp,
    preview: previewBody,
    event: {
      type: "message.sent",
      teamId: args.teamId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      message,
      preview: previewBody,
      senderUserId: null,
    },
    onMissing: () => {
      throw new SendTextValidationError(
        "conversation_not_found",
        "conversation_disappeared_mid_send",
      );
    },
  });

  return { messageId: created.id, externalId: send.externalId, previewBody };
}
