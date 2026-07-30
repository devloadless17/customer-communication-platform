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
import {
  getBusinessNumberCountry,
  ProviderNotConfiguredError,
} from "@/lib/providers/config";
import { isBicAllowedForBusinessNumber } from "@ccp/shared/providers/calling-regions";
import type { Message } from "@ccp/shared/types";
import type {
  ContactShareField,
  GenericTemplateCard,
  InteractiveOption,
} from "@ccp/shared/providers/types";
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
  kind:
    | "buttons"
    | "list"
    | "voice_call"
    | "location_request"
    | "cta_url"
    | "carousel"
    | "generic"
    | "product";
  /** Empty for `voice_call` / `location_request` / `cta_url` — those render a
   *  single vendor-drawn CTA instead of authored options. */
  options: InteractiveOption[];
  /** `cta_url` only — button label + URL (+ optional text header/footer).
   *  Shape documented on SendInteractiveArgs. */
  ctaUrl?: { displayText: string; url: string; headerText?: string; footerText?: string };
  /** `carousel` only — 2-10 media cards. Shape + rules on SendInteractiveArgs;
   *  uniformity/caps enforced by the request schemas. */
  carouselCards?: Array<{
    headerMedia: { kind: "image" | "video"; link: string };
    body?: string;
    ctaUrl?: { displayText: string; url: string };
    quickReplies?: Array<{ id: string; title: string }>;
  }>;
  /** `generic` only — 1-10 cards. Shape + caps on SendInteractiveArgs. */
  genericCards?: GenericTemplateCard[];
  /** `product` only — 1-10 catalog product ids. */
  productIds?: string[];
  listCtaLabel?: string;
  listSectionTitle?: string;
  /** Buttons + list — optional text header / footer (≤60 each). */
  headerText?: string;
  footerText?: string;
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
          blockedAt: true,
        },
      },
    },
  });
  if (!conversation) {
    throw new SendTextValidationError("conversation_not_found", "conversation not found");
  }
  if (conversation.contact.blockedAt) {
    throw new SendTextValidationError(
      "contact_blocked",
      "contact_blocked",
      "This contact is blocked. Unblock them to send messages.",
    );
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

  // Location requests are WhatsApp's interactive type
  // ("location_request_message"); the social channels have no equivalent and
  // their providers would reject the kind. Same capability-not-channel-name
  // rule as the chips gate above.
  if (
    args.kind === "location_request" &&
    !binding.provider.capabilities.locationRequest
  ) {
    throw new SendTextValidationError(
      "provider_not_configured",
      "location_request_not_supported",
      `${channel.channel} cannot request a contact's location`,
    );
  }

  // Same rule for the URL button ("cta_url") — capability, never a channel name:
  // WhatsApp sends `interactive.type:"cta_url"`, Instagram sends the equivalent
  // BUTTON TEMPLATE, and a channel with neither is refused here.
  if (args.kind === "cta_url" && !binding.provider.capabilities.ctaUrlButton) {
    throw new SendTextValidationError(
      "provider_not_configured",
      "cta_url_not_supported",
      `${channel.channel} cannot send a URL button message`,
    );
  }

  // A structured template can carry LESS text than a plain message on the same
  // channel — Instagram allows 1,000 bytes of plain text but only 640 characters
  // of button-template `text`, and the header/footer lines are folded into that
  // same field because the template has nowhere else to put them. Check the
  // COMBINED length here, where the caller still gets a 4xx naming the limit,
  // rather than letting Meta reject it inside the send worker.
  const templateMax = binding.provider.capabilities.templateTextMaxChars;
  if (args.kind === "cta_url" && templateMax !== undefined) {
    const combined = [args.ctaUrl?.headerText, bodyText, args.ctaUrl?.footerText]
      .filter((part): part is string => !!part && part.length > 0)
      .join("\n\n");
    if (combined.length > templateMax) {
      throw new SendTextValidationError(
        "message_too_long",
        `Link-button message is ${combined.length} characters (header + body + footer) — ${provider} allows at most ${templateMax}.`,
      );
    }
  }

  // Meta's structured templates. Same capability-not-channel-name rule.
  if (args.kind === "generic" && !binding.provider.capabilities.genericTemplate) {
    throw new SendTextValidationError(
      "provider_not_configured",
      "generic_template_not_supported",
      `${channel.channel} cannot send a card template`,
    );
  }
  if (args.kind === "product" && !binding.provider.capabilities.productTemplate) {
    throw new SendTextValidationError(
      "provider_not_configured",
      "product_template_not_supported",
      `${channel.channel} cannot send a product template`,
    );
  }

  // Same rule for interactive carousels — WhatsApp only today.
  if (args.kind === "carousel" && !binding.provider.capabilities.interactiveCarousel) {
    throw new SendTextValidationError(
      "provider_not_configured",
      "carousel_not_supported",
      `${channel.channel} cannot send a media carousel message`,
    );
  }

  // A call button obeys the business-initiated-calling region rule — Meta
  // rejects the SEND itself with a cryptic 131009 ("voice_call not
  // supported") when the business number's country is calling-blocked
  // (troubleshooting doc). Pre-flight with the same authority the place-call
  // gauntlet uses, on the thread's own number, so the agent gets a sentence
  // instead of a mystery. Conservative on null (unknown country ⇒ let the
  // provider decide), same as the gauntlet.
  if (args.kind === "voice_call" && channel.channel === "whatsapp") {
    const businessCountry = await getBusinessNumberCountry(
      args.workspaceId,
      conversation.channelConnectionId,
    );
    if (!isBicAllowedForBusinessNumber(businessCountry)) {
      throw new SendTextValidationError(
        "provider_not_configured",
        "call_button_region_blocked",
        `WhatsApp doesn't offer business calling for ${businessCountry ?? "this"} numbers, so a call button can't be sent from this number.`,
      );
    }
  }

  const send = await sendInteractive(
    {
      to: channel.to,
      bodyText,
      kind: args.kind,
      options: args.options,
      useHumanAgentTag,
      ...(args.voiceCall ? { voiceCall: args.voiceCall } : {}),
      ...(args.ctaUrl ? { ctaUrl: args.ctaUrl } : {}),
      ...(args.carouselCards ? { carouselCards: args.carouselCards } : {}),
      ...(args.genericCards ? { genericCards: args.genericCards } : {}),
      ...(args.productIds ? { productIds: args.productIds } : {}),
      ...(contactShare.length > 0 ? { contactShare } : {}),
      ...(args.listCtaLabel ? { listCtaLabel: args.listCtaLabel } : {}),
      ...(args.listSectionTitle ? { listSectionTitle: args.listSectionTitle } : {}),
      ...(args.headerText ? { headerText: args.headerText } : {}),
      ...(args.footerText ? { footerText: args.footerText } : {}),
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
  // Typed as a plain JSON object, not inferred. `genericCards[].buttons` is a
  // DISCRIMINATED UNION, and a union of object literals is not structurally
  // assignable to Prisma's `InputJsonValue` (it has no index signature) — so
  // inference here would force a second assertion at the write below. Naming the
  // shape once keeps that a single, honest cast.
  const rawPayload: Record<string, unknown> = {
    sentVia: args.sentVia,
    interactive: {
      kind: args.kind,
      options: args.options.map((o) => ({ id: o.id, title: o.title })),
      ...(args.voiceCall ? { voiceCall: args.voiceCall } : {}),
      ...(args.ctaUrl ? { ctaUrl: args.ctaUrl } : {}),
      ...(args.carouselCards ? { carouselCards: args.carouselCards } : {}),
      ...(args.genericCards ? { genericCards: args.genericCards } : {}),
      ...(args.productIds ? { productIds: args.productIds } : {}),
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
