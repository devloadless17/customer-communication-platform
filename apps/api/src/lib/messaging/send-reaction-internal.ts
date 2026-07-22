import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  computeWindowStatus,
  closedWindowMessage,
  effectiveSendWindowMs,
  outsideFreeFormWindow,
} from "@ccp/shared/utils/window";

import { SendTextValidationError } from "./send-text-internal";

/**
 * Send an OUTBOUND emoji reaction to a customer's message — the agent-authored
 * twin of an inbound customer reaction. Writes the DEDICATED `agentReaction`
 * column (NOT the customer's `reaction`) so a customer reaction and our reaction
 * on the same message coexist instead of clobbering. Fans out the SAME
 * `message.reaction_changed` event (with `actor:"agent"`) the inbound path uses,
 * so it renders live through the already-wired `applyMessageReaction` reducer
 * (all 3 consumers). An empty emoji REMOVES our reaction (Meta's convention).
 * No new Message row — a reaction mutates its target.
 */
export interface SendReactionInternalArgs {
  workspaceId: string;
  conversationId: string;
  /** Our Message.id of the message being reacted to. */
  messageId: string;
  /** Emoji glyph; "" removes the reaction. */
  emoji: string;
  senderUserId?: string | null;
}

export async function sendReactionInternal(args: SendReactionInternalArgs): Promise<void> {
  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, workspaceId: args.workspaceId },
    select: {
      id: true,
      // The account this thread belongs to — sends must go out from it.
      channelConnectionId: true,
      channel: true,
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

  const target = await db.message.findFirst({
    where: { id: args.messageId, workspaceId: args.workspaceId, conversationId: args.conversationId },
    select: { id: true, externalId: true, agentReaction: true },
  });
  if (!target || !target.externalId) {
    throw new SendTextValidationError(
      "message_not_found",
      "message_not_found",
      "This message can't be reacted to yet.",
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

  // Reactions ride the same free-form window as any send.
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
  const useHumanAgentTag = outsideFreeFormWindow(
    binding.provider.capabilities.freeFormWindowMs,
    lastInboundIso,
  );

  let sendConfig;
  try {
    sendConfig = await binding.getSendConfig(args.workspaceId, conversation.channelConnectionId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      throw new SendTextValidationError("provider_not_configured", "channel_not_connected", err.message);
    }
    throw err;
  }

  let sendReaction;
  try {
    sendReaction = requireProviderMethod(binding.provider, "sendReaction", provider);
  } catch {
    throw new SendTextValidationError(
      "provider_not_configured",
      "reaction_not_supported",
      `${provider} can't send reactions.`,
    );
  }

  // No-op BEFORE hitting Meta: re-reacting with the same emoji (or removing a
  // reaction that was never set) shouldn't fire a redundant/erroring Meta send.
  // Empty emoji ⇒ removed.
  const emoji = args.emoji.trim() === "" ? null : args.emoji;
  if (target.agentReaction === emoji) return;

  await sendReaction(
    {
      to: dest.to,
      messageExternalId: target.externalId,
      emoji: args.emoji,
      useHumanAgentTag,
    },
    sendConfig,
  );

  // Persist to OUR side + fan out through the SAME path the inbound reaction
  // uses (actor:"agent" so the reducer patches agentReaction, not reaction).
  await db.message.update({ where: { id: target.id }, data: { agentReaction: emoji } });
  await publish({
    type: "message.reaction_changed",
    workspaceId: args.workspaceId,
    conversationId: conversation.id,
    messageId: target.id,
    actor: "agent",
    emoji,
  });
}
