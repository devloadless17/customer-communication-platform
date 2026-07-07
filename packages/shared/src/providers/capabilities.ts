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
    calling: true,
  },
  // Facebook Messenger: 24h free-form window + a 7-day Human Agent extension for
  // support replies. No approved-template catalog, no calling. read-receipt /
  // typing marks use a by-thread (PSID) API that doesn't fit the by-message
  // provider signature yet, so they're off until implemented (a later increment).
  messenger: {
    freeFormWindowMs: DAY_MS,
    humanAgentWindowMs: 7 * DAY_MS,
    templates: false,
    readReceipts: false,
    typingIndicators: false,
    calling: false,
  },
  // Instagram DM: same 24h + 7-day human-agent window as Messenger. No templates,
  // no calling, and (like Messenger this increment) no read/typing marks yet.
  instagram: {
    freeFormWindowMs: DAY_MS,
    humanAgentWindowMs: 7 * DAY_MS,
    templates: false,
    readReceipts: false,
    typingIndicators: false,
    calling: false,
  },
};

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
};

/** True when the channel keys contacts by phone number (WhatsApp today). */
export function isPhoneChannel(channel: Channel): boolean {
  return CHANNEL_IDENTITY_KIND[channel] === "phone";
}
