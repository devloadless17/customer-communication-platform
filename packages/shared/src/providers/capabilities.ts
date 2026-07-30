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
    // NOT WhatsApp-only, as this note used to claim: Instagram has had the
    // Moderate Conversations API since 2025-10-21. Messenger still has no
    // equivalent messaging-API blocklist.
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
    // Ice breakers + persistent menu, on the same `messenger_profile` node
    // Instagram uses (Messenger needs no `platform=` disambiguator).
    entryPoints: true,
    // Get Started button + greeting + commands menu. Messenger-ONLY — Instagram's
    // profile node rejects all three, which is why this is a separate flag from
    // `entryPoints` rather than the same panel.
    welcomeScreen: true,
    // Sticker API (GA 2026-06-01): ~105 first-party packs, browse/search/send.
    stickers: true,
    // Handover Protocol — take / request / pass / release thread control. NOT
    // set on Instagram: Meta replaced Handover Protocol there with Conversation
    // Routing on 2025-10-23, and these four verbs don't describe that model.
    threadControl: true,
    // Inline button + generic (carousel) message templates. NOT `templates`,
    // which means an approved catalog — Messenger's utility templates are a
    // separate, unbuilt surface. See messenger-templates.ts.
    structuredTemplates: true,
    // Personas: "Adam from Jasper's Market" instead of the bare Page name.
    personas: true,
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
    // Business reactions via the unified social messaging endpoint. Instagram
    // accepts exactly ONE outbound reaction value — the documented `love` heart —
    // which `sendSocialReaction` coerces to and the composer offers alone.
    sendReaction: true,
    calling: false,
    // Provider-level blocklist: `POST /{page-id}/moderate_conversations` with
    // `block_user` / `unblock_user` (Moderate Conversations API, 2025-10-21).
    blockUsers: true,
    // `move_to_spam`, the third Moderate Conversations action. Files the thread
    // as spam in Business Suite WITHOUT severing contact — the right answer for
    // junk that doesn't warrant a permanent block.
    moderateSpam: true,
    // Conversation Routing. Meta discontinued Instagram's Handover Protocol on
    // 2025-10-23 and migrated everyone to routing, which runs on the same
    // Page-node endpoints Messenger uses.
    threadControl: true,
    // Meta's structured templates. Instagram has no APPROVED-template catalog the
    // way WhatsApp does (`templates: false` above means exactly that), but it does
    // have these three send-time shapes, and they are core outbound here: the
    // button template behind `cta_url`, the generic template (1-10 cards), and
    // the product template (1-10 catalog items).
    genericTemplate: true,
    productTemplate: true,
    // Public replies on the comment thread (`POST /<comment-id>/replies`) — the
    // complement to the private reply: visible to everyone, no per-comment cap,
    // starts no conversation.
    publicCommentReply: true,
    // Private replies to comments — the only send allowed to someone who has
    // commented but never messaged (`recipient: { comment_id }`, one per
    // comment, 7 days). Requires `instagram_manage_comments` + `pages_messaging`.
    commentPrivateReply: true,
    // Ice breakers (≤4) + persistent menu (≤5) on
    // `/{page-id}/messenger_profile?platform=instagram`.
    entryPoints: true,
    // The single URL-opening button, sent as Meta's BUTTON TEMPLATE (`text` +
    // one `web_url` button). Instagram has no interactive `cta_url` type the way
    // WhatsApp does; the button template is the documented equivalent, capped at
    // 640 characters of text and 1-3 buttons.
    ctaUrlButton: true,
    templateTextMaxChars: 640,
    // Instagram media send goes out by URL (`payload.url`). Meta added
    // `attachment_id` support on 2026-03-13 as an ALTERNATIVE for re-sending the
    // same large image to many people; a URL send remains fully supported and is
    // what a one-off agent reply wants, so this stays URL-based.
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
 * Channels whose CONTACT IDENTITY is scoped to the receiving account.
 *
 * Meta is explicit that an Instagram-scoped ID is "specific to the person AND
 * the Instagram account they are interacting with" — and a Messenger PSID is
 * page-scoped the same way. The id a customer has on account A is therefore not
 * a valid recipient for account B: Meta cannot resolve it, and the send fails.
 *
 * This is the opposite of WhatsApp, where a phone number is globally valid. There,
 * messaging a contact from a second number WORKS — it just migrates thread
 * ownership, which is a product tradeoff the broadcast composer exposes as the
 * `includeOtherAccounts` opt-in.
 *
 * On a scoped-identity channel that opt-in is not a tradeoff, it is an error: it
 * would queue a whole audience of sends that cannot succeed, burn the campaign,
 * and fill the failure report with opaque Meta errors that look like a delivery
 * problem rather than an impossible request. So the audience is ALWAYS the
 * sending account's own contacts here, and the opt-in is refused rather than
 * honoured.
 */
export const ACCOUNT_SCOPED_IDENTITY_CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  "instagram",
  "messenger",
]);

/** True when a contact's id on this channel only works for the account that issued it. */
export function isAccountScopedIdentity(channel: Channel): boolean {
  return ACCOUNT_SCOPED_IDENTITY_CHANNELS.has(channel);
}

/**
 * NON-DM INBOX SOURCES — everything that can reach the inbox that is not a
 * direct message.
 *
 * The product's core is DMs. A direct message IS the inbox and is never gated:
 * it is why the channel was connected. Anything else a platform can push at us —
 * public comments today, @mentions and review-style surfaces later — is a
 * DIFFERENT kind of work with different reply rules, different volume, and a
 * different answer per team. On a busy Instagram account comments outnumber DMs
 * heavily, so a team that connected Instagram to answer messages must not have
 * that decided for them by a deploy.
 *
 * So: every non-DM source is OFF until an admin turns it on, per account, and
 * this is the list of what can be turned on. Adding a future source means adding
 * it here and mapping it in `inboxSourceOfStructuredKind` — the gate itself, the
 * settings UI and the `/v1` surface then pick it up with no further change.
 */
export const INBOX_SOURCES = ["comments"] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

/**
 * Which non-DM sources each channel can even offer. A channel absent here has
 * none — its inbox is DMs and nothing else, and its settings page shows no
 * toggles rather than an empty section.
 *
 * Instagram is the only one today. Messenger's Page feed comments are the
 * obvious next entry; WhatsApp has no non-DM surface at all.
 */
export const CHANNEL_INBOX_SOURCES: Partial<Record<Channel, readonly InboxSource[]>> = {
  instagram: ["comments"],
};

export function channelInboxSources(channel: Channel): readonly InboxSource[] {
  return CHANNEL_INBOX_SOURCES[channel] ?? [];
}

/**
 * The non-DM source a stored message came from, or null when it is an ordinary
 * direct message.
 *
 * Keyed off `Message.structured.kind` because that is what actually distinguishes
 * them on the wire — a comment rides the ordinary inbound-message shape on
 * purpose, so it can reuse contacts, conversations, realtime and workflows with
 * no second entity. This is the one function that knows the mapping, so the
 * ingest gate and any future reader cannot disagree about what a source is.
 */
export function inboxSourceOfStructuredKind(kind: string | undefined): InboxSource | null {
  return kind === "comment" ? "comments" : null;
}

/**
 * Meta's private-reply window: "within 7 days from when the comment was created".
 */
export const COMMENT_PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The minimum a caller must know about a thread message to answer this. */
export interface PrivateReplyCandidate {
  id: string;
  direction: "in" | "out";
  /** ISO instant. */
  timestamp: string;
  structuredKind?: string;
  /** For outbound: the message id it answers. */
  replyToMessageId?: string | null;
}

/**
 * Is there a comment on this thread we may still answer PRIVATELY?
 *
 * The rule, straight from Meta: a comment grants exactly ONE reply addressed at
 * the comment, within 7 days, and no 24-hour conversation until the person
 * answers it. So an agent looking at a comment-only thread is not "outside the
 * window" — there is no window yet, and refusing to let them type would make the
 * one legal reply unreachable.
 *
 * Shared because BOTH ends need the same answer and must not drift: the server
 * resolves the actual comment to address (against every message, from the DB),
 * and the composer decides whether to unlock (against the messages it has
 * loaded). The server stays authoritative — it re-resolves before sending and
 * refuses if the comment is spent — so the client being optimistic on a partial
 * page costs at worst the error the agent would have got anyway.
 */
export function hasAnswerableComment(
  messages: readonly PrivateReplyCandidate[],
  now: number = Date.now(),
): boolean {
  const answered = new Set(
    messages.flatMap((m) =>
      m.direction === "out" && m.replyToMessageId ? [m.replyToMessageId] : [],
    ),
  );
  return messages.some(
    (m) =>
      m.direction === "in" &&
      inboxSourceOfStructuredKind(m.structuredKind) === "comments" &&
      !answered.has(m.id) &&
      now - new Date(m.timestamp).getTime() <= COMMENT_PRIVATE_REPLY_WINDOW_MS,
  );
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
