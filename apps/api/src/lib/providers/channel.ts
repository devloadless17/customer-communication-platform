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
 * allowed to live. Phone-keyed channels (WhatsApp today; SMS later) carry a
 * `phoneNumber` — the phone IS the destination — and `identityChannel` names
 * WHICH phone channel it is (non-null: every contact-create path stamps it).
 * Non-phone channels (Instagram scoped-user-id, Telegram chat-id) carry
 * `identityChannel` + `externalContactId` and a null phone. Send paths call
 * this instead of reading `contact.phoneNumber` directly, so adding a channel
 * doesn't mean hunting down every `to: contact.phoneNumber`.
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
  /**
   * True when `to` is a WhatsApp BSUID rather than a phone number.
   *
   * The BSUID belongs in `to` — verified 2026-07-30: for
   * `POST /{PHONE_NUMBER_ID}/messages` the doc states "to — Supports both
   * WhatsApp user phone numbers and user BSUIDs". (The separate `recipient`
   * body param belongs to `/marketing_messages`, the Marketing Messages Lite
   * API, which this platform does not use — do not "fix" the send path toward
   * it.) So this flag changes no wire bytes.
   *
   * It exists because a BSUID address is not universally sendable: "BSUIDs can
   * be used to send any type of message except for one-tap, zero-tap, and copy
   * code authentication templates, which require user phone numbers." Attempting
   * one returns error 131062 AFTER the request is made, so send paths check this
   * to refuse locally instead of burning a billed call on a guaranteed failure.
   */
  viaBsuid?: boolean;
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
  // Phone-keyed channel: the phone number is the destination, and
  // `identityChannel` says WHICH phone channel (WhatsApp today, SMS later). It's
  // non-null in practice; the `?? "whatsapp"` is a defensive default. This keeps
  // all three live channels byte-identical while letting SMS route with zero
  // further core edits.
  if (contact.phoneNumber) {
    return { channel: contact.identityChannel ?? "whatsapp", to: contact.phoneNumber };
  }
  // A phone-keyed contact Meta identified only by its business-scoped id. The
  // BSUID rides the same `to` field — confirmed for
  // `POST /{PHONE_NUMBER_ID}/messages`, whose `to` "Supports both WhatsApp user
  // phone numbers and user BSUIDs". This DOES fire now: username adoption went
  // live 2026-06-29 and Meta empties `wa_id` for an adopter we have not messaged
  // by phone in 30 days.
  //
  // `viaBsuid` is flagged so send paths can refuse the message types a BSUID
  // address cannot receive (see ResolvedChannel).
  if (contact.bsuid) {
    return {
      channel: contact.identityChannel ?? "whatsapp",
      to: contact.bsuid,
      viaBsuid: true,
    };
  }
  throw new NoChannelDestinationError();
}
