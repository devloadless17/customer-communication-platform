import type { Channel } from "@ccp/shared/types";

/**
 * Resolve the channel-side destination ADDRESS to send to (and, for
 * conversation-creating sends, the channel to stamp on the new row).
 *
 * Channel OWNERSHIP lives on `Conversation.channel` — the conversation is the
 * source of truth for "which channel" (see schema.prisma + the read paths).
 * This helper's job is the destination address, which IS contact-owned. The
 * `channel` it returns equals the conversation's by construction: a contact's
 * channel is immutable (phone / identity never change) and contacts are siloed
 * one-per-channel, so the conversation was stamped from this same value at
 * creation. Existing-conversation sends use it for `to`; conversation-creating
 * sends also use its `channel` to stamp the new `Conversation.channel`.
 *
 * This is the single place the "phone number == identity" assumption is
 * allowed to live. WhatsApp contacts carry a `phoneNumber` and a null
 * `identityChannel` (the phone IS the identity). Future channels (Instagram
 * scoped-user-id, Telegram chat-id) carry `identityChannel` +
 * `externalContactId` and a null phone. Send paths call this instead of
 * reading `contact.phoneNumber` directly, so adding a channel doesn't mean
 * hunting down every `to: contact.phoneNumber`.
 */

/** Minimal contact shape needed to route a send. */
export interface ChannelResolvable {
  phoneNumber: string | null;
  identityChannel: Channel | null;
  externalContactId: string | null;
  /**
   * WhatsApp Business-Scoped User ID — forward-compat (Meta 2026). Optional so
   * existing callers that don't select it are unaffected; when a phone-keyed
   * contact has only a BSUID (Meta omitted the phone), it becomes the send
   * destination. Absent/null today.
   */
  bsuid?: string | null;
}

export interface ResolvedChannel {
  channel: Channel;
  /** Provider-side destination — WhatsApp phone number, IG/Telegram id, etc. */
  to: string;
}

/**
 * Thrown when a contact has no reachable address on any channel (no phone AND
 * no external id). Send sites map this to their own validation error so the
 * UI can show "this contact can't be messaged" rather than a 500.
 */
export class NoChannelDestinationError extends Error {
  constructor() {
    super("Contact has no reachable destination on any channel.");
    this.name = "NoChannelDestinationError";
  }
}

export function resolveContactChannel(contact: ChannelResolvable): ResolvedChannel {
  // Non-phone channel: identity is the channel's external id.
  if (contact.identityChannel && contact.externalContactId) {
    return { channel: contact.identityChannel, to: contact.externalContactId };
  }
  // WhatsApp (and any phone-keyed channel): the phone number is the identity.
  if (contact.phoneNumber) {
    return { channel: "whatsapp", to: contact.phoneNumber };
  }
  // BSUID forward-compat: a phone-keyed contact Meta identified only by its
  // business-scoped id (2026 rollout) still sends — the BSUID rides the same
  // `to` field. Null today, so this never fires yet.
  if (contact.bsuid) {
    return { channel: contact.identityChannel ?? "whatsapp", to: contact.bsuid };
  }
  throw new NoChannelDestinationError();
}
