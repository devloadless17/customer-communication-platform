// Note: no `server-only` import — pulled in by the BullMQ workflow worker in
// the NestJS api process (@swc-node/register), outside the Next bundler
// context.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
import { checkTextCap } from "@/lib/messaging/text-cap";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import type { Message } from "@ccp/shared/types";
import type { ContactShareField, InteractiveOption } from "@ccp/shared/providers/types";
import {
  computeWindowStatus,
  closedWindowMessage,
  effectiveSendWindowMs,
  outsideFreeFormWindow,
} from "@ccp/shared/utils/window";

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
  workspaceId: string;
  conversationId: string;
  bodyText: string;
  kind: "buttons" | "list" | "voice_call";
  options: InteractiveOption[];
  listCtaLabel?: string;
  listSectionTitle?: string;
  /** WhatsApp call-button CTA. Only meaningful with `kind: "voice_call"`,
   *  which carries no `options`. */
  voiceCall?: { displayText?: string; ttlMinutes?: number; payload?: string };
  /** Author of the message. Null = system (workflow auto-send); a uuid =
   *  agent-driven send via the inbox composer. Drives bubble attribution
   *  the same way it does for text replies. Defaults to null. */
  senderUserId?: string | null;
  /**
   * Set on `/v1` external-API interactive sends so the `message.sent` event +
   * audit timeline attribute the send to the API key instead of a real user.
   * Mutually exclusive with `senderUserId` in practice. Mirrors
   * `SendTemplateInternalArgs`.
   */
  senderApiKeyId?: string | null;
  /** Provenance label for raw_payload.sentVia. e.g. "workflow/<id>". */
  sentVia: string;
  /** One-tap "share your phone / email" consent chips. Social channels only —
   *  rejected with `contact_share_not_supported` elsewhere. */
  contactShare?: ContactShareField[];
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
    where: { id: args.conversationId, workspaceId: args.workspaceId },
    select: {
      id: true,
      contactId: true,
      // The account this thread belongs to — sends must go out from it.
      channelConnectionId: true,
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

  // Channel text-length cap — same gate as plain text, so an over-cap
  // `ask_question` body fails with an actionable error instead of Meta's opaque
  // one deep in the worker.
  const tooLong = checkTextCap(bodyText, binding.provider.capabilities, provider);
  if (tooLong) {
    throw new SendTextValidationError("message_too_long", tooLong.detail);
  }

  // Free-form send window — same gate as plain text. Driven by the provider's
  // declared window; `null` skips the check (channel has no window).
  const windowMs = effectiveSendWindowMs(binding.provider.capabilities);
  const lastInboundIso = conversation.contact.lastInboundAt?.toISOString() ?? null;
  if (windowMs !== null) {
    const win = computeWindowStatus(lastInboundIso, Date.now(), windowMs);
    if (win.state === "closed" || win.state === "never") {
      throw new SendTextValidationError(
        "outside_24h_window",
        "outside_24h_window",
        closedWindowMessage(binding.provider.capabilities),
      );
    }
  }
  // Meta social: inside the effective window but past the 24h free-form band we
  // must attach the HUMAN_AGENT tag (RESPONSE otherwise). Shared rule.
  const useHumanAgentTag = outsideFreeFormWindow(
    binding.provider.capabilities.freeFormWindowMs,
    lastInboundIso,
  );

  let sendConfig;
  try {
    sendConfig = await binding.getSendConfig(args.workspaceId, conversation.channelConnectionId);
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

  // Consent chips are a Meta-social interactive type; WhatsApp has no equivalent
  // and would reject the message. Gate on the capability, never on the channel
  // name, so a future channel that gains them just flips the flag.
  const contactShare = args.contactShare ?? [];
  if (contactShare.length > 0 && !binding.provider.capabilities.contactShareChips) {
    throw new SendTextValidationError(
      "contact_share_not_supported",
      `${channel.channel} cannot ask a contact to share their phone or email`,
    );
  }

  const send = await sendInteractive(
    {
      to: channel.to,
      bodyText,
      kind: args.kind,
      options: args.options,
      useHumanAgentTag,
      ...(args.voiceCall ? { voiceCall: args.voiceCall } : {}),
      ...(contactShare.length > 0 ? { contactShare } : {}),
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
  // `interactive.contactShare` is the CORRELATION ANCHOR the ingest path reads:
  // Meta's inbound frame for a tapped consent chip is indistinguishable from a
  // normal text quick-reply, so the only trustworthy signal that a value is a
  // shared phone/email is that THIS message offered that chip. Keep it in sync
  // with `resolveContactShare` (@ccp/shared/utils/contact-share).
  const rawPayload = {
    sentVia: args.sentVia,
    interactive: {
      kind: args.kind,
      options: args.options.map((o) => ({ id: o.id, title: o.title })),
      ...(args.voiceCall ? { voiceCall: args.voiceCall } : {}),
      ...(contactShare.length > 0 ? { contactShare } : {}),
    },
  };

  const created = await createOutboundMessageIdempotent({
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: args.senderUserId ?? null,
    body: bodyText,
    direction: "out",
    channel: provider,
    status: "sent",
    rawPayload: rawPayload as Prisma.InputJsonValue,
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
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId,
    body: bodyText,
    direction: "out",
    channel: provider,
    status: "sent",
    rawPayload,
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
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      message,
      preview: previewBody,
      senderUserId,
      ...(args.senderApiKeyId ? { senderApiKeyId: args.senderApiKeyId } : {}),
    },
    onMissing: () => {
      throw new SendTextValidationError(
        "conversation_not_found",
        "conversation_disappeared_mid_send",
      );
    },
  });

  return { messageId: created.id, externalId: send.externalId };
}
