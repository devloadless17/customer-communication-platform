/**
 * Single source of truth for per-channel capabilities + identity kind.
 *
 * Capabilities are STATIC per channel (not per team), so both the backend
 * providers and the frontend inbox import this same map — the provider's
 * `capabilities` field references `CHANNEL_CAPABILITIES[name]`, and the UI reads
 * it to drive the composer window, template button, call button, etc. This is
 * how capabilities reach the client with no new endpoint and no per-request
 * plumbing.
 *
 * Framework-agnostic (no Prisma / no DOM) so it's shared verbatim.
 */

import type { Channel } from "../types";
import type { ProviderCapabilities } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export const CHANNEL_CAPABILITIES: Record<Channel, ProviderCapabilities> = {
  // WhatsApp Cloud API: 24h customer-service window; outside it only approved
  // templates reopen the conversation (no human-agent extension). Full calling.
  whatsapp: {
    freeFormWindowMs: DAY_MS,
    humanAgentWindowMs: null,
    templates: true,
    readReceipts: true,
    typingIndicators: true,
    interactive: true,
    calling: true,
  },
  // Facebook Messenger: 24h free-form window + a 7-day Human Agent extension for
  // support replies. No approved-template catalog, no calling. Read receipts
  // (mark_seen) + typing (typing_on) are by-thread sender_actions on the PSID.
  messenger: {
    freeFormWindowMs: DAY_MS,
    humanAgentWindowMs: 7 * DAY_MS,
    templates: false,
    readReceipts: true,
    typingIndicators: true,
    interactive: true,
    calling: false,
  },
  // Instagram DM: same 24h + 7-day human-agent window as Messenger. No templates,
  // no calling; read receipts + typing via the same by-thread sender_actions.
  instagram: {
    freeFormWindowMs: DAY_MS,
    humanAgentWindowMs: 7 * DAY_MS,
    templates: false,
    readReceipts: true,
    typingIndicators: true,
    interactive: true,
    calling: false,
  },

  // ---- DESIGNED-FOR, NOT YET IMPLEMENTED (see LIVE_CHANNELS) ----------------
  // Sensible target capabilities so the architecture is complete; a focused
  // session ships the provider/webhook/onboarding and adds them to LIVE_CHANNELS.
  //
  // Telegram Bot API: no session window (a bot may message any user who started
  // the chat, anytime), no templates, typing via sendChatAction, no calling.
  telegram: {
    freeFormWindowMs: null,
    humanAgentWindowMs: null,
    templates: false,
    readReceipts: false,
    typingIndicators: true,
    interactive: false,
    calling: false,
  },
  // Email: no window, "templates" in the newsletter sense (modeled false until
  // built), no read receipts (open-tracking is separate), no typing/calling.
  email: {
    freeFormWindowMs: null,
    humanAgentWindowMs: null,
    templates: false,
    readReceipts: false,
    typingIndicators: false,
    interactive: false,
    calling: false,
  },
  // SMS: no window, no templates (plain text), no receipts/typing/calling.
  sms: {
    freeFormWindowMs: null,
    humanAgentWindowMs: null,
    templates: false,
    readReceipts: false,
    typingIndicators: false,
    interactive: false,
    calling: false,
  },
};

/**
 * Channels with a registered MessagingProvider + onboarding — i.e. actually
 * usable today. The others are enum values with capability maps in place
 * (architecture-ready) but no implementation. Keep this in sync with the
 * server-side provider REGISTRY: shipping a channel = add its provider/webhook/
 * onboarding AND add it here so the UI stops treating it as "coming soon".
 */
export const LIVE_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  "whatsapp",
  "messenger",
  "instagram",
]);

export function isChannelLive(channel: Channel): boolean {
  return LIVE_CHANNELS.has(channel);
}

/**
 * How a channel identifies a contact. `phone` channels resolve/create contacts
 * by `Contact.phoneNumber`; `external` channels use the opaque provider id
 * (`Contact.externalContactId`) via the `(teamId, identityChannel,
 * externalContactId)` compound unique. This is the discriminator the ingest
 * pipeline branches on (the documented multi-channel / F4 seam).
 */
export type ChannelIdentityKind = "phone" | "external";

export const CHANNEL_IDENTITY_KIND: Record<Channel, ChannelIdentityKind> = {
  whatsapp: "phone",
  messenger: "external",
  instagram: "external",
  // Designed-for: Telegram chat id + email address are opaque external ids; SMS
  // is phone-based like WhatsApp.
  telegram: "external",
  email: "external",
  sms: "phone",
};

/** True when the channel keys contacts by phone number (WhatsApp today). */
export function isPhoneChannel(channel: Channel): boolean {
  return CHANNEL_IDENTITY_KIND[channel] === "phone";
}
