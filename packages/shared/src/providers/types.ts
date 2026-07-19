import type { MediaKind, MessageAttribution, MessageStatus, MessageStructured, Channel, SocialProfile } from "../types";

/**
 * Provider-agnostic shapes the ingest pipeline consumes.
 *
 * Each `MessagingProvider` is responsible for turning its own webhook payload
 * into one of these. App code never sees Evolution or Meta wire shapes — only
 * NormalizedEvent values. CLAUDE.md rule #1.
 */

/**
 * Reference to a media attachment as it exists on the provider side. The
 * webhook route resolves these by calling `provider.fetchMedia` with the
 * team's send config, then hands the bytes to `lib/blob-storage/` which
 * returns the blob key + public URL the ingest pipeline persists.
 *
 * `storageKey` + `storageUrl` + `sizeBytes` are filled in by the webhook
 * route after the upload — parsers leave them undefined; ingest requires them.
 */
export interface NormalizedMediaRef {
  kind: MediaKind;
  /**
   * Provider-side id used to fetch the binary (WhatsApp: a media id passed to
   * `fetchMedia`). Empty string for channels that deliver a direct URL instead
   * (see `sourceUrl`).
   */
  externalMediaId: string;
  /**
   * Direct download URL for channels that ship the binary as a (temporary,
   * often-expiring) CDN URL in the webhook rather than a fetch-by-id handle —
   * Messenger / Instagram attachments. When set, the inbound-media path fetches
   * this URL directly (no `fetchMedia` / send-config needed) and streams it to
   * R2. Undefined for WhatsApp (which uses `externalMediaId`).
   */
  sourceUrl?: string;
  mimeType: string;
  /** Filename (documents) — Meta only sends this for type=document. */
  filename?: string;
  /** Audio + video duration if the provider includes it. */
  durationMs?: number;
  /** Audio only: true for a WhatsApp voice note (Meta `audio.voice`) vs a
   *  shared audio file. Persisted to Message.mediaVoice + surfaced on the
   *  bubble as the mic / "Voice message" affordance. */
  voice?: boolean;
  /** Blob-storage provider key — used later for delete. */
  storageKey?: string;
  /** Public CDN URL the browser fetches via /api/media/[id]. */
  storageUrl?: string;
  sizeBytes?: number;
  /**
   * Video-only — first-frame poster JPEG. Generated server-side during
   * inbound media download via ffmpeg + uploaded as a separate blob so the
   * `<video>` element can render a poster frame instead of a black square
   * until the user clicks play. Filled in by the webhook route, like the
   * `storage*` fields above.
   */
  thumbnailStorageKey?: string;
  thumbnailStorageUrl?: string;
}

/**
 * Interactive reply from a contact who tapped a quick-reply button or list
 * row in a previous outbound interactive message. The parser folds the
 * tapped option's title into `body` (so search + previews stay uniform with
 * text messages) AND surfaces the option's stable id here for workflow
 * routing — Meta's button/list ids are author-controlled at send time, so
 * the ask_question step recognises them on reply without parsing free text.
 */
export interface InteractiveReply {
  kind: "button_reply" | "list_reply";
  /** Author-assigned id (the `id` field on the outbound option). */
  id: string;
  /** Display title the contact tapped — matches `body` for convenience. */
  title: string;
}

/**
 * Channel-agnostic contact identity carried by every inbound-bearing normalized
 * event. Exactly one field is set, decided by whether the channel is phone-based:
 *
 *   - Phone channels (WhatsApp): `contactPhone` = E.164 digits, no '+'.
 *   - Non-phone channels (Messenger, Instagram, Telegram, …): `externalContactId`
 *     = the provider's opaque per-account id (Messenger PSID, Instagram IGSID,
 *     Telegram chat id). NEVER digit-stripped — these are not phone numbers.
 *
 * Ingest resolves the Contact from whichever is present (phone → `phoneNumber`
 * lookup; externalContactId → the `(teamId, identityChannel, externalContactId)`
 * compound-unique lookup). See `apps/api/src/lib/providers/ingest.ts`.
 */
export interface NormalizedContactIdentity {
  /** Set by phone-based channels. E.164 digits, no '+'. e.g. "5511999999999". */
  contactPhone?: string;
  /** Set by non-phone channels. Provider's opaque per-account id (PSID/IGSID). */
  externalContactId?: string;
  /**
   * WhatsApp Business-Scoped User ID (BSUID) — forward-compat for Meta's 2026
   * privacy rollout, where a WhatsApp webhook may carry an opaque per-business
   * id instead of (or alongside) the phone. Ingest persists it on the contact
   * and resolves on it when `contactPhone` is absent, so those inbounds aren't
   * dropped. Undefined for every channel today.
   */
  bsuid?: string;
  /** WhatsApp public @username (2026), when present. Display + soft key only. */
  username?: string;
}

export interface NormalizedInboundMessage extends NormalizedContactIdentity {
  kind: "message";
  /** Provider-assigned id; the dedupe key. */
  externalId: string;
  /** Display name from the provider, if any. We fall back to the identity. */
  contactName: string | null;
  /**
   * Body text. For text messages this is the message itself; for media it's
   * the caption (or empty); for interactive replies it's the tapped option's
   * title. Either body or media (or both) will be present.
   */
  body: string;
  /** Set when the message carries an attachment that needs downloading. */
  media?: NormalizedMediaRef;
  /** Set when the message is a contact's tap on a button / list row. */
  interactiveReply?: InteractiveReply;
  /**
   * Structured non-media content (shared location pin / contact card). `body`
   * still carries the text placeholder; this drives the rich bubble. Persisted
   * to `Message.structured` by ingest.
   */
  structured?: MessageStructured;
  /**
   * Ad / deep-link attribution (Click-to-WhatsApp / Click-to-Messenger). Set on
   * the first inbound of an ad-sourced conversation; persisted to
   * `Message.attribution` by ingest.
   */
  attribution?: MessageAttribution;
  /**
   * Provider id of the message this one is replying to (Meta `context.id`).
   * Ingest resolves it to our internal Message.id; the parser stays
   * provider-agnostic by emitting the wamid only.
   */
  replyToExternalId?: string;
  timestamp: Date;
  rawPayload: Record<string, unknown>;
}

export interface NormalizedStatusUpdate {
  kind: "status";
  /** externalId of the message whose status is changing. */
  externalId: string;
  status: MessageStatus;
  /**
   * Delivery-failure diagnostics — set ONLY when `status === "failed"` and the
   * provider surfaced a reason. For Meta these come from the status webhook's
   * `errors[0]`: numeric `code` (e.g. 131049 frequency cap, 131026 undeliverable),
   * short human `title`, and `error_data.details` (the actionable text). Ingest
   * persists them on the Message row so the failed bubble can show WHY instead of
   * a bare red icon. Absent on every non-failed transition.
   */
  errorCode?: number;
  errorTitle?: string;
  errorDetail?: string;
  /**
   * Billing metadata for this message, when the provider reported it (WhatsApp
   * attaches it to the `sent` status). Category + billable flag only — Meta
   * never sends a price, and per-country rate cards change quarterly, so a
   * computed amount would freeze a wrong number into the audit trail. Campaign
   * cost reporting counts billable conversations by category.
   */
  pricing?: { billable?: boolean; category?: string; model?: string };
  timestamp: Date;
  rawPayload: Record<string, unknown>;
}

/**
 * A "read up to here" receipt. Meta social channels (Messenger / Instagram)
 * report read state as a watermark keyed on the CUSTOMER — not per message id —
 * so ingest marks every outbound message to that customer at or before
 * `watermark` as read (that's the "Seen" / blue-tick state). WhatsApp uses the
 * per-message `NormalizedStatusUpdate{status:"read"}` path instead.
 */
export interface NormalizedReadWatermark {
  kind: "read_watermark";
  /** The customer who read — PSID / IGSID (social) or phone (unused today). */
  externalContactId?: string;
  contactPhone?: string;
  /** All outbound messages to this customer at/before this instant are read. */
  watermark: Date;
  rawPayload: Record<string, unknown>;
}

/**
 * A "delivered up to here" receipt. Messenger's `message_deliveries` webhook
 * ALWAYS carries a `watermark` (and only SOMETIMES a `mids[]` — omitted for
 * older clients). So delivery is watermark-based exactly like read: mark every
 * outbound message to the customer at/before `watermark` as `delivered`. Without
 * this a watermark-only delivery is dropped and the message sits on a lone
 * "sent" tick until it's read. Instagram has no delivery webhook (never emits
 * this); WhatsApp uses the per-message status path.
 */
export interface NormalizedDeliveredWatermark {
  kind: "delivered_watermark";
  externalContactId?: string;
  contactPhone?: string;
  watermark: Date;
  rawPayload: Record<string, unknown>;
}

/**
 * One step of a WhatsApp call's lifecycle as it arrives via webhook. The
 * Meta provider emits one of these per call webhook (incoming offer,
 * outbound answer, terminal status). Ingest dedupes by
 * (teamId, channel, externalCallId) the same way it does for messages,
 * then maps `phase` to CallStatus.
 *
 * `phase` is intentionally finer-grained than CallStatus — `ringing_out`
 * vs `incoming` lets the audit subscriber differentiate direction without
 * a Call-row read; the ingest mapper collapses both to `CallStatus.ringing`.
 */
export interface NormalizedCallEvent {
  kind: "call";
  /** Meta-assigned call id; dedup key half. */
  externalCallId: string;
  /**
   * Channel-scoped caller identity — exactly ONE is set, mirroring
   * `NormalizedInboundMessage`:
   *   - phone channels (WhatsApp): `contactPhone` = E.164 digits, no '+'.
   *   - external-id channels (Messenger PSID / Instagram IGSID): `externalContactId`.
   * Ingest branches on the channel's identity kind to resolve/create the
   * Contact, so a second calling channel never digit-strips a PSID or collides
   * with a phone contact sharing the same digits.
   */
  contactPhone?: string;
  externalContactId?: string;
  /**
   * WhatsApp business-scoped user id (BSUID). Meta omits `wa_id` for contacts
   * not messaged in the last 30 days, so a cold caller arrives identified by a
   * BSUID and no phone. A BSUID is NOT a phone number and must never be
   * digit-stripped into one — carry it here and let ingest resolve on it, the
   * same way the inbound-message path does.
   */
  bsuid?: string;
  contactName: string | null;
  direction: "in" | "out";
  /**
   * Channel-AGNOSTIC lifecycle phase. Each provider's parser maps its own
   * wire vocabulary onto this set — downstream (ingest / service / UI) never
   * sees provider specifics. A new channel with calling implements its
   * `MessagingProvider` calling methods + maps its webhooks to these phases;
   * nothing below the parser changes.
   */
  phase:
    | "incoming"      // inbound call ringing
    | "ringing_out"   // outbound call we just placed
    | "connecting"    // outbound media leg established with the provider's
                      // media server (e.g. WhatsApp Cloud-API SDP answer).
                      // This is NOT customer pickup — it carries the SDP so
                      // the browser can negotiate media, but the call stays
                      // `ringing` until a real answer is observed.
    | "completed"     // call connected then ended (carries connectedAt+duration)
    | "missed"        // never answered (declined / no-answer / timeout)
    | "rejected"      // explicitly declined (providers that distinguish it)
    | "failed"        // signaling/media error
    | "permission_granted"
    | "permission_revoked";
  /**
   * Set on a `permission_granted` event when Meta marked the grant PERMANENT
   * (`is_permanent: true` — the customer chose "always allow" rather than the
   * default 72h window). Ingest then stores a far-future expiry instead of
   * `grantedAt + 72h`, so a permanent grant isn't wrongly treated as expired.
   * Absent/false ⇒ the standard 72h validity.
   */
  permanentPermission?: boolean;
  /**
   * WebRTC SDP. For inbound calls: customer's `offer`. For outbound: the
   * provider's media-server `answer` (delivered at `connecting`, BEFORE the
   * human picks up). Meta sometimes sends answers with `a=setup:actpass`
   * which RTCPeerConnection rejects on the offerer side; the Meta provider
   * rewrites those to `setup:active`.
   */
  sdp?: { type: "offer" | "answer"; sdp: string };
  /**
   * Real customer pickup time, set ONLY on a terminal event for a call that
   * actually connected. Channel-agnostic "this call was answered" signal —
   * each provider derives it however it can (Meta: the `terminate` payload's
   * `start_time`, which is present only for answered calls). Absent ⇒ the
   * call was never answered, so ingest records it as `missed`, not connected.
   */
  connectedAt?: Date;
  /**
   * Real talk-time in seconds, from the provider's authoritative end-of-call
   * duration (Meta: `terminate.duration`). Present only when the call
   * connected. Preferred over `endedAt - connectedAt` so the persisted record
   * matches the provider's own billing/duration exactly.
   */
  durationSeconds?: number;
  timestamp: Date;
  rawPayload: Record<string, unknown>;
}

// ─── Meta social calling (Messenger) contract ──────────────────────────────
// Meta social calling uses ONE endpoint (`POST /{page-id}/calls`) with an
// `action` discriminator and returns SDP synchronously — structurally distinct
// from WhatsApp's method-per-action + webhook-delivered answer, so it gets its
// own provider methods below. Wire reference: docs/messenger-calling.md.

export interface CallActionArgs {
  action: "connect" | "accept" | "reject" | "terminate" | "media_update";
  /** Required for accept/reject/terminate/media_update (from the connect webhook). */
  callId?: string;
  /** Required for `connect` (outbound) — the consumer PSID to dial. */
  to?: string;
  /** SDP offer for connect/accept; omitted for reject/terminate. */
  sdp?: string;
}
export interface CallActionResult {
  /** Present on `connect` — the new call id Meta assigned. */
  callId?: string;
  /** SDP answer to apply as the browser's remote description. */
  sdpAnswer?: string;
  /** Renegotiation offer (accept may return one) — apply, then re-answer. */
  sdpRenegotiation?: string;
}
export interface SocialCallPermission {
  hasPermission: boolean;
  canStartCall: boolean;
  canRequestPermission: boolean;
  expiresAt: Date | null;
}

/**
 * A template's review/quality status changed on the provider side. Emitted from
 * the provider's `message_template_status_update` webhook (Meta sends one when a
 * template is approved, paused for quality, disabled, or rejected). Without
 * ingesting these, the local catalog only refreshes on a manual "Sync" click —
 * so a Meta-paused marketing template silently mass-fails a scheduled broadcast,
 * and a newly-approved template never becomes sendable until someone clicks Sync.
 *
 * Ingest matches the local row by externalId (Meta's template id) when present,
 * else by (name, language), and flips its `status`. `status` is null when the
 * provider's event value doesn't map to a known TemplateStatus (forward-compat).
 */
export interface NormalizedTemplateStatusUpdate {
  kind: "template_status";
  /** Provider-side template id (Meta `message_template_id`), when present. */
  externalId?: string;
  /** Template name — the fallback match key when externalId is absent. */
  name?: string;
  /** Template language code — paired with name for the fallback match. */
  language?: string;
  /** New status, already mapped to our enum; null when unmappable. */
  status: TemplateStatus | null;
  /**
   * New category, already mapped to our enum — set ONLY by the
   * `template_category_update` webhook (Meta auto-migrates a template's category,
   * e.g. MARKETING→UTILITY, which changes its pricing + which window reopens it).
   * Absent on status/quality updates. Ingest updates the local row's category
   * when present.
   */
  category?: TemplateCategory;
  /** Provider's human reason for the change (Meta `reason`), if any. */
  reason?: string;
  rawPayload: Record<string, unknown>;
}

/**
 * A customer reacted to (or un-reacted from) one of our messages. WhatsApp
 * delivers these as `m.type === "reaction"` with `m.reaction = { message_id,
 * emoji }`; an empty `emoji` means the reaction was removed. Ingest finds the
 * target Message by `targetExternalId` (the reacted-to wamid) and sets its
 * `reaction` column, then fans out `message.reaction_changed` to the thread.
 * Inbound-only — agent-side reacting is deferred.
 */
export interface NormalizedReaction {
  kind: "reaction";
  /** The reaction message's OWN provider id (for logging / future dedupe). */
  externalId: string;
  /** Provider id (wamid) of the message being reacted to — the match key. */
  targetExternalId: string;
  /** The emoji, or null when the customer REMOVED their reaction. */
  emoji: string | null;
  /**
   * E.164 digits (WhatsApp). Optional — ingest resolves the target message by
   * `targetExternalId` and never needs the reactor's identity, so the Meta
   * social channels emit reactions without it.
   */
  contactPhone?: string;
  timestamp: Date;
  rawPayload: Record<string, unknown>;
}

/**
 * A message the BUSINESS sent from the WhatsApp Business App on the owner's
 * phone (WhatsApp Coexistence), mirrored back to us so the shared inbox stays
 * in sync with the phone. Two sources emit this:
 *   - the live `smb_message_echoes` webhook (an owner reply after onboarding), and
 *   - the `history` backfill for past outbound messages (where `from` = the
 *     business number and the payload carries a `to`).
 *
 * The dedupe/direction subtlety that makes this its own variant: the wire
 * payload's `from` is the BUSINESS number and `to` is the CUSTOMER, the inverse
 * of an inbound message. `contactPhone` here is therefore taken from `to` — the
 * customer whose conversation this belongs in — NOT `from`. Ingest writes it as
 * a `direction:"out"`, `senderUserId:null`, `origin:"business_app"` row via
 * `createOutboundMessageIdempotent`, so an echo of a message our own API already
 * sent collides on the wamid unique and is a safe no-op (returns the existing
 * row) rather than creating a phantom.
 */
export interface NormalizedOutboundEcho extends NormalizedContactIdentity {
  kind: "echo";
  /** Provider-assigned id (wamid / mid) — the dedupe key. */
  externalId: string;
  /**
   * The CUSTOMER this echo belongs to (the message `to`, NOT the business
   * `from`). Exactly one identity is set, keyed on the channel kind — WhatsApp
   * Coexistence echoes set `contactPhone`; Messenger/Instagram native-inbox
   * echoes set `externalContactId` (the customer's PSID / IGSID). Ingest
   * branches on the channel's identity kind.
   */
  contactPhone?: string;
  /** Body text (or media caption); empty for media-only. */
  body: string;
  /** Set when the echoed message carries an attachment that needs downloading. */
  media?: NormalizedMediaRef;
  timestamp: Date;
  rawPayload: Record<string, unknown>;
}

/**
 * The owner's WhatsApp Business App address-book changed (Coexistence
 * `smb_app_state_sync`): a phone contact was added, edited, or removed. We use
 * it only to NAME contacts that already exist in the inbox (someone who has
 * messaged us) — we do NOT create empty contacts for address-book entries who
 * never messaged (that would bloat the directory and violate "Contact = a
 * channel identity we actually converse with"). Naming respects the existing
 * "agent owns the name, sticky after create" policy: it fills a blank/default
 * name, never clobbers one an agent typed.
 */
export interface NormalizedContactSync {
  kind: "contact_sync";
  /** E.164 digits, no '+'. */
  phone: string;
  /** The contact's name from the owner's phone address book, if any. */
  fullName: string | null;
  /** `add` (added/edited) or `remove` (deleted from the address book). */
  action: "add" | "remove";
  rawPayload: Record<string, unknown>;
}

/**
 * The customer edited or unsent (deleted) one of the messages in the thread.
 * WhatsApp delivers a revoke/edit; Messenger/Instagram deliver an unsend
 * (`message.is_deleted`). Ingest finds the target Message by `targetExternalId`
 * (its mid/wamid) and either tombstones it (`action: "delete"` → sets
 * `deletedAt`, body preserved) or updates its body (`action: "edit"` → sets
 * `editedAt` + new body), then fans out `message.updated` to the thread.
 * Inbound-only (the customer's action on their own message).
 */
export interface NormalizedMessageCorrection {
  kind: "message_correction";
  action: "edit" | "delete";
  /** Provider id (mid/wamid) of the message being edited/deleted — the match key. */
  targetExternalId: string;
  /** New body text — set only for `action: "edit"`. */
  newBody?: string;
  timestamp: Date;
  rawPayload: Record<string, unknown>;
}

/**
 * The customer's 👍/👎 feedback on a message the BUSINESS sent (Messenger
 * `response_feedback`). NOT a reaction — a distinct helpful/not-helpful signal
 * on our OUTBOUND message. Matched by `targetExternalId` (the message id).
 */
export interface NormalizedMessageFeedback {
  kind: "message_feedback";
  targetExternalId: string;
  feedback: "positive" | "negative";
  timestamp: Date;
  rawPayload: Record<string, unknown>;
}

/**
 * A customer changed their WhatsApp phone number. WhatsApp sends a `system`
 * message (`system.type:"user_changed_number"`) whose `system.wa_id` is the NEW
 * number and whose `messages[].from` is the OLD one. Ingest re-points the
 * existing contact to the new number so the person's thread CONTINUES instead of
 * fragmenting into a second contact + conversation when they next message.
 */
export interface NormalizedContactNumberChange {
  kind: "contact_number_change";
  /** OLD phone (digits) — the contact to migrate. */
  oldPhone: string;
  /** NEW WhatsApp id / phone (digits) the customer moved to. */
  newPhone: string;
  rawPayload: Record<string, unknown>;
}

/**
 * The messaging-health of a business phone number changed (WhatsApp only). Meta
 * pushes these via the `phone_number_quality_update`, `account_alerts`, and
 * `business_capability_update` webhook fields: the number's messaging-limit TIER
 * (how many unique customers it may message per rolling 24h), quality rating
 * band, and throughput level. Ingest persists whichever fields are present onto
 * the team's WhatsApp `ChannelConnection`, so large template broadcasts can be
 * gated on the number's real capacity BEFORE sending and the composer can show
 * the operator their remaining daily allowance. Every field optional — a given
 * webhook only carries the field(s) that changed; ingest merges partial updates.
 */
export interface NormalizedChannelHealth {
  kind: "channel_health";
  /** Raw Meta messaging_limit tier, e.g. "TIER_1K" | "TIER_10K" | "TIER_100K" | "TIER_UNLIMITED". */
  messagingTier?: string;
  /** Quality band: "GREEN" | "YELLOW" | "RED". */
  qualityRating?: string;
  /** Throughput level: "STANDARD" | "HIGH". */
  throughputLevel?: string;
  rawPayload: Record<string, unknown>;
}

/**
 * A WhatsApp user changed their MARKETING messaging preference (Meta's
 * `user_preferences` webhook). `optedOut: false` is the only signal permitted to
 * clear an existing opt-out — an inbound STOP keyword may opt a customer OUT but
 * must never opt them back IN, because consent has to be affirmative.
 */
export interface NormalizedMarketingPreference {
  kind: "marketing_preference";
  /** E.164 digits, no '+'. */
  contactPhone: string;
  optedOut: boolean;
  timestamp: Date;
  rawPayload: Record<string, unknown>;
}

export type NormalizedEvent =
  | NormalizedInboundMessage
  | NormalizedContactNumberChange
  | NormalizedStatusUpdate
  | NormalizedReadWatermark
  | NormalizedDeliveredWatermark
  | NormalizedCallEvent
  | NormalizedReaction
  | NormalizedTemplateStatusUpdate
  | NormalizedOutboundEcho
  | NormalizedContactSync
  | NormalizedMessageCorrection
  | NormalizedMessageFeedback
  | NormalizedChannelHealth
  | NormalizedMarketingPreference;

export interface SendTextArgs {
  /** E.164 digits, no '+'. */
  to: string;
  body: string;
  /**
   * When set, the provider sends as a quoted reply. For Meta this becomes
   * `context.message_id`. Caller is responsible for resolving the wamid from
   * the local message id.
   */
  replyToExternalId?: string;
  /**
   * Meta SOCIAL only: `false` → send with `messaging_type: RESPONSE` (the right
   * type inside the 24h window — no tag, no special feature). `true`/undefined →
   * attach the Human Agent tag (for the 24h–7d support band). Set by the send
   * path from the window band. Ignored by WhatsApp.
   */
  useHumanAgentTag?: boolean;
  /**
   * WhatsApp only: render a link preview card for the first URL in `body`
   * (Meta's `text.preview_url`). When omitted, the provider auto-enables it if
   * the body contains an http(s) URL. Ignored by channels that preview links
   * natively (Messenger / Instagram).
   */
  previewUrl?: boolean;
}

export interface SendTextResult {
  externalId: string;
  timestamp: Date;
  /**
   * Set by `sendMedia` when a caption COULDN'T ride inline on the media (Meta
   * audio/sticker + all social media) and was therefore delivered as a separate
   * follow-up text — this is that follow-up's message id. The send orchestration
   * uses it to persist the caption as its OWN tracked message row (so it renders
   * as a real text bubble AND its echo dedups instead of returning as a phantom
   * "via app" message). Absent when the caption rode inline or there was none.
   */
  captionExternalId?: string;
}

/**
 * One option presented to the contact. `id` round-trips back to the
 * workflow as the `interactiveReply.id` on the inbound reply; pick stable
 * machine ids (yes/no, slot_morning, etc.) — the author-facing label goes
 * in `title`.
 */
export interface InteractiveOption {
  /** Stable machine id, max 256 chars per Meta. */
  id: string;
  /** Display label, max 20 chars for buttons / 24 for list rows. */
  title: string;
  /** Optional list-row sub-text (ignored for buttons). */
  description?: string;
}

/**
 * Outbound interactive message: a question + buttons (1-3) or list rows
 * (1-10). `kind` decides which WhatsApp interactive shape to send:
 *
 *   "buttons" → Meta's `interactive.type = "button"` (compact 3-button row)
 *   "list"    → Meta's `interactive.type = "list"` (sheet with rows, opened
 *               by tapping a single CTA button — `listCtaLabel` is its text)
 *
 * Caller pre-validates option counts; the provider also fails fast on
 * out-of-range option counts because Meta returns a cryptic 132xxx error
 * for "wrong button count" that an admin can't easily decode.
 */
export interface SendInteractiveArgs {
  /** E.164 digits, no '+'. */
  to: string;
  /** Question / body text the contact sees above the options. */
  bodyText: string;
  kind: "buttons" | "list";
  options: InteractiveOption[];
  /** List only — label on the CTA button that opens the row sheet.
   *  Defaults to "Choose" if omitted. Ignored for buttons. */
  listCtaLabel?: string;
  /** List only — header rendered above the rows. Defaults to "Options". */
  listSectionTitle?: string;
  /** Quoted-reply context, same semantics as SendTextArgs. */
  replyToExternalId?: string;
  /** Meta social only — see SendTextArgs.useHumanAgentTag. */
  useHumanAgentTag?: boolean;
  /**
   * Ask the contact to share their phone and/or email in ONE TAP, as consent
   * chips rendered beside the regular options. Only channels whose capabilities
   * declare `contactShareChips` accept this (Messenger + Instagram; WhatsApp has
   * no equivalent interactive type). Meta pre-fills the value from the customer's
   * profile and hides the chip entirely when their profile has no such value.
   *
   * This is the ONLY route by which a social contact's phone/email can ever reach
   * us — and therefore the only way a Messenger/Instagram contact becomes
   * auto-mergeable into a unified `Customer` (identity resolution keys on exact
   * phone/email; see docs/identity.md). A tap shares the value once and grants
   * no standing access to it.
   */
  contactShare?: ContactShareField[];
}

/** A profile field a social contact can share with one tap. */
export type ContactShareField = "phone" | "email";

/** Outbound location share (WhatsApp `type:"location"`). */
export interface SendLocationArgs {
  /** E.164 digits, no '+'. */
  to: string;
  latitude: number;
  longitude: number;
  /** Place name shown above the address. */
  name?: string;
  /** Human-readable address line. */
  address?: string;
  replyToExternalId?: string;
  /** Meta social only — see SendTextArgs.useHumanAgentTag. */
  useHumanAgentTag?: boolean;
}

/** One vCard in an outbound contacts message. */
export interface SharedContactInput {
  name: string;
  phones: string[];
  emails?: string[];
  /** Pre-formatted, human-readable address lines. */
  addresses?: string[];
  /** "Title · Company" (or whichever part exists). */
  company?: string;
}

/** Outbound contact share (WhatsApp `type:"contacts"`). */
export interface SendContactsArgs {
  to: string;
  contacts: SharedContactInput[];
  replyToExternalId?: string;
  useHumanAgentTag?: boolean;
}

/** Outbound emoji reaction to a customer message (WhatsApp `type:"reaction"`). */
export interface SendReactionArgs {
  to: string;
  /** The wamid of the message being reacted to. */
  messageExternalId: string;
  /** The emoji; an empty string REMOVES the reaction (Meta's convention). */
  emoji: string;
  useHumanAgentTag?: boolean;
}

export interface UploadMediaArgs {
  bytes: Uint8Array;
  mimeType: string;
  /** Filename hint sent to the provider — required for documents. */
  filename: string;
}

export interface UploadMediaResult {
  /** Provider-side media id, valid for ~30 days, single-use per message. */
  mediaId: string;
}

export interface SendMediaArgs {
  to: string;
  kind: MediaKind;
  /** Provider-side media id from a prior uploadMedia call. */
  mediaId: string;
  /**
   * Public (presigned) URL for the media, for channels whose media send is
   * URL-based rather than upload-based — Instagram sends `attachment.payload.url`
   * (the reusable Attachment-Upload/`attachment_id` path Messenger uses returns
   * errors on Instagram). Set by the send orchestration when the provider's
   * `mediaSendByUrl` capability is true; `mediaId` is empty in that case.
   */
  mediaUrl?: string;
  /** Optional caption — only image/video/document accept it on Meta. */
  caption?: string;
  /** Required for documents, ignored otherwise. */
  filename?: string;
  /** Same semantics as SendTextArgs — sends as a quoted reply. */
  replyToExternalId?: string;
  /**
   * Audio only: mark the message as a voice note. Meta renders it with the
   * native WhatsApp waveform UI on the recipient's side (vs. a generic audio
   * attachment chip). Ignored on non-audio kinds. Set true when the caller
   * knows the upload came from a microphone recorder, not a file picker.
   */
  voice?: boolean;
  /** Meta social only — see SendTextArgs.useHumanAgentTag. */
  useHumanAgentTag?: boolean;
}

export interface FetchedMedia {
  bytes: Uint8Array;
  mimeType: string;
  /** Filename if the provider exposed one; otherwise undefined. */
  filename?: string;
}

// ---------------------------------------------------------------------------
// Templates — required to send outbound outside the 24h customer-service
// window (free-form messages get rejected by Meta with error 131047). The
// provider abstraction owns both the fetch (sync from Meta) and the send.
// ---------------------------------------------------------------------------

export type TemplateStatus =
  | "approved"
  | "pending"
  | "rejected"
  | "paused"
  | "disabled";
export type TemplateCategory = "marketing" | "utility" | "authentication";

/**
 * One component of a template definition as returned by Meta's
 * `/{waba-id}/message_templates` endpoint. We keep the shape close to wire
 * format so the UI preview and the send-time parameter builder share a single
 * source of truth.
 */
export interface TemplateComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
  text?: string;
  example?: {
    header_text?: string[];
    body_text?: string[][];
    header_handle?: string[];
  };
  buttons?: Array<{
    type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE";
    text: string;
    url?: string;
    phone_number?: string;
    example?: string[];
  }>;
}

/**
 * Snapshot of a template the provider knows about. `bodyText` is denormalized
 * for cheap previews; `components` is the canonical source used at send time
 * to derive the parameter shape.
 */
export interface ProviderTemplate {
  externalId?: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: TemplateStatus;
  bodyText: string;
  components: TemplateComponent[];
}

/**
 * One parameter substitution for a template send. The provider builds the
 * wire payload from this — for Meta that means a `parameters` array of
 * `{ type: "text", text: <value> }` entries.
 *
 * Header parameters are positional too — Meta requires header values in their
 * own `header` component entry, separate from body. Buttons with URL/COPY_CODE/
 * quick-reply substitutions have their own component entries — see
 * `TemplateVariableSet.buttons`.
 */
/**
 * Media supplied for an IMAGE/VIDEO/DOCUMENT template header at SEND time.
 * Distinct from the `example.header_handle` used at template CREATE time —
 * that handle is only valid for the create call. For a send, Meta wants the
 * actual media for THIS message, by `link` (a URL Meta fetches) or a
 * pre-uploaded media `id`. For our own media the composer produces a stable R2
 * object URL that the send path presigns fresh (Meta needs a fetchable URL).
 */
export interface TemplateHeaderMedia {
  kind: "image" | "video" | "document";
  /**
   * URL to the media Meta will fetch. For our own media this is a stable R2
   * object URL, presigned fresh at send time (send-template-internal.ts);
   * external callers may pass any public URL.
   */
  link: string;
  /** Filename shown to the recipient — DOCUMENT headers only. */
  filename?: string;
}

/**
 * A dynamic button parameter for a template send. Meta needs a `button`
 * component entry (with `sub_type` + `index`) ONLY for buttons whose value is
 * templated — a URL button with a `{{1}}` suffix, a copy-code/coupon button, or
 * a quick-reply whose payload is set at send time. Static buttons (a fixed URL,
 * a phone number) carry no parameter and are omitted.
 *
 *   - `url`         → `{ type: "text", text }`         (the dynamic URL suffix)
 *   - `copy_code`   → `{ type: "coupon_code", coupon_code: text }`
 *   - `quick_reply` → `{ type: "payload", payload: text }`
 */
export interface TemplateButtonParam {
  /** 0-based position of the button in the template's BUTTONS component. */
  index: number;
  subType: "url" | "copy_code" | "quick_reply";
  /** The dynamic value (URL suffix / coupon code / payload). */
  text: string;
}

export interface TemplateVariableSet {
  /** Body `{{1}}, {{2}}, …` values in order. Empty array when body has no vars. */
  body: string[];
  /**
   * Named body parameters, for templates created with `parameter_format: NAMED`
   * (`{{order_id}}` instead of `{{1}}`). When present, the provider sends the
   * body params as `{ type: "text", parameter_name, text }` and IGNORES the
   * positional `body` array. Absent for the common positional case.
   */
  bodyNamed?: Array<{ name: string; text: string }>;
  /** Header `{{1}}` value when the header is TEXT with a placeholder. */
  header?: string;
  /**
   * Named header parameter, for NAMED-format templates whose HEADER is
   * `{{customer_name}}` rather than `{{1}}`. When present the provider sends the
   * header param as `{ type: "text", parameter_name, text }` (Meta requires
   * `parameter_name` on every component of a NAMED template); the derived name
   * comes from the template definition, so the caller still only supplies the
   * value via `header`. Absent for positional headers.
   */
  headerNamed?: { name: string; text: string };
  /** Media for an IMAGE/VIDEO/DOCUMENT header. Required when the template's
   *  HEADER component format is one of those; ignored for TEXT headers. */
  headerMedia?: TemplateHeaderMedia;
  /**
   * Dynamic button parameters. Empty/absent for templates with only static
   * buttons (or none) — the common case. See `TemplateButtonParam`.
   */
  buttons?: TemplateButtonParam[];
}

export interface SendTemplateArgs {
  to: string;
  name: string;
  language: string;
  variables: TemplateVariableSet;
}

// ---------------------------------------------------------------------------
// Template creation (POST to Meta's /message_templates).
//
// We send Meta's full component tree — same shape we cache on read. The
// provider doesn't validate semantics (Meta does, and rejects with detailed
// errors); it only assembles the wire payload. Media headers reference an
// `example.header_handle` returned by the resumable upload endpoint.
// ---------------------------------------------------------------------------

export interface CreateTemplateArgs {
  name: string;
  language: string;
  category: TemplateCategory;
  components: TemplateComponent[];
}

export interface CreateTemplateResult {
  /** Meta's template id (string of digits). */
  externalId: string;
  /** Initial review state — almost always `pending`. */
  status: TemplateStatus;
}

export interface DeleteTemplateArgs {
  name: string;
  /** Meta's id, optional but recommended — deletes a single language variant
   *  when set, otherwise deletes every language under `name`. */
  externalId?: string;
}

/**
 * One step of Meta's resumable upload flow for media template headers. The
 * caller does both legs: create the upload session, then PUT the bytes. We
 * model only the result the second leg returns — a `header_handle` that gets
 * embedded in `example.header_handle` on a HEADER component.
 */
export interface UploadHeaderMediaArgs {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface UploadHeaderMediaResult {
  /** Opaque handle to embed in TemplateComponent.example.header_handle. */
  headerHandle: string;
}

/**
 * Per-team config the provider needs at send/read time. Generic so each
 * provider declares its own shape; today only Meta exists. The ingest /
 * webhook routes load this from the Team row via lib/providers/config.ts.
 */
/**
 * Declarative per-provider feature flags. Lets channel-agnostic code branch
 * on capabilities without instanceof checks against MetaProvider.
 *
 *   freeFormWindowMs   Time window (ms) inside which free-form outbound is
 *                      allowed. Outside it, only templated sends work.
 *                      Meta WhatsApp: 24h. Instagram (when added): different.
 *                      Telegram, SMS, etc.: null (no such constraint).
 *   templates          True if the provider has a server-side approved-
 *                      template catalog. Drives whether the template picker
 *                      renders at all.
 *   readReceipts       True if `markIncomingRead` does anything observable
 *                      to the customer (blue ticks etc.). Drives whether
 *                      we bother calling it.
 *   typingIndicators   True if `sendTypingIndicator` propagates to the
 *                      customer's device.
 */
export interface ProviderCapabilities {
  freeFormWindowMs: number | null;
  /**
   * Maximum characters in a single outbound text body. Meta enforces different
   * limits per channel (WhatsApp 4096, Messenger 2000, Instagram 1000) and
   * rejects an over-limit send with an opaque error — so the send path validates
   * against this first, and the composer can render a live counter. Channels
   * with no documented limit use a generous default.
   */
  messageTextMaxChars: number;
  /**
   * True when the channel's text limit is counted in UTF-8 BYTES, not UTF-16
   * chars. Instagram's 1000 limit is BYTES — so ~600 Arabic characters (or ~300
   * emoji) fit `messageTextMaxChars` by JS `.length` yet exceed 1000 bytes and
   * Meta rejects the send. When set, the length gate measures bytes instead.
   */
  textLimitIsBytes?: boolean;
  /**
   * Extended outbound window (ms) for channels that allow agent replies past
   * the standard free-form window under a support-only policy. Meta social
   * (Messenger/Instagram) permit sends up to 7 days since the last inbound via
   * the Human Agent tag — attached automatically by the provider when a send
   * lands in the `freeFormWindowMs..humanAgentWindowMs` band. `null` when the
   * channel has no such extension (WhatsApp: only templates reopen a closed
   * window, so `null`).
   */
  humanAgentWindowMs?: number | null;
  templates: boolean;
  readReceipts: boolean;
  /**
   * The channel emits a DELIVERY receipt (message reached the device), distinct
   * from the read/seen receipt. WhatsApp + Messenger do; INSTAGRAM does NOT —
   * Meta's `message_deliveries` webhook is Messenger-only, and even the native
   * IG app shows only Sent → Seen. Absent = true. When false, the UI has no
   * "delivered" tick to wait for, so a successfully-sent message renders as
   * delivered (two ticks) immediately instead of a lone "sent" tick that looks
   * stuck until the customer reads it.
   */
  deliveryReceipts?: boolean;
  typingIndicators: boolean;
  /**
   * Interactive replies (quick-reply buttons / list). True if the provider
   * implements `sendInteractive`. Gates the composer's "buttons" / "list"
   * affordances — WhatsApp has them; the Meta social channels don't (yet), so
   * the button is hidden on their threads instead of erroring on send.
   */
  interactive: boolean;
  /**
   * Outbound location share (`type:"location"`). Gates the composer's "Send
   * location" affordance at the channel level (WhatsApp today). Optional —
   * absent = false.
   */
  sendLocation?: boolean;
  /**
   * Outbound contact share (`type:"contacts"` vCard). Gates the composer's
   * "Send contact" affordance. Optional — absent = false.
   */
  sendContacts?: boolean;
  /**
   * Outbound emoji reaction to a customer message. Gates the bubble's "react"
   * affordance. Optional — absent = false.
   */
  sendReaction?: boolean;
  /**
   * Voice calling. True if the provider implements placeCall / acceptCall /
   * etc. Gates the inbox "Call" button at the channel level — a future
   * SMS provider with calling=false hides the button on its threads.
   */
  calling: boolean;
  /**
   * Outbound media is sent by public URL (`attachment.payload.url`) instead of
   * uploading bytes for a reusable `attachment_id`. Instagram requires this;
   * the send orchestration presigns the stored object and passes `mediaUrl`
   * instead of calling `uploadMedia`. Absent/false → upload-then-send (WhatsApp,
   * Messenger).
   */
  mediaSendByUrl?: boolean;
  /**
   * The channel exposes a fetchable contact PROFILE (display name / picture, and
   * for Instagram follower/verified/follow signals) that we can Sync on demand —
   * i.e. the provider implements `fetchContactProfile`. Drives the contact
   * panel's "Refresh profile" affordance. Meta social (Messenger/Instagram) only;
   * WhatsApp carries the name inline and has no richer profile to pull.
   */
  profileSync?: boolean;
  /**
   * The channel supports one-tap consent chips that let the contact share their
   * phone / email (`SendInteractiveArgs.contactShare`). Messenger + Instagram
   * only: Meta exposes `content_type: "user_phone_number" | "user_email"` quick
   * replies there. WhatsApp has no equivalent — it already knows the phone, and
   * its interactive types (buttons / list / CTA-url / flows) have no such chip.
   */
  contactShareChips?: boolean;
}

export interface MessagingProvider<SendConfig = unknown> {
  name: Channel;
  /** Feature flags channel-agnostic code branches on. */
  capabilities: ProviderCapabilities;
  /**
   * Pure parser: webhook JSON → normalized events. Throws on malformed input;
   * the route handler decides whether to 200 or 4xx based on the throw.
   * Auth/signature verification is the route's responsibility, not the parser's.
   */
  parseWebhook(payload: unknown): NormalizedEvent[];
  /** Outbound text. */
  sendText(args: SendTextArgs, config: SendConfig): Promise<SendTextResult>;
  /**
   * Best-effort display name for an external contact id. Optional — only the
   * social channels (Messenger / Instagram) need it, because their inbound
   * webhooks carry no profile name (unlike WhatsApp's `contacts[].profile.name`).
   * Ingest calls it opportunistically to replace the id-as-name fallback; it
   * must fail soft (return `{ name: null }`), never throw.
   */
  fetchContactProfile?(
    externalId: string,
    config: SendConfig,
  ): Promise<{
    name: string | null;
    /** Provider-supplied name split (Messenger `first_name`/`last_name`). When
     *  present ingest uses it verbatim instead of guessing a split point. */
    firstName?: string | null;
    lastName?: string | null;
    /** Instagram public @username, when the profile exposes one. */
    username?: string | null;
    /** Profile picture URL (Meta CDN), when available. Best-effort avatar. */
    avatarUrl?: string | null;
    /** Instagram richer profile signals (follower count / verified / follow
     *  relationship); absent on Messenger. Ingest persists it on the contact. */
    socialProfile?: SocialProfile | null;
  }>;
  /**
   * Outbound interactive question (buttons / list). Optional — providers
   * without interactive support fall back to plain text (the caller decides
   * how to degrade). Same 24h-window rule applies as plain text sends.
   */
  sendInteractive?(args: SendInteractiveArgs, config: SendConfig): Promise<SendTextResult>;
  /** Outbound location share (map pin). Optional — providers without it are
   *  gated at the send path with an actionable error. */
  sendLocation?(args: SendLocationArgs, config: SendConfig): Promise<SendTextResult>;
  /** Outbound contact share (vCard). Optional — see sendLocation. */
  sendContacts?(args: SendContactsArgs, config: SendConfig): Promise<SendTextResult>;
  /** Outbound emoji reaction to a customer message. Empty emoji un-reacts. */
  sendReaction?(args: SendReactionArgs, config: SendConfig): Promise<SendTextResult>;
  /** Outbound media — caller uploads first, then sends with the returned id. */
  uploadMedia?(args: UploadMediaArgs, config: SendConfig): Promise<UploadMediaResult>;
  sendMedia?(args: SendMediaArgs, config: SendConfig): Promise<SendTextResult>;
  /**
   * Outbound template — the only legal send shape outside the 24h customer-
   * service window. Caller is responsible for picking a template the team
   * actually has approved on its WABA; provider only validates wire format.
   */
  sendTemplate?(args: SendTemplateArgs, config: SendConfig): Promise<SendTextResult>;
  /**
   * Pull the team's approved templates from the provider. Used to refresh
   * the local cache the picker reads. Optional — providers without a
   * template catalog (or that don't expose one) leave this off.
   */
  fetchTemplates?(config: SendConfig): Promise<ProviderTemplate[]>;
  /**
   * Submit a new template for review. Returns the provider id + the initial
   * review status (almost always "pending"). Approval is async and surfaces
   * via a later `fetchTemplates` sync.
   */
  createTemplate?(args: CreateTemplateArgs, config: SendConfig): Promise<CreateTemplateResult>;
  /** Remove a template from the provider catalog. */
  deleteTemplate?(args: DeleteTemplateArgs, config: SendConfig): Promise<void>;
  /**
   * Upload a media file (image/video/document) for use as a template header.
   * Returns an opaque handle to embed in `example.header_handle`. Distinct
   * from `uploadMedia` (which produces a per-message media id) — Meta uses a
   * separate resumable upload endpoint scoped to the app id for templates.
   */
  uploadHeaderMedia?(args: UploadHeaderMediaArgs, config: SendConfig): Promise<UploadHeaderMediaResult>;
  /**
   * Inbound media: download a file by provider-side id.
   *
   * `maxBytes` (optional): a pre-buffer ceiling. The impl SHOULD reject via the
   * response Content-Length BEFORE reading the whole binary into heap, so an
   * over-cap download doesn't transiently spike RAM (minor#3) — a 4-wide inbound
   * batch each buffering ~100MB could otherwise momentarily hold ~400MB. The
   * caller still enforces the authoritative per-kind cap on the returned bytes
   * (a CDN may omit or understate Content-Length).
   */
  fetchMedia?(
    externalMediaId: string,
    config: SendConfig,
    maxBytes?: number,
  ): Promise<FetchedMedia>;
  /**
   * Acknowledge an inbound message as read on the provider so the customer
   * sees blue ticks. Optional — providers that don't support read receipts
   * (or don't expose them via API) leave this off. Best-effort: a failure
   * here must not break the agent's view, so callers should swallow errors.
   *
   * `recipientId` is the customer's opaque per-account id (PSID / IGSID) — the
   * social channels mark the whole THREAD seen by recipient (`sender_action:
   * mark_seen`) rather than a specific message, so they use `recipientId` and
   * ignore `externalId`. WhatsApp marks the specific `externalId` and ignores
   * `recipientId`. Callers pass both.
   */
  markIncomingRead?(
    externalId: string,
    config: SendConfig,
    recipientId?: string,
  ): Promise<void>;
  /**
   * Show the customer a "typing…" bubble on their device. WhatsApp anchors it
   * to a recent inbound message id (the indicator rides along with marking the
   * inbound read); the social channels send `sender_action: typing_on` to the
   * `recipientId` (PSID / IGSID). Auto-dismisses provider-side after a short
   * window (~25s) or when an outbound is sent.
   *
   * Best-effort like markIncomingRead — callers swallow errors so a provider
   * hiccup doesn't degrade the local typing UX.
   *
   * `active` (default true) sends `typing_on`; `false` sends `typing_off` to
   * clear the bubble immediately on the channels that support it (Messenger /
   * Instagram). WhatsApp has no `typing_off` (the indicator only auto-expires),
   * so its provider no-ops on `active:false`.
   */
  sendTypingIndicator?(
    externalId: string,
    config: SendConfig,
    recipientId?: string,
    active?: boolean,
  ): Promise<void>;

  // ---- WhatsApp Business Calling ---------------------------------------
  // All optional so future SMS-only providers can leave them off;
  // ProviderCapabilities.calling gates them at the channel level. The
  // browser is the WebRTC peer — the API only relays SDP between Meta
  // and the browser (Meta uses ICE-lite, so trickle is unnecessary).

  /**
   * Request a customer's permission to be called. Required before placeCall
   * outside the 24h customer-service window. Meta rate-limits these:
   * 1 / 24h / contact and 2 / 7d / contact, 72h validity once granted, and
   * auto-revokes after 4 consecutive unanswered calls. The caller
   * (CallsService) keeps a CallPermissionRequest row that mirrors this.
   *
   * Returns the provider's request id (for audit) and the absolute
   * expiresAt the caller computed (Meta confirms 72h validity but doesn't
   * echo a precise timestamp — we trust our `requestedAt + 72h` calc).
   */
  sendCallPermissionRequest?(
    args: { to: string },
    config: SendConfig,
  ): Promise<{ permissionRequestId: string; expiresAt: Date }>;

  /**
   * Initiate an outbound call. The BROWSER generates an SDP offer first
   * (via `RTCPeerConnection.createOffer`) and we forward it to Meta in the
   * connect-action payload. Meta returns a call_id immediately; the
   * customer's phone starts ringing. When the customer answers, Meta sends
   * a webhook with the SDP ANSWER, which the browser feeds into
   * `setRemoteDescription` to complete the WebRTC handshake.
   *
   * This is the SHAPE FIX for Meta error 131009 "Missing session parameter"
   * — the original placeCall { to } payload omitted the session.sdp field
   * Meta requires for business-initiated calling.
   */
  placeCall?(
    args: { to: string; sdpOffer: string; from?: string },
    config: SendConfig,
  ): Promise<{ externalCallId: string }>;

  /**
   * REQUIRED preamble before acceptCall. Meta rejects `accept` sent without
   * a prior `pre_accept` for the same call id. Both calls carry the SAME
   * SDP answer (verified — pre_accept without session.sdp returns
   * 131009 "Missing session parameter"). The two hops exist for media
   * timing, not for separate payloads.
   */
  preAcceptCall?(
    args: { externalCallId: string; sdpAnswer: string },
    config: SendConfig,
  ): Promise<void>;

  /**
   * Accept an incoming call by delivering our SDP answer (already generated
   * by the browser's RTCPeerConnection.createAnswer). After this, media
   * flows DTLS+SRTP browser ↔ Meta.
   */
  acceptCall?(
    args: { externalCallId: string; sdpAnswer: string },
    config: SendConfig,
  ): Promise<void>;

  /** Decline an incoming call before any answer. */
  rejectCall?(
    args: { externalCallId: string; reason?: "busy" | "declined" },
    config: SendConfig,
  ): Promise<void>;

  /** Hang up an in-progress call from our side. Idempotent — re-calling
   *  on an already-terminated call is a no-op (Meta returns the same
   *  success shape). */
  endCall?(
    args: { externalCallId: string },
    config: SendConfig,
  ): Promise<void>;

  /**
   * Admin helper: enable Calling on the provider's phone number via the
   * settings endpoint. Required ONCE per number before placeCall works
   * (else Meta returns 138000 "Calling API not enabled"). Distinct from
   * the "Display call buttons" toggle in WhatsApp Manager (UI-only).
   * Idempotent on the provider side.
   */
  enableCalling?(config: SendConfig): Promise<{ ok: true; raw: unknown }>;

  /**
   * Admin helper: GET the provider's stored phone-number settings.
   * Diagnostic — lets ops see what calling fields are actually set on
   * the provider side (status, call_icon_visibility, call_hours, etc.)
   * to debug why inbound calls aren't arriving at the webhook.
   */
  getPhoneNumberSettings?(config: SendConfig): Promise<{ raw: unknown }>;

  // ---- Meta social calling (Messenger) --------------------------------
  // Unified `POST /{page-id}/calls` action model — see CallActionArgs. A
  // provider implements EITHER the WhatsApp calling methods above OR these,
  // never both; CallsService dispatches on which the channel's provider
  // supports. All optional + gated by ProviderCapabilities.calling.

  /** Perform a call action (connect/accept/reject/terminate/media_update). */
  callAction?(args: CallActionArgs, config: SendConfig): Promise<CallActionResult>;

  /** Query a consumer's outbound-call permission + rate-limit state. */
  checkCallPermission?(psid: string, config: SendConfig): Promise<SocialCallPermission>;

  /** Send a permission opt-in request (`calling_optin` template). */
  requestCallPermission?(psid: string, config: SendConfig): Promise<{ messageId: string }>;

  /** True when the Page has the Messenger Calling feature enabled. */
  callFeatureEnabled?(config: SendConfig): Promise<boolean>;
}
