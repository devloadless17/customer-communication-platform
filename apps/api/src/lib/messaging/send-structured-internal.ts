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
import type { Message, MessageStructured } from "@ccp/shared/types";
import type { SharedContactInput } from "@ccp/shared/providers/types";
import {
  computeWindowStatus,
  effectiveSendWindowMs,
  outsideFreeFormWindow,
} from "@ccp/shared/utils/window";

import { SendTextValidationError } from "./send-text-internal";

/**
 * Sibling of `sendInteractiveInternal` for outbound STRUCTURED messages — a
 * shared location (map pin) or a shared contact (vCard). Same 24h-window +
 * provider-config + idempotent-create + atomic `message.sent` flow as the text
 * / interactive paths; the only differences are the provider method
 * (`sendLocation` / `sendContacts`, optional → typed error if unsupported) and
 * that the message persists a `structured` payload so it renders as the same
 * rich card an INBOUND location/contact does — identical live and on refetch.
 */

export type SendStructuredInternalArgs = {
  teamId: string;
  conversationId: string;
  senderUserId?: string | null;
  senderApiKeyId?: string | null;
  sentVia: string;
} & (
  | {
      kind: "location";
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
    }
  | { kind: "contacts"; contacts: SharedContactInput[] }
);

export interface SendStructuredInternalResult {
  messageId: string;
  externalId: string;
}

export async function sendStructuredInternal(
  args: SendStructuredInternalArgs,
): Promise<SendStructuredInternalResult> {
  const receivedAt = new Date();

  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, teamId: args.teamId },
    select: {
      id: true,
      contactId: true,
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

  // Free-form send window — same gate as text/interactive.
  const windowMs = effectiveSendWindowMs(binding.provider.capabilities);
  const lastInboundIso = conversation.contact.lastInboundAt?.toISOString() ?? null;
  if (windowMs !== null) {
    const win = computeWindowStatus(lastInboundIso, Date.now(), windowMs);
    if (win.state === "closed" || win.state === "never") {
      throw new SendTextValidationError(
        "outside_24h_window",
        "outside_24h_window",
        "24h customer-service window closed — use a template step instead.",
      );
    }
  }
  const useHumanAgentTag = outsideFreeFormWindow(
    binding.provider.capabilities.freeFormWindowMs,
    lastInboundIso,
  );

  let sendConfig;
  try {
    sendConfig = await binding.getSendConfig(args.teamId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      throw new SendTextValidationError("provider_not_configured", "channel_not_connected", err.message);
    }
    throw err;
  }

  // Build the structured payload (renders the card) + a text placeholder body
  // (list preview + search), and call the kind-specific provider method. The
  // requireProviderMethod call lives INSIDE each branch so its literal name
  // narrows the returned method's arg type (a union var wouldn't type-check).
  let structured: MessageStructured;
  let body: string;
  let send;
  if (args.kind === "location") {
    let sendLocation;
    try {
      sendLocation = requireProviderMethod(binding.provider, "sendLocation", provider);
    } catch {
      throw new SendTextValidationError(
        "provider_not_configured",
        "location_not_supported",
        `${provider} can't send a location.`,
      );
    }
    structured = {
      kind: "location",
      latitude: args.latitude,
      longitude: args.longitude,
      ...(args.name ? { name: args.name } : {}),
      ...(args.address ? { address: args.address } : {}),
    };
    body = args.name ? `📍 ${args.name}` : "📍 Location";
    send = await sendLocation(
      {
        to: dest.to,
        latitude: args.latitude,
        longitude: args.longitude,
        ...(args.name ? { name: args.name } : {}),
        ...(args.address ? { address: args.address } : {}),
        useHumanAgentTag,
      },
      sendConfig,
    );
  } else {
    let sendContacts;
    try {
      sendContacts = requireProviderMethod(binding.provider, "sendContacts", provider);
    } catch {
      throw new SendTextValidationError(
        "provider_not_configured",
        "contact_not_supported",
        `${provider} can't send a contact.`,
      );
    }
    structured = { kind: "contacts", contacts: args.contacts };
    const first = args.contacts[0]?.name?.trim() || "Contact";
    body =
      args.contacts.length > 1 ? `👤 ${first} +${args.contacts.length - 1}` : `👤 ${first}`;
    send = await sendContacts({ to: dest.to, contacts: args.contacts, useHumanAgentTag }, sendConfig);
  }

  const lastTs = conversation.lastMessageAt ?? null;
  const messageTimestamp =
    lastTs && lastTs >= receivedAt ? new Date(lastTs.getTime() + 1) : receivedAt;

  const rawPayload = { sentVia: args.sentVia };
  const created = await createOutboundMessageIdempotent({
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: args.senderUserId ?? null,
    body,
    direction: "out",
    channel: provider,
    status: "sent",
    structured: structured as unknown as Prisma.InputJsonValue,
    rawPayload: rawPayload as Prisma.InputJsonValue,
    timestamp: messageTimestamp,
  });

  const senderUserId = args.senderUserId ?? null;
  const message: Message = {
    id: created.id,
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId,
    body,
    direction: "out",
    channel: provider,
    status: "sent",
    structured,
    rawPayload,
    timestamp: messageTimestamp.toISOString(),
  };
  await commitOutboundSend({
    conversationId: args.conversationId,
    bumpTimestamp: messageTimestamp,
    preview: body,
    event: {
      type: "message.sent",
      teamId: args.teamId,
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

  return { messageId: created.id, externalId: send.externalId };
}
