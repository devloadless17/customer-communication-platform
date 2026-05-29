// Note: no `server-only` import — pulled in by the BullMQ workflow worker in
// the NestJS api process (@swc-node/register), outside the Next bundler
// context.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publishInTx } from "@/lib/events/outbox";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import type { Message } from "@ccp/shared/types";
import type { InteractiveOption } from "@ccp/shared/providers/types";
import { computeWindowStatus } from "@ccp/shared/utils/window";

import { SendTextValidationError } from "./send-text-internal";

/**
 * Sibling of `sendTextInternal` for outbound interactive messages (buttons /
 * list). Same 24h-window + provider-config + idempotent-create flow as the
 * text path; the only differences are the payload shape and the
 * `provider.sendInteractive?` optional-method check (providers that don't
 * support interactive return a typed error so the caller can fall back).
 *
 * Used by the `ask_question` workflow step. Direct callers — there's no
 * inbox-side composer for interactive messages today; agents send text only.
 */

export interface SendInteractiveInternalArgs {
  teamId: string;
  conversationId: string;
  bodyText: string;
  kind: "buttons" | "list";
  options: InteractiveOption[];
  listCtaLabel?: string;
  listSectionTitle?: string;
  /** Author of the message. Null = system (workflow auto-send); a uuid =
   *  agent-driven send via the inbox composer. Drives bubble attribution
   *  the same way it does for text replies. Defaults to null. */
  senderUserId?: string | null;
  /** Provenance label for raw_payload.sentVia. e.g. "workflow/<id>". */
  sentVia: string;
}

export interface SendInteractiveInternalResult {
  messageId: string;
  externalId: string;
}

export async function sendInteractiveInternal(
  args: SendInteractiveInternalArgs,
): Promise<SendInteractiveInternalResult> {
  const receivedAt = new Date();
  const bodyText = args.bodyText.trim();
  if (!bodyText) {
    throw new SendTextValidationError("empty_body", "body is required");
  }

  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, teamId: args.teamId },
    select: {
      id: true,
      contactId: true,
      // Channel is conversation-owned — bind + stamp from here, not the contact.
      channel: true,
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
    throw new SendTextValidationError("conversation_not_found", "conversation not found");
  }

  let channel;
  try {
    channel = resolveContactChannel(conversation.contact);
  } catch (err) {
    if (err instanceof NoChannelDestinationError) {
      throw new SendTextValidationError("contact_has_no_phone", "contact has no reachable address");
    }
    throw err;
  }
  // Channel is conversation-owned — bind + stamp from the conversation row;
  // resolveContactChannel only supplies the destination address.
  const provider = conversation.channel;
  const binding = getProviderBinding(provider);

  // Free-form send window — same gate as plain text. Driven by the provider's
  // declared window; `null` skips the check (channel has no window).
  const windowMs = binding.provider.capabilities.freeFormWindowMs;
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

  // Optional method — providers without interactive support (e.g. SMS) raise a
  // typed UnsupportedProviderOperationError the caller can fall back on.
  let sendInteractive;
  try {
    sendInteractive = requireProviderMethod(
      binding.provider,
      "sendInteractive",
      provider,
    );
  } catch {
    throw new SendTextValidationError(
      "provider_not_configured",
      "interactive_not_supported",
      "the active provider doesn't support interactive messages",
    );
  }

  const send = await sendInteractive(
    {
      to: channel.to,
      bodyText,
      kind: args.kind,
      options: args.options,
      ...(args.listCtaLabel ? { listCtaLabel: args.listCtaLabel } : {}),
      ...(args.listSectionTitle ? { listSectionTitle: args.listSectionTitle } : {}),
    },
    sendConfig,
  );

  // Strict timestamp ordering, same idiom as sendTextInternal.
  const lastTs = conversation.lastMessageAt ?? null;
  const messageTimestamp =
    lastTs && lastTs >= receivedAt
      ? new Date(lastTs.getTime() + 1)
      : receivedAt;

  // Persist as a regular outbound message — body is the question text the
  // contact saw; the structured options live in rawPayload so they survive
  // for debugging without bloating the searchable body column.
  const created = await createOutboundMessageIdempotent({
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: args.senderUserId ?? null,
    body: bodyText,
    direction: "out",
    channel: provider,
    status: "sent",
    rawPayload: {
      sentVia: args.sentVia,
      interactive: {
        kind: args.kind,
        options: args.options.map((o) => ({ id: o.id, title: o.title })),
      },
    } as Prisma.InputJsonValue,
    timestamp: messageTimestamp,
  });

  // Bump conversation.lastMessageAt + preview AND publish `message.sent`
  // ATOMICALLY via publishInTx — same crash-window-closing pattern as
  // sendTextInternal / sendTemplateInternal / MessagesService.commitOutbound
  // Event. A post-tx bare publish() would lose the realtime emit + audit
  // row + workflow-dispatch + outbound webhook on a crash between commit
  // and publish; on retry the externalId is already in DB so nothing
  // re-publishes. Backend audit 2026-05-29 flagged this and external-v1
  // as the two paths missed by the earlier text/template migration.
  const previewBody = bodyText.slice(0, 200);
  const senderUserId = args.senderUserId ?? null;
  const message: Message = {
    id: created.id,
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId,
    body: bodyText,
    direction: "out",
    channel: provider,
    status: "sent",
    rawPayload: {
      sentVia: args.sentVia,
      interactive: {
        kind: args.kind,
        options: args.options.map((o) => ({ id: o.id, title: o.title })),
      },
    },
    timestamp: messageTimestamp.toISOString(),
  };
  await db.$transaction(async (tx) => {
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
      current.lastMessageAt && current.lastMessageAt >= messageTimestamp
        ? new Date(current.lastMessageAt.getTime() + 1)
        : messageTimestamp;
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: { lastMessageAt: effectiveBump, lastMessagePreview: previewBody },
    });
    await publishInTx(tx, {
      type: "message.sent",
      teamId: args.teamId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      message,
      preview: previewBody,
      lastMessageAt: effectiveBump.toISOString(),
      unreadCount: current.unreadCount,
      senderUserId,
    });
  });

  return { messageId: created.id, externalId: send.externalId };
}
