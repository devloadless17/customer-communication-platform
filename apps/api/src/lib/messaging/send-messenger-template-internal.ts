import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  personasEnabled,
  resolvePersonaId,
} from "@/lib/providers/messenger-persona-registry";
import { MessengerTemplateError } from "@/lib/providers/messenger-templates";
import type { Message } from "@ccp/shared/types";
import type {
  MessengerStructuredTemplate,
  SendUtilityTemplateArgs,
} from "@ccp/shared/providers/types";
import {
  computeWindowStatus,
  closedWindowMessage,
  effectiveSendWindowMs,
  outsideFreeFormWindow,
} from "@ccp/shared/utils/window";

import { SendTextValidationError } from "./send-text-internal";

/**
 * Send a Messenger TEMPLATE to a conversation.
 *
 * Covers both things Meta calls a template, because they are two genuinely
 * different sends and the difference is the whole point:
 *
 *   structured — button / generic / media / image_grid / receipt / coupon.
 *                Authored inline, no review, and gated on the messaging window
 *                exactly like a text reply.
 *   utility    — an APPROVED template sent with `messaging_type: "UTILITY"`.
 *                Deliberately NOT window-gated: bypassing the 24-hour window is
 *                the entire reason this message type exists, and it is the only
 *                way left to reach a customer proactively since Meta retired the
 *                three update tags on 2026-04-27.
 *
 * Getting that backwards in either direction is a real failure: gating the
 * utility send makes the one outside-window path unusable, and NOT gating the
 * structured send lets an agent fire a carousel into a closed window that Meta
 * then rejects with an error the agent can't act on.
 */
export type SendMessengerTemplateArgs = {
  workspaceId: string;
  conversationId: string;
  senderUserId?: string | null;
  senderApiKeyId?: string | null;
  sentVia: string;
} & (
  | { mode: "structured"; template: MessengerStructuredTemplate }
  | {
      mode: "utility";
      template: Omit<SendUtilityTemplateArgs, "to" | "personaId">;
    }
);

export interface SendMessengerTemplateResult {
  messageId: string;
  externalId: string;
}

/**
 * The text a template is REPRESENTED by in the inbox list, in search, and in the
 * bubble when a client can't render the card.
 *
 * Every branch produces something a human wrote or named — never "[template]".
 * This string is what a colleague sees months later when they search the thread,
 * so an opaque label would erase what was actually sent.
 */
function previewFor(args: SendMessengerTemplateArgs): string {
  if (args.mode === "utility") return `📄 ${args.template.templateName}`;
  const t = args.template;
  switch (t.kind) {
    case "button":
      return t.text;
    case "generic":
      return t.elements[0]?.title ?? "💬 Message";
    case "media":
      return t.mediaType === "video" ? "🎬 Video" : "🖼 Image";
    case "image_grid":
      return t.title ?? `🖼 ${t.images.length} images`;
    case "receipt":
      return `🧾 Receipt · ${t.orderNumber}`;
    case "coupon":
      return t.title;
  }
}

export async function sendMessengerTemplateInternal(
  args: SendMessengerTemplateArgs,
): Promise<SendMessengerTemplateResult> {
  const receivedAt = new Date();

  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, workspaceId: args.workspaceId },
    select: {
      id: true,
      contactId: true,
      channelConnectionId: true,
      channel: true,
      lastMessageAt: true,
      channelConnection: { select: { config: true } },
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

  let dest;
  try {
    dest = resolveContactChannel(conversation.contact);
  } catch (err) {
    if (err instanceof NoChannelDestinationError) {
      throw new SendTextValidationError("contact_has_no_phone", "contact has no reachable address");
    }
    throw err;
  }
  const provider = conversation.channel;
  const binding = getProviderBinding(provider);

  const method = args.mode === "structured" ? "sendStructuredTemplate" : "sendUtilityTemplate";
  let send;
  try {
    send = requireProviderMethod(binding.provider, method, provider);
  } catch {
    throw new SendTextValidationError(
      "provider_not_configured",
      "template_not_supported",
      `${provider} can't send this kind of template.`,
    );
  }

  const lastInboundIso = conversation.contact.lastInboundAt?.toISOString() ?? null;

  // THE window rule, and the reason this function handles both modes. See the
  // docblock: only the structured send is gated.
  let useHumanAgentTag = false;
  if (args.mode === "structured") {
    const windowMs = effectiveSendWindowMs(binding.provider.capabilities);
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
    useHumanAgentTag = outsideFreeFormWindow(
      binding.provider.capabilities.freeFormWindowMs,
      lastInboundIso,
    );
  }

  let sendConfig;
  try {
    sendConfig = await binding.getSendConfig(args.workspaceId, conversation.channelConnectionId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      throw new SendTextValidationError("provider_not_configured", "channel_not_connected", err.message);
    }
    throw err;
  }

  // Same agent voice as their text replies — a thread where the words say "Ada"
  // and the receipt says the Page reads as two different people answering.
  const cfg = sendConfig as {
    pageId?: string;
    pageAccessToken?: string;
    graphVersion?: string;
    appSecret?: string;
  };
  const personaId =
    provider === "messenger" && personasEnabled(conversation.channelConnection?.config)
      ? await resolvePersonaId({
          workspaceId: args.workspaceId,
          channelConnectionId: conversation.channelConnectionId,
          userId: args.senderUserId ?? null,
          target: {
            accountId: cfg.pageId ?? "",
            accessToken: cfg.pageAccessToken ?? "",
            graphVersion: cfg.graphVersion ?? "v26.0",
            label: "messenger",
            ...(cfg.appSecret ? { appSecret: cfg.appSecret } : {}),
          },
        })
      : null;

  let result;
  try {
    result =
      args.mode === "structured"
        ? await (send as NonNullable<typeof binding.provider.sendStructuredTemplate>)(
            {
              to: dest.to,
              template: args.template,
              useHumanAgentTag,
              ...(personaId ? { personaId } : {}),
            },
            sendConfig,
          )
        : await (send as NonNullable<typeof binding.provider.sendUtilityTemplate>)(
            { ...args.template, to: dest.to, ...(personaId ? { personaId } : {}) },
            sendConfig,
          );
  } catch (err) {
    // A template Meta would reject is a 400 the agent can fix (too many buttons,
    // a call button that isn't E.164, an external media URL) — surfaced as a
    // validation error rather than a provider failure so the composer can point
    // at the offending field instead of showing "rejected by Meta".
    if (err instanceof MessengerTemplateError) {
      throw new SendTextValidationError("invalid_template", "invalid_template", err.message);
    }
    throw err;
  }

  const lastTs = conversation.lastMessageAt ?? null;
  const messageTimestamp =
    lastTs && lastTs >= receivedAt ? new Date(lastTs.getTime() + 1) : receivedAt;

  const body = previewFor(args);
  const rawPayload = {
    sentVia: args.sentVia,
    templateMode: args.mode,
    ...(args.mode === "structured"
      ? { templateKind: args.template.kind }
      : { templateName: args.template.templateName }),
  };

  const created = await createOutboundMessageIdempotent({
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    externalId: result.externalId,
    senderUserId: args.senderUserId ?? null,
    body,
    direction: "out",
    channel: provider,
    status: "sent",
    rawPayload: rawPayload as Prisma.InputJsonValue,
    timestamp: messageTimestamp,
  });

  const senderUserId = args.senderUserId ?? null;
  const message: Message = {
    id: created.id,
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    externalId: result.externalId,
    senderUserId,
    body,
    direction: "out",
    channel: provider,
    status: "sent",
    timestamp: messageTimestamp.toISOString(),
  };

  await commitOutboundSend({
    conversationId: args.conversationId,
    bumpTimestamp: messageTimestamp,
    preview: body,
    event: {
      type: "message.sent",
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      message,
      preview: body,
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

  return { messageId: created.id, externalId: result.externalId };
}
