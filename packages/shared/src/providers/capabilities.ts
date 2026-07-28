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

import type { Channel, MediaKind } from "../types";
import type { ProviderCapabilities } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export const CHANNEL_CAPABILITIES: Record<Channel, ProviderCapabilities> = {
  // WhatsApp Cloud API: 24h customer-service window; outside it only approved
  // templates reopen the conversation (no human-agent extension). Full calling.
  whatsapp: {
    freeFormWindowMs: DAY_MS,
    humanAgentWindowMs: null,
    messageTextMaxChars: 4096,
    // Per-kind outbound media size caps live in `media-caps.ts`
    // (MEDIA_SIZE_CAPS_BY_CHANNEL) — the single table shared by the server
    // gate (mediaPolicyForChannel) and the composer's client guard. Audio
    // 16 MB re-verified against Meta's audio-messages doc 2026-07-27.
    templates: true,
    readReceipts: true,
    typingIndicators: true,
    interactive: true,
    // WhatsApp supports outbound location + contact (vCard) + emoji reactions.
    sendLocation: true,
    sendContacts: true,
    sendReaction: true,
    // …and asking FOR a location (interactive "location_request_message"),
    // and the single URL-opening button (interactive "cta_url").
    locationRequest: true,
    ctaUrlButton: true,
    interactiveCarousel: true,
    // Provider-level user blocking (Block Users API on the business number).
    // WhatsApp-only: Messenger/Instagram expose no equivalent messaging API.
    blockUsers: true,
    calling: true,
  },
  // Facebook Messenger: 24h free-form window + a 7-day Human Agent extension for
  // support replies. No approved-template catalog. Read receipts (mark_seen) +
  // typing (typing_on) are by-thread sender_actions on the PSID.
  //
  // Calling: the Messenger Calling API is GA (WebRTC) and the provider methods
  // exist, but the feature is DISABLED for now — kept off (like Instagram) so the
  // product only offers WhatsApp calling. Flip `calling: true` + restore the
  // onboarding `enableSocialCalling` step to bring it back.
  messenger: {
    freeFormWindowMs: DAY_MS,
    humanAgentWindowMs: 7 * DAY_MS,
    messageTextMaxChars: 2000,
    templates: false,
    readReceipts: true,
    typingIndicators: true,
    interactive: true,
    // Business reactions via the unified social messaging endpoint (sender_action
    // react/unreact). Location/contact vCard message types are WhatsApp-only.
    sendReaction: true,
    calling: false,
    profileSync: true,
    contactShareChips: true,
  },
  // Instagram DM: same 24h + 7-day human-agent window as Messenger. No templates.
  // Calling stays FALSE: Meta ships NO Instagram calling API (only Messenger
  // Calling is GA as of 2026), so the button is hidden on IG threads. Read
  // receipts + typing via the same by-thread sender_actions.
  instagram: {
    freeFormWindowMs: DAY_MS,
    humanAgentWindowMs: 7 * DAY_MS,
    messageTextMaxChars: 1000,
    // Instagram's 1000 limit is UTF-8 BYTES — Arabic/emoji bodies that fit by
    // char count still exceed it, so the length gate measures bytes for IG.
    textLimitIsBytes: true,
    templates: false,
    readReceipts: true,
    // Instagram has NO delivery receipt — Meta's `message_deliveries` webhook is
    // Messenger-only, and the native IG app shows only Sent → Seen. So the UI
    // treats a sent IG message as delivered (two ticks) rather than leaving a
    // lone "sent" tick that looks stuck until the customer reads it.
    deliveryReceipts: false,
    typingIndicators: true,
    interactive: true,
    // Business reactions via the unified social messaging endpoint.
    sendReaction: true,
    calling: false,
    // Instagram media send is URL-based (payload.url), not upload/attachment_id.
    mediaSendByUrl: true,
    profileSync: true,
    contactShareChips: true,
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
    messageTextMaxChars: 4096,
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
    messageTextMaxChars: 100_000,
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
    messageTextMaxChars: 1600,
    templates: false,
    readReceipts: false,
    typingIndicators: false,
    interactive: false,
    calling: false,
  },

  // ---- LIVE (first-party) ---------------------------------------------------
  // Website chat widget: a live in-browser session, so there's NO 24h window
  // (freeFormWindowMs: null — the composer is always open) and no templates. We
  // own both ends of the wire (our widget renderer + our fanout), so media is
  // delivered by same-origin R2 URL (mediaSendByUrl) and captions inline as one
  // bubble (see supportsInlineCaption). Read/delivery receipts + typing are
  // driven over the visitor socket. No reactions, no calling.
  webchatwidget: {
    freeFormWindowMs: null,
    humanAgentWindowMs: null,
    messageTextMaxChars: 4096,
    templates: false,
    readReceipts: true,
    deliveryReceipts: true,
    typingIndicators: true,
    interactive: false,
    sendReaction: false,
    calling: false,
    mediaSendByUrl: true,
    profileSync: false,
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
  "webchatwidget",
]);

export function isChannelLive(channel: Channel): boolean {
  return LIVE_CHANNELS.has(channel);
}

/**
 * Channels a broadcast can target. A broadcast is PROACTIVE bulk outbound to a
 * stored address, so it needs a channel we can push to at any time — the Meta
 * channels (WhatsApp via templates, Messenger/Instagram via their reopen rules).
 *
 * `webchatwidget` is deliberately EXCLUDED: a website visitor is reachable only
 * while their browser tab holds a live socket — there's no durable push address
 * to send a campaign to. So widget contacts never appear as broadcast recipients
 * and `webchatwidget` is not a selectable broadcast channel. Must stay a SUBSET
 * of LIVE_CHANNELS.
 */
export const BROADCASTABLE_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  "whatsapp",
  "messenger",
  "instagram",
]);

export function isBroadcastable(channel: Channel): boolean {
  return BROADCASTABLE_CHANNELS.has(channel);
}

/**
 * Channels whose contacts are EPHEMERAL: a session identity, not a person we can
 * reach again. A website-widget visitor is a `vis_<uuid>` held in ONE browser's
 * localStorage — clear it, switch device, or open incognito and the same human is
 * a brand-new contact forever. Those rows are chat sessions, not directory
 * entries, so they must not accumulate in the contacts list, CSV exports,
 * audience counts, global search, or the person rollup.
 *
 * They are NOT second-class in the inbox: full thread, full realtime, workflows
 * still fire. This is purely about the CONTACT DIRECTORY.
 *
 * PROMOTION: an ephemeral contact that self-asserts a phone or email (the widget
 * pre-chat form) has told us how to reach them again, so it graduates to a normal
 * directory contact — the "Visitor → Lead → Contact" model. That is DERIVED from
 * the row, never stored, so promotion happens the instant the value lands with no
 * flag to flip and nothing that can drift. The two predicates that express it live
 * next to the queries that need them: `DIRECTORY_CONTACT_SQL` and
 * `directoryContactWhere` in apps/api/src/lib/queries/contacts.ts.
 *
 * Ephemeral contacts are also excluded from the identity strong-key CANDIDATE set
 * (`findExistingCustomerIdByStrongKey`) — a value typed into an unauthenticated
 * public form is not a verified key in either direction.
 *
 * Must stay a SUBSET of LIVE_CHANNELS and DISJOINT from BROADCASTABLE_CHANNELS.
 */
export const EPHEMERAL_CONTACT_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  "webchatwidget",
]);

export function isEphemeralChannel(channel: Channel): boolean {
  return EPHEMERAL_CONTACT_CHANNELS.has(channel);
}

/**
 * How a channel identifies a contact. `phone` channels resolve/create contacts
 * by `Contact.phoneNumber`; `external` channels use the opaque provider id
 * (`Contact.externalContactId`) via the `(workspaceId, identityChannel,
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
  // Website widget: an opaque per-browser visitor id, keyed via
  // (workspaceId, identityChannel, externalContactId) like the social channels.
  webchatwidget: "external",
};

/** True when the channel keys contacts by phone number (WhatsApp today). */
export function isPhoneChannel(channel: Channel): boolean {
  return CHANNEL_IDENTITY_KIND[channel] === "phone";
}

/**
 * Friendly stand-in shown for a contact whose real display name hasn't been
 * fetched yet. A brand-new Messenger/Instagram conversation arrives with NO
 * display name — only an opaque PSID/IGSID — and the async Graph enrichment pass
 * fills the real name a few hundred ms later. Without this the inbox flashes the
 * raw id (e.g. "17885439021234") before the name lands. The wire serializer
 * substitutes this when a contact's name still equals its external id; the
 * enrichment guard treats it as "not a real name yet" so it can never wedge the
 * enrichment (kept here, next to the identity maps, so the two agree).
 */
const CHANNEL_CONTACT_PLACEHOLDER: Partial<Record<Channel, string>> = {
  messenger: "Messenger user",
  instagram: "Instagram user",
  telegram: "Telegram user",
  // A visitor who hasn't submitted the pre-chat form has no name yet.
  webchatwidget: "Website visitor",
};

/**
 * A stable, human-friendly label for an ANONYMOUS ephemeral visitor.
 *
 * Every website visitor previously rendered as the same "Website visitor" string,
 * so an inbox with five live widget chats showed five identical rows — an agent
 * could not tell who they were replying to, or refer to one in a note. Crisp and
 * Drift both solve this with a short per-visitor tag; this is the same idea,
 * derived from the visitor id so it is deterministic (no storage, no migration,
 * and the SAME label every time that browser returns).
 *
 * Takes the last 4 alphanumerics of the id — `…cb6df817017f` → "Visitor 017F".
 * Collisions are possible in principle but cosmetic: the id remains the identity,
 * this is only a display handle.
 */
export function ephemeralVisitorLabel(externalContactId: string | null | undefined): string {
  const compact = (externalContactId ?? "").replace(/[^a-zA-Z0-9]/g, "");
  if (compact.length < 4) return "Website visitor";
  return `Visitor ${compact.slice(-4).toUpperCase()}`;
}

export function socialContactPlaceholder(channel: Channel | null | undefined): string {
  return (channel ? CHANNEL_CONTACT_PLACEHOLDER[channel] : undefined) ?? "New contact";
}

const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.values(CHANNEL_CONTACT_PLACEHOLDER),
  "New contact",
]);

/** Whether a stored name is one of the un-enriched placeholders (never "real"). */
export function isSocialContactPlaceholder(name: string | null | undefined): boolean {
  return !!name && PLACEHOLDER_NAMES.has(name);
}

/**
 * Whether a caption rides INLINE on the media itself (one message) for this
 * channel + media kind, per Meta's actual API:
 *   - WhatsApp: only image / video / document accept a `caption` field. Audio +
 *     sticker reject it (Meta error 100).
 *   - Messenger / Instagram: a `message` is an attachment OR text, NEVER both —
 *     no caption field exists on any social attachment.
 * When this is false, a typed caption can't be inlined; the send layer delivers
 * it as a SEPARATE follow-up text (never silently dropped), and the composer
 * says so instead of promising a single-message "caption". Single source of
 * truth so the UI hint and the send behavior can never disagree.
 */
export function supportsInlineCaption(channel: Channel, kind: MediaKind): boolean {
  // Website widget: we control the renderer, so any media can carry an inline
  // caption in the same bubble (no awkward follow-up text like the Meta channels).
  if (channel === "webchatwidget") return true;
  if (channel !== "whatsapp") return false;
  return kind === "image" || kind === "video" || kind === "document";
}
