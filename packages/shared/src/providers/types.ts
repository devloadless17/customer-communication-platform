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
 * lookup; externalContactId → the `(workspaceId, identityChannel, externalContactId)`
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
 * (workspaceId, channel, externalCallId) the same way it does for messages,
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
                      // `ringing` until `answered` lands.
    | "answered"      // the customer actually PICKED UP an outbound call.
                      // Provider-reported and authoritative (WhatsApp: the
                      // `ACCEPTED` call status). Do not infer this from media
                      // flow — a browser hearing audio may just be ringback.
    | "completed"     // call connected then ended (carries connectedAt+duration)
    | "missed"        // never answered (declined / no-answer / timeout)
    | "rejected"      // explicitly declined (providers that distinguish it)
    | "failed"        // signaling/media error
    | "permission_granted"
    | "permission_revoked";
  /**
   * Set on `permission_granted` when the customer granted PERMANENTLY rather
   * than for a bounded window. A permanent grant never expires, so ingest must
   * record it as such instead of stamping some far-future date that later reads
   * as "expires in 99 years" in the UI.
   */
  permanentPermission?: boolean;
  /**
   * The provider's own expiry for a temporary grant, taken verbatim from the
   * permission webhook. Authoritative — never recompute it locally. WhatsApp
   * sends NO webhook when a temporary permission lapses, so this timestamp (or
   * a fresh permission read) is the only way to know the grant is still live.
   */
  permissionExpiresAt?: Date;
  /**
   * The id of the permission-request message this reply answers, when the
   * customer responded to one. Absent when they granted proactively from the
   * business profile, or when the grant was automatic. Lets ingest correlate a
   * grant to the exact request rather than guessing at the newest pending row.
   */
  permissionRequestExternalId?: string;
  /**
   * True when the provider generated this permission change itself rather than
   * the customer acting — an automatic grant because the customer called us, or
   * an automatic REVOCATION after too many unanswered calls. Worth
   * distinguishing in the audit trail: "they withdrew consent" and "we burned
   * through their patience" are different problems.
   */
  permissionAutomatic?: boolean;
  /**
   * Provider error detail on a `failed` terminal event. Without this, every
   * failure — no permission, unreachable, bad SDP, calling disabled, outside
   * call hours — collapses into one indistinguishable "provider error" and
   * nobody can diagnose a broken call without reading raw webhook JSON.
   */
  errorCode?: number;
  errorTitle?: string;
  errorDetail?: string;
  /**
   * Opaque attribution strings the provider echoes back, identifying what drove
   * a user-initiated call: `ctaPayload` from a call button we sent,
   * `deeplinkPayload` from a `wa.me/call/...` link. Absent on older clients, so
   * treat absence as normal rather than as an error.
   */
  ctaPayload?: string;
  deeplinkPayload?: string;
  /**
   * Our own correlation id, echoed back by the provider on every webhook for a
   * call we placed. Lets ingest find our row directly instead of racing the
   * provider-assigned id back from the originating request.
   */
  correlationId?: string;
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
 * One day's calling window on the business number. Times are local to
 * `timezoneId` and expressed as 24h "HHMM" (e.g. "0900", "1730").
 */
export interface CallHoursWindow {
  dayOfWeek:
    | "MONDAY"
    | "TUESDAY"
    | "WEDNESDAY"
    | "THURSDAY"
    | "FRIDAY"
    | "SATURDAY"
    | "SUNDAY";
  openTime: string;
  closeTime: string;
}

/**
 * Calling configuration on a business phone number.
 *
 * Every field is optional: this is a PATCH, and sending only what changed
 * avoids clobbering settings an admin adjusted in the provider's own console.
 */
export interface CallSettings {
  /** Master switch. Disabling it hides calling from customers entirely. */
  enabled?: boolean;
  /**
   * Whether customers see a call icon on the business profile. `DISABLE_ALL`
   * hides it everywhere — the documented remedy when a number is flagged for a
   * low call-pickup rate.
   */
  callIconVisible?: boolean;
  /**
   * When true, a customer calling US automatically grants permission for us to
   * call THEM back. Worth leaving on: it's a free, consent-respecting source of
   * calling permission that needs no request message.
   */
  callbackPermissionEnabled?: boolean;
  /**
   * Business calling hours. Omit `windows` (or pass an empty array) to be
   * reachable 24/7 — which is expressed to the provider as call hours DISABLED,
   * not as a 00:00-23:59 window. That distinction matters: a "0000"-"2359"
   * window leaves a one-minute dead zone every night during which calls are
   * refused, and hours are minute-granular so it cannot be closed by widening.
   */
  hours?: {
    timezoneId: string;
    windows: CallHoursWindow[];
  };
}

/**
 * A restriction the provider has placed on this number's calling, with the
 * time it lifts. Surfaced so a paused tenant sees why their calls are failing
 * instead of a string of unexplained rejections.
 */
export interface CallRestriction {
  type: string;
  reason: string;
  expiresAt: Date | null;
}

/** Current calling configuration + health, read back from the provider. */
export interface CallSettingsState {
  enabled: boolean;
  callIconVisible: boolean;
  callbackPermissionEnabled: boolean;
  hours: { timezoneId: string; windows: CallHoursWindow[] } | null;
  restrictions: CallRestriction[];
  /** Unparsed provider response, for ops diagnosis. */
  raw: unknown;
}

/**
 * A phone channel's authoritative call-permission state, read straight from the
 * provider rather than inferred from a local ledger.
 *
 * This exists because permission can be granted through paths that leave NO
 * trace on our side: WhatsApp's `callback_permission_status` grants it
 * automatically when the customer calls us, and the customer can grant it from
 * the business profile at any time. A local request ledger therefore cannot be
 * the gate — it will refuse perfectly callable contacts. The provider is the
 * only source of truth, and it also returns the live quota, so the caller never
 * has to hardcode a limit that Meta has since changed.
 *
 * Distinct from SocialCallPermission (Messenger's `messenger_call_permissions`)
 * on purpose: different vendor API, different shape. The domain layer already
 * branches on which calling model a channel uses.
 */
export interface CallPermissionState {
  /** `permanent` never expires; `temporary` carries an expiry. */
  status: "no_permission" | "temporary" | "permanent";
  /** True for `temporary` or `permanent`. */
  hasPermission: boolean;
  /** The provider's own verdict, with every limit already applied. */
  canStartCall: boolean;
  /** False when a permission request would exceed the provider's request cap. */
  canRequestPermission: boolean;
  /** Null when permanent (no expiry) or when there is no permission at all. */
  expiresAt: Date | null;
  /** When `canStartCall` is false because a quota is exhausted, when it resets. */
  startCallResetAt: Date | null;
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
   * New quality band (`GREEN` | `YELLOW` | `RED` | `UNKNOWN`), set ONLY by the
   * `message_template_quality_update` webhook. Verbatim from Meta — quality
   * vocabulary churns and this is informational, never a sendability decision.
   *
   * It IS the early warning, though: quality drives Meta's template pacing and
   * pausing, so a RED band is a template about to stop sending. The `PAUSED`
   * status that follows arrives too late for an operator to act on.
   */
  qualityScore?: string;
  /**
   * New category, already mapped to our enum — set ONLY by the
   * `template_category_update` webhook (Meta auto-migrates a template's category,
   * e.g. MARKETING→UTILITY, which changes its pricing + which window reopens it).
   * Absent on status/quality updates. Ingest updates the local row's category
   * when present.
   */
  category?: TemplateCategory;
  /**
   * The category Meta says this template SHOULD be, announced in ADVANCE of the
   * move (Meta's `correct_category`). This is notice, not state — the template
   * is still billed and rendered as `category` until the move lands, typically on
   * the first of the following month.
   *
   * Kept strictly apart from `category` because conflating them is a real
   * mispricing bug: applying `correct_category` on the notice webhook relabels a
   * UTILITY template as MARKETING up to a month before Meta actually charges
   * marketing rates for it.
   */
  pendingCategory?: TemplateCategory;
  /** Provider's human reason for the change (Meta `reason`), if any. */
  reason?: string;
  rawPayload: Record<string, unknown>;
}

/**
 * A template's COMPONENTS changed at the provider (Meta's
 * `message_template_components_update`).
 *
 * Carries identity only, deliberately: the cached `components` array decides the
 * entire send-time parameter shape, and a webhook payload isn't a safe basis for
 * rebuilding it. Ingest responds by refetching the catalog, which is the one
 * path that produces a complete, authoritative row.
 *
 * Without this, an edit made in WhatsApp Manager left us building the OLD
 * parameter shape — wrong body-variable count, a header we still think is text —
 * and Meta rejected every send with error 132000 until someone happened to press
 * "Sync".
 */
export interface NormalizedTemplateComponentsChanged {
  kind: "template_components_changed";
  externalId?: string;
  name?: string;
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
  /**
   * The provider has PAUSED calling on this number (typically for a week) over
   * negative user feedback or a low call-pickup rate. While restricted, every
   * call attempt AND every permission request fails.
   *
   * Worth storing rather than discovering per-attempt: without it a tenant sees
   * only a week of unexplained rejections, and support has no way to tell a
   * restriction apart from a bug. `null` explicitly CLEARS a stored restriction
   * (the provider lifted it); `undefined` leaves it untouched, since this event
   * carries partial state.
   */
  callingRestrictedUntil?: Date | null;
  /** Machine-readable restriction type, when restricted. */
  callingRestrictionType?: string | null;
  /** Provider's human explanation, shown to the admin verbatim. */
  callingRestrictionReason?: string | null;
  /**
   * An early WARNING that calling quality is trending badly — delivered before
   * any restriction takes effect. Actionable: this is the moment to hide call
   * buttons or narrow call hours, which is a change we can offer in one click.
   */
  callingQualityWarning?: string | null;
  /**
   * A WhatsApp Business POLICY violation type (e.g. "ALCOHOL") from
   * `account_update`. Distinct from `callingQualityWarning`, which is the same
   * webhook narrowed to CALLING violations. An account restriction follows if
   * it isn't addressed, so this is the warning that arrives FIRST.
   */
  policyViolationType?: string | null;
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
  | NormalizedTemplateComponentsChanged
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
  /**
   * True when the provider ACCEPTED the send but is holding the message for a
   * quality assessment rather than delivering it (WhatsApp business-portfolio
   * pacing: `message_status: "held_for_quality_assessment"`).
   *
   * The message has a real id and may still be delivered in a later batch — or
   * dropped outright, which arrives as a `failed` status with code 135000.
   * Callers that report on delivery must not count a held message as sent.
   */
  heldForQualityAssessment?: boolean;
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
  /**
   * `voice_call` renders a button that starts a WhatsApp call to us when
   * tapped — a way to invite a customer to call rather than waiting for
   * permission to call them. It carries no `options`.
   */
  kind: "buttons" | "list" | "voice_call";
  /** Ignored for `voice_call`. */
  options: InteractiveOption[];
  /**
   * `voice_call` only. Every field is optional; the provider's defaults are
   * sensible ("Call Now", 7 days).
   */
  voiceCall?: {
    /** Button label, max 20 chars. */
    displayText?: string;
    /** How long the button stays tappable, 1 to 43200 minutes (30 days). */
    ttlMinutes?: number;
    /**
     * Opaque attribution string echoed back on the call webhooks as
     * `cta_payload`, so an inbound call can be traced to the button that
     * produced it. Max 512 chars. Older WhatsApp clients drop it, so treat its
     * absence as normal.
     */
    payload?: string;
  };
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
  /**
   * Provider-side media id, valid for ~30 days.
   *
   * Reusability across messages is unverified — see the note in
   * `metaProvider.uploadMedia`. Callers upload one id per message today.
   */
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
  | "disabled"
  /**
   * Auto-archived after 12 months of inactivity. Not sendable — but unlike
   * `disabled` it is RECOVERABLE, and only for 28 days, after which Meta
   * deletes it permanently. Its own value precisely so that clock is visible.
   */
  | "archived";
export type TemplateCategory = "marketing" | "utility" | "authentication";

/**
 * One component of a template definition as returned by Meta's
 * `/{waba-id}/message_templates` endpoint. We keep the shape close to wire
 * format so the UI preview and the send-time parameter builder share a single
 * source of truth.
 */
export interface TemplateComponent {
  /**
   * `CALL_PERMISSION_REQUEST` is a parameterless component that turns the
   * template into a request for permission to CALL the recipient. It is the only
   * way to ask outside the 24-hour window (the interactive
   * `call_permission_request` message we already send requires an open window).
   * Meta allows it on MARKETING and UTILITY only, and it cannot be combined with
   * any other interactive component.
   */
  type:
    | "HEADER"
    | "BODY"
    | "FOOTER"
    | "BUTTONS"
    | "CALL_PERMISSION_REQUEST"
    /**
     * A countdown offer. Declared at create time with its heading text and
     * whether to show expiry; the actual expiry INSTANT is supplied per send.
     * Marketing only, and the template may not carry a footer.
     */
    | "LIMITED_TIME_OFFER"
    /**
     * Up to 10 horizontally-scrollable media cards under one body. Marketing
     * only. The CARD COUNT is fixed at creation — an approved template can only
     * ever send exactly the number of cards it was approved with.
     */
    | "CAROUSEL";
  // GIF is accepted by Meta only through the Marketing Messages API, so it is
  // listed for parse-tolerance (a synced template may carry it) but the
  // composer never authors one.
  format?: "TEXT" | "IMAGE" | "VIDEO" | "GIF" | "DOCUMENT" | "LOCATION";
  text?: string;
  example?: {
    header_text?: string[];
    body_text?: string[][];
    header_handle?: string[];
    // NAMED-format templates (`parameter_format: NAMED`) carry their examples
    // keyed by placeholder name instead of position. Meta returns these on
    // `GET /{waba-id}/message_templates`, so the send-time UI can hint each
    // field the same way it does for positional templates.
    body_text_named_params?: Array<{ param_name: string; example: string }>;
    header_text_named_params?: Array<{ param_name: string; example: string }>;
  };
  buttons?: Array<TemplateButton>;
  /**
   * Present on a `CAROUSEL` component. Every card must carry the SAME set of
   * components as every other — Meta renders them at one uniform height.
   */
  cards?: Array<TemplateCard>;
  /** Present on a `LIMITED_TIME_OFFER` component. */
  limited_time_offer?: {
    /** Heading shown above the countdown. Max 16 characters. */
    text?: string;
    /** Show the expiry countdown in the delivered message. */
    has_expiration?: boolean;
  };
}

/** Send-time values for one carousel card. */
export interface TemplateCardVariables {
  /**
   * The card's image/video. Meta's send example uses an uploaded media `id`;
   * a public `link` works the same way as it does for a normal media header.
   * Exactly one of the two.
   */
  headerMedia: {
    kind: "image" | "video";
    link?: string;
    id?: string;
  };
  /** Values for the card body's `{{1}}…{{n}}`, in order. */
  body?: string[];
  /** Values for the card's dynamic buttons, indexed WITHIN the card. */
  buttons?: Array<{
    index: number;
    subType: "url" | "quick_reply" | "copy_code";
    text: string;
  }>;
}

/**
 * One card of a media-card carousel. A card is a mini-template: its own
 * image/video header, an optional body (≤160 chars), and up to two buttons.
 * It reuses `TemplateComponent` because that is literally what Meta nests here.
 */
export interface TemplateCard {
  components?: TemplateComponent[];
}

/**
 * One button inside a template's BUTTONS component, exactly as Meta defines it.
 *
 * `text` is OPTIONAL because not every button type has a label: a `COPY_CODE`
 * button is defined solely by its `example` string, and typing `text` as
 * required made every validator that read `b.text.length` lie about it.
 *
 * `example` is `string | string[]` for the same reason — Meta documents the URL
 * button's example as an ARRAY (`"example": ["summer2023"]`) and the copy-code
 * button's as a bare STRING (`"example": "250FF"`). Both shapes really occur on
 * the wire; normalize at the point of use, never by narrowing the type.
 */
export interface TemplateButton {
  type:
    | "QUICK_REPLY"
    | "URL"
    | "PHONE_NUMBER"
    | "COPY_CODE"
    | "VOICE_CALL"
    // Authentication-template one-tap autofill button, and the catalog buttons.
    // Parsed, never authored by our composer.
    | "OTP"
    | "MPM"
    | "SPM"
    | "CATALOG";
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string | string[];
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
  /**
   * `null` when Meta returned a category we don't map.
   *
   * NOT the same as "absent". The catalog sync treats a returned-but-unmappable
   * template as PRESENT (so its local row is preserved) while leaving the
   * unmappable field alone. Dropping the whole row instead — which is what
   * returning `null` from the normalizer used to do — fed the sync's
   * prune-what-Meta-didn't-return step and silently DELETED the template plus
   * the `variableBindings` we own and Meta cannot give back.
   */
  category: TemplateCategory | null;
  /** `null` when Meta returned a status we don't map. See `category`. */
  status: TemplateStatus | null;
  /**
   * Meta's `correct_category`: the category this template WILL be moved to on
   * the first of next month, when Meta has decided the author miscategorized it.
   * Null/absent means "not impacted"; equal to `category` means the move already
   * happened.
   *
   * Deliberately separate from `category` — it is advance notice, not state. The
   * pricing a broadcast quotes must follow `category` until Meta actually moves
   * it. See the `template_category_update` webhook, which carries the same
   * distinction as `correct_category` (notice) vs `new_category` (applied).
   */
  correctCategory?: TemplateCategory | null;
  /**
   * Meta's quality band for this template: `GREEN` | `YELLOW` | `RED` |
   * `UNKNOWN`. Passed through as Meta wrote it — an unrecognized band is stored
   * verbatim rather than dropped, because quality vocabulary churns and the
   * value is informational, never a sendability decision.
   *
   * Absent when Meta didn't return one (it is only present if asked for).
   */
  qualityScore?: string | null;
  /** When Meta last recomputed the band (`quality_score.date`). */
  qualityScoreAt?: Date | null;
  bodyText: string;
  components: TemplateComponent[];
  /**
   * Whether the template's placeholders are `{{1}}` (positional) or
   * `{{order_id}}` (named) — Meta's own `parameter_format`, not our inference.
   *
   * This is a WIRE-SHAPE decision, not cosmetics: a named template must send
   * `{ parameter_name, text }` objects and a positional one must send bare
   * `{ text }`. Guessing it from a regex over the body misreads a positional
   * template that happens to contain `{{order_id}}` as literal text, and every
   * recipient then fails with Meta error 132000.
   */
  parameterFormat: TemplateParameterFormat;
  /** Meta's `message_send_ttl_seconds`. Absent = the category's default. */
  messageSendTtlSeconds?: number;
}

/** Mirrors Meta's `parameter_format`. Defaults to positional — the historical
 *  shape every template synced before this field existed was authored under. */
export type TemplateParameterFormat = "positional" | "named";

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
   * URL to the media Meta will FETCH. For our own media this is a stable R2
   * object URL, presigned fresh at send time (send-template-internal.ts);
   * external callers may pass any public URL.
   *
   * Ignored when `id` is set. Meta accepts either, and prefers `id`: a link
   * means Meta reaches back into your server on every single send, which is
   * both slower and one more thing that can fail.
   */
  link?: string;
  /**
   * A provider-side media id from a prior upload, used INSTEAD of `link`.
   *
   * Meta's recommended form — "to reduce the likelihood of errors and avoid
   * unnecessary requests to your public server". Nothing is fetched from us at
   * send time; Meta already holds the bytes.
   */
  id?: string;
  /** Filename shown to the recipient — DOCUMENT headers only. */
  filename?: string;
}

/**
 * The pin supplied for a LOCATION template header at SEND time.
 *
 * Meta renders a generic map card; tapping it opens the recipient's map app.
 * All four fields ship as strings on the wire (`latitude`/`longitude` are
 * decimal degrees), and Meta only allows a LOCATION header on `UTILITY` and
 * `MARKETING` templates. Real-time locations are not supported.
 */
export interface TemplateHeaderLocation {
  latitude: string;
  longitude: string;
  /** Optional per Meta — the pin renders from coordinates alone. */
  name?: string;
  /** Optional per Meta. */
  address?: string;
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
   * Pin for a LOCATION header. Required when the template's HEADER format is
   * `LOCATION` — the component is declared with no parameters at CREATE time and
   * carries the whole pin at SEND time, which is why it needs its own slot here
   * rather than riding on `headerMedia`.
   */
  headerLocation?: TemplateHeaderLocation;
  /**
   * Dynamic button parameters. Empty/absent for templates with only static
   * buttons (or none) — the common case. See `TemplateButtonParam`.
   */
  buttons?: TemplateButtonParam[];
  /**
   * Tap-target override: makes an image-based, text-based or header-less
   * template behave as a call-to-action, showing `title` and opening `url`.
   *
   * SEND-time only — nothing about it is declared when the template is created,
   * which is why it lives here and not in `components`. Meta gates it on a fully
   * verified WABA with sustained high quality, so a workspace without that
   * simply gets a rejection; we surface it rather than pre-judging eligibility
   * we cannot see.
   */
  tapTarget?: { url: string; title: string };
  /**
   * When a limited-time offer expires, as a UNIX timestamp in **MILLISECONDS**.
   *
   * Milliseconds — note the contrast with `template_analytics` and `/compare`,
   * which both take SECONDS and silently return nothing when handed ms. Getting
   * it wrong here doesn't fail loudly either: the countdown simply renders
   * absurdly, so the unit is stated at every layer it passes through.
   */
  limitedTimeOfferExpiresAtMs?: number;
  /**
   * Per-card values for a media-card carousel, in card order. The array length
   * must equal the card count the template was APPROVED with — Meta fixes that
   * number at creation and rejects any other.
   *
   * Each card supplies its header media, its body values (if the cards carry a
   * body), and a value for each dynamic button — the same three kinds of
   * send-time value a top-level template takes, scoped to one card.
   */
  cards?: TemplateCardVariables[];
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
  /**
   * Meta's `parameter_format` — sent EXPLICITLY on every create rather than
   * left to the provider's default.
   *
   * Meta documents "if you do not specify a format, the template uses
   * positional format by default", so omitting it worked only by accident: the
   * template we authored and the template Meta stored agreed because both
   * happened to land on positional. Stating it means the row we persist and the
   * row Meta reviews can never disagree, and the day a named-authoring surface
   * exists it flips one field instead of relying on a vendor default.
   */
  parameterFormat: TemplateParameterFormat;
  /**
   * Meta's `message_send_ttl_seconds` — how long Meta keeps retrying delivery
   * before giving up on a message sent from this template.
   *
   * Omitted means "take Meta's default for the category". We never invent a
   * value: the defaults differ per category (authentication is minutes,
   * marketing/utility is days) and silently pinning one would change delivery
   * behaviour the author never asked for.
   */
  messageSendTtlSeconds?: number;
}

export interface CreateTemplateResult {
  /** Meta's template id (string of digits). */
  externalId: string;
  /** Initial review state — almost always `pending`. */
  status: TemplateStatus;
  /**
   * The category Meta ACTUALLY assigned, which is not necessarily the one we
   * asked for.
   *
   * Since 2025-04-09 the old `allow_category_change` behaviour is the default:
   * submit `UTILITY`, and if Meta's classifier says the content is promotional
   * it approves the template as `MARKETING` outright. Persisting the requested
   * category instead of this one left the local row claiming a cheaper category
   * than the one Meta bills, which is wrong in the picker, wrong in the
   * category filter, and wrong in every broadcast cost estimate.
   *
   * `null` when Meta's response omitted it — keep the requested value then.
   */
  category: TemplateCategory | null;
}

/**
 * Edit an EXISTING template in place.
 *
 * Meta's rules, all enforced by the caller because each one has a distinct
 * user-facing consequence:
 *   - only `APPROVED`, `REJECTED` or `PAUSED` templates can be edited;
 *   - only category, components and TTL are editable — not name or language;
 *   - **components are REPLACED wholesale**, never merged, so a partial payload
 *     silently deletes the components it omits;
 *   - the category of an APPROVED template cannot be changed;
 *   - approved templates allow 10 edits / 30 days and 1 / 24h; rejected and
 *     paused ones are unlimited.
 *
 * Editing exists for a reason worth stating: the alternative — delete and
 * recreate — blocks re-using that template NAME for 30 days if the template was
 * approved, so recommending it (as this app used to) strands the operator.
 */
export interface EditTemplateArgs {
  /** Meta's template id. */
  externalId: string;
  category?: TemplateCategory;
  /** Replaces ALL components. Omit to leave the content untouched. */
  components?: TemplateComponent[];
  messageSendTtlSeconds?: number;
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
// ---------------------------------------------------------------------------
// Template Library — Meta's catalogue of pre-written, pre-categorized utility
// and authentication templates.
//
// A library template is NOT a template you own. It is a blueprint: its copy is
// fixed and uneditable, and you instantiate it under your own name by naming it
// in a create call. The payoff is that an unmodified instantiation skips review
// and comes back APPROVED immediately — which is why this is worth having as a
// first-class path rather than telling people to retype the copy into the
// composer (where it WOULD go to review, and could be rejected).
// ---------------------------------------------------------------------------

/**
 * The value type a library template expects in one of its body parameters.
 *
 * These are enforced by Meta AT SEND TIME, not at creation: a value outside the
 * type's accepted range fails the individual message. That is why we keep them
 * on the row — it is the only way to tell an agent "that isn't a valid email"
 * before the send instead of after.
 */
export type TemplateParamType =
  | "ADDRESS"
  | "TEXT"
  | "AMOUNT"
  | "DATE"
  | "PHONE_NUMBER"
  | "EMAIL"
  | "NUMBER";

/** Filters accepted by the library browse endpoint. All optional. */
export interface TemplateLibraryFilters {
  /** Substring searched across name, header, body and footer. */
  search?: string;
  topic?: string;
  usecase?: string;
  industry?: string;
  language?: string;
  /** Exact library-template name. */
  name?: string;
}

/** One blueprint from Meta's library. */
export interface LibraryTemplate {
  /** The library name — what you pass as `library_template_name` to create. */
  name: string;
  language: string;
  category: TemplateCategory | null;
  topic?: string;
  usecase?: string;
  industry: string[];
  header?: string;
  body: string;
  footer?: string;
  /** Meta's own sample values, positionally aligned with the body's `{{n}}`. */
  bodyParams: string[];
  /** Value type per body parameter, positionally aligned. May be empty on
   *  templates Meta hasn't typed. */
  bodyParamTypes: TemplateParamType[];
  /**
   * The buttons the blueprint carries. `FLOW` marks a WhatsApp Flows form —
   * available only to accounts with raised messaging limits, so it is surfaced
   * rather than filtered out (a silently missing template is worse than a
   * labelled one that may not create).
   */
  buttons: Array<{
    type: string;
    text?: string;
    url?: string;
    phone_number?: string;
  }>;
  id?: string;
}

/**
 * Button values supplied when instantiating a library template.
 *
 * The blueprint fixes the button's TYPE and LABEL; what varies per business is
 * the destination — your URL, your phone number — which is what this carries.
 */
export interface LibraryTemplateButtonInput {
  type: string;
  phone_number?: string;
  url?: { base_url: string; url_suffix_example?: string };
  otp_type?: "COPY_CODE" | "ONE_TAP" | "ZERO_TAP";
  zero_tap_terms_accepted?: boolean;
  supported_apps?: Array<{ package_name: string; signature_hash: string }>;
}

/** Optional add-ons the blueprint supports (authentication + utility extras). */
export interface LibraryTemplateBodyInput {
  add_contact_number?: boolean;
  add_learn_more_link?: boolean;
  add_security_recommendation?: boolean;
  add_track_package_link?: boolean;
  code_expiration_minutes?: number;
}

export interface CreateFromLibraryArgs {
  /** OUR name for the instantiated template. */
  name: string;
  language: string;
  category: TemplateCategory;
  /** The blueprint's name. */
  libraryTemplateName: string;
  buttonInputs?: LibraryTemplateButtonInput[];
  bodyInputs?: LibraryTemplateBodyInput;
}

/**
 * A head-to-head comparison of two templates over a lookback window.
 *
 * Meta's constraints, all enforced by the caller because Meta answers a
 * violation with an EMPTY result rather than an error — which reads as "these
 * templates are identical" instead of "your request was invalid":
 *   - exactly TWO templates, both under the SAME WhatsApp Business Account;
 *   - each must have been sent at least 1,000 times inside the window;
 *   - the window must be 7, 30, 60 or 90 days.
 */
export interface TemplateComparisonArgs {
  /** The template being compared FROM (Meta's id). */
  templateExternalId: string;
  /** The template(s) to compare against. Meta allows exactly one today. */
  againstExternalIds: string[];
  start: Date;
  end: Date;
}

/** Why a customer blocked the business after a template send. */
export type TemplateBlockReason =
  | "NO_LONGER_NEEDED"
  | "NO_REASON"
  | "NO_REASON_GIVEN"
  | "NO_SIGN_UP"
  | "OFFENSIVE_MESSAGES"
  | "OTHER"
  | "OTP_DID_NOT_REQUEST"
  | "SPAM"
  | "UNKNOWN_BLOCK_REASON";

export interface ProviderTemplateComparison {
  /**
   * Template ids in INCREASING order of block rate — the first is the better
   * performer. Meta gives only the ORDER, never the rate itself, so this must
   * never be rendered as a number.
   */
  blockRateOrder: string[];
  /** Times each template was sent in the window. */
  sends: Array<{ templateExternalId: string; count: number }>;
  /** Each template's most common block reason. */
  topBlockReasons: Array<{ templateExternalId: string; reason: TemplateBlockReason | string }>;
}

// ---------------------------------------------------------------------------
// Authentication templates.
//
// Their body is FIXED preset text Meta owns ("<CODE> is your verification
// code."), which is why they cannot be authored in a normal composer: there is
// nothing to write. What you choose is which optional strings to include and
// which OTP button to use — and Meta then generates the wording in every
// language you ask for.
// ---------------------------------------------------------------------------

/** One language's rendering of the preset authentication text. */
export interface AuthTemplatePreview {
  language: string;
  body: string;
  footer?: string;
  buttons: Array<{ text?: string; autofill_text?: string }>;
}

export interface AuthTemplatePreviewArgs {
  /** Language codes to render. Empty = every supported language. */
  languages: string[];
  /** Include "For your security, do not share this code." */
  addSecurityRecommendation?: boolean;
  /** Include "This code expires in N minutes." Meta allows 1–90. */
  codeExpirationMinutes?: number;
}

/** How the recipient gets the code off the message. */
export type OtpType = "COPY_CODE" | "ONE_TAP" | "ZERO_TAP";

/**
 * Create/update an authentication template across MANY languages at once.
 *
 * Meta exposes this as `upsert_message_templates`, and it is the documented way
 * to manage authentication templates: `language` (singular), `text` and
 * `autofill_text` are all unsupported here — the wording is Meta's, so you name
 * the languages and it writes them.
 */
export interface UpsertAuthTemplateArgs {
  name: string;
  languages: string[];
  addSecurityRecommendation?: boolean;
  /** 1–90. Omit to leave the expiry footer off entirely. */
  codeExpirationMinutes?: number;
  otpType: OtpType;
  /** Required for ONE_TAP and ZERO_TAP — the app that receives the code. */
  supportedApps?: Array<{ package_name: string; signature_hash: string }>;
  /**
   * ZERO_TAP only, and REQUIRED there: an acknowledgement that zero-tap use is
   * subject to the WhatsApp Business Terms and that it is your responsibility to
   * make sure customers expect the code to be filled in for them.
   *
   * Meta does not treat a missing/false value as a default — it refuses to
   * create the template at all.
   */
  zeroTapTermsAccepted?: boolean;
}

export interface UpsertAuthTemplateResult {
  templates: Array<{ externalId: string; language: string; status: TemplateStatus | null }>;
}

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

/** Window + subject for a template-analytics read. */
export interface TemplateAnalyticsArgs {
  /** Provider template ids. Meta caps a single request at 10. */
  templateExternalIds: string[];
  /** Inclusive UTC day bounds. Meta's lookback is 90 days. */
  start: Date;
  end: Date;
}

/**
 * One template-day of provider analytics.
 *
 * `read` / `clicked` / cost are all NULLABLE and mean "not reported", never
 * zero: Meta returns read+click only for the last 7 days, and withholds cost
 * entirely when the WABA is billed through a Solution Partner. Collapsing those
 * to 0 would silently turn "unknown" into "nobody read it".
 */
export interface ProviderTemplateAnalyticsRow {
  templateExternalId: string;
  /** UTC day. */
  date: Date;
  sent: number;
  delivered: number;
  read: number | null;
  clicked: number | null;
  costAmountSpent: number | null;
  costPerDelivered: number | null;
  costPerUrlClick: number | null;
  currency: string | null;
}

/**
 * A WhatsApp business phone number's public profile — what a customer sees when
 * they tap the business name in a chat.
 *
 * Every field is optional because Meta returns only what has been set, and a
 * profile with nothing filled in is a legitimate (if unhelpful) state.
 */
export interface ProviderBusinessProfile {
  /** Short status line under the business name. */
  about?: string;
  /** Freeform, max 256 chars. Meta does NOT validate it against any map data. */
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  /**
   * Meta's industry category (`RETAIL`, `HEALTH`, …). READ-ONLY here on
   * purpose: the `WhatsAppVertical` enum's members are not published in the
   * profile reference, and writing a value we guessed would be rejected — or
   * worse, silently set the wrong industry. Editable in WhatsApp Manager.
   */
  vertical?: string;
  /** Meta-hosted URL. Set by uploading a handle, never by writing this. */
  profilePictureUrl?: string;
}

/** The writable subset. `vertical` and `profilePictureUrl` are excluded above. */
export interface UpdateBusinessProfileArgs {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  /**
   * A handle from the resumable upload API (the same one template header media
   * uses) — Meta hosts the image itself, so there is no URL to set.
   */
  profilePictureHandle?: string;
}

/**
 * Account-level status for a WhatsApp number: its Official Business Account
 * standing, plus the WABA it belongs to. Read-only — OBA is requested in
 * WhatsApp Manager (Meta publishes a wire shape for reading the status, not for
 * making the request), and WABA fields aren't ours to write.
 */
export interface ProviderAccountStatus {
  /**
   * Verbatim from Meta. Only `NOT_STARTED` appears in the reference, so this is
   * NOT narrowed to an enum — a status we mapped by guessing would render as
   * something Meta never said.
   */
  obaStatus?: string;
  waba?: {
    name?: string;
    /** e.g. `ACTIVE`. */
    status?: string;
    currency?: string;
    country?: string;
    /** `verified` | `not_verified` | … — an OBA prerequisite. */
    businessVerificationStatus?: string;
  };
}

/**
 * A WhatsApp QR code / short link — a "digital doorstep": a customer scans or
 * taps and lands in a chat with the business, with an optional message already
 * typed. No phone number to key in.
 *
 * `code` is the identity AND the short link's slug
 * (`https://wa.me/message/<code>`). `qrImageUrl` is only returned by the CREATE
 * call — the list endpoint omits it, so it is optional here rather than a field
 * the UI can assume.
 */
export interface ProviderQrCode {
  code: string;
  prefilledMessage: string;
  deepLinkUrl: string;
  qrImageUrl?: string;
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
  /**
   * Edit an existing template's category, components or TTL. Distinct from
   * `createTemplate` because it targets the TEMPLATE node, replaces components
   * wholesale, and re-enters review automatically on success.
   */
  editTemplate?(args: EditTemplateArgs, config: SendConfig): Promise<void>;
  /** Remove a template from the provider catalog. */
  deleteTemplate?(args: DeleteTemplateArgs, config: SendConfig): Promise<void>;
  /**
   * Lift a quality pause on a template (`POST /{template-id}/unpause`).
   *
   * Meta unpauses a quality-paused template on its own after 3h, then 6h, then
   * DISABLES it on the third instance — but a template paused by **Template
   * Pacing** never self-unpauses and must be lifted manually, which is the case
   * this exists for.
   */
  unpauseTemplate?(externalId: string, config: SendConfig): Promise<void>;
  /** The business phone number's public profile. */
  getBusinessProfile?(config: SendConfig): Promise<ProviderBusinessProfile>;
  /** OBA standing + the owning WABA's record. */
  getAccountStatus?(config: SendConfig): Promise<ProviderAccountStatus>;
  /** QR codes / short links for the business phone number. */
  listQrCodes?(config: SendConfig): Promise<ProviderQrCode[]>;
  createQrCode?(
    args: { prefilledMessage: string; imageFormat: "SVG" | "PNG" },
    config: SendConfig,
  ): Promise<ProviderQrCode>;
  updateQrCode?(
    args: { code: string; prefilledMessage: string },
    config: SendConfig,
  ): Promise<ProviderQrCode>;
  deleteQrCode?(code: string, config: SendConfig): Promise<void>;
  updateBusinessProfile?(
    args: UpdateBusinessProfileArgs,
    config: SendConfig,
  ): Promise<void>;
  /**
   * Render the preset authentication text in the requested languages, so an
   * operator can SEE the wording before committing to it. Meta owns the copy, so
   * this is the only way to show it.
   */
  previewAuthTemplates?(
    args: AuthTemplatePreviewArgs,
    config: SendConfig,
  ): Promise<AuthTemplatePreview[]>;
  /** Create/update an authentication template across many languages at once. */
  upsertAuthTemplate?(
    args: UpsertAuthTemplateArgs,
    config: SendConfig,
  ): Promise<UpsertAuthTemplateResult>;
  /** Browse the provider's library of pre-written, pre-categorized templates. */
  fetchTemplateLibrary?(
    filters: TemplateLibraryFilters,
    config: SendConfig,
  ): Promise<LibraryTemplate[]>;
  /**
   * Instantiate a library template under our own name. Distinct from
   * `createTemplate` because the wire shape is different — no `components`, just
   * the blueprint name plus per-business button/body inputs — and because an
   * unmodified instantiation is approved immediately rather than queued for
   * review.
   */
  createFromLibrary?(
    args: CreateFromLibraryArgs,
    config: SendConfig,
  ): Promise<CreateTemplateResult>;
  /**
   * Head-to-head performance of two templates: which has the lower block rate,
   * how often each was sent, and each one's top block reason.
   *
   * Distinct from `fetchTemplateAnalytics` because it answers a different
   * question with different data — block RATE (as an ordering, never a number)
   * rather than the per-day sent/delivered/read series — and carries its own
   * constraints (two templates, same WABA, 1,000+ sends each, a fixed set of
   * lookback windows).
   */
  compareTemplates?(
    args: TemplateComparisonArgs,
    config: SendConfig,
  ): Promise<ProviderTemplateComparison>;
  /**
   * Switch on the provider's own template analytics for this account.
   *
   * IRREVERSIBLE at Meta and one-time, which is why it is a distinct method
   * rather than something `fetchTemplateAnalytics` does implicitly on its first
   * empty response: an implicit trigger would make an unrecoverable account
   * change a side effect of opening a chart.
   */
  enableTemplateInsights?(config: SendConfig): Promise<void>;
  /**
   * Provider-side aggregate performance per template per day — the only source
   * of currency COST and of unique URL-button clicks, neither of which the
   * per-recipient status webhooks carry.
   */
  fetchTemplateAnalytics?(
    args: TemplateAnalyticsArgs,
    config: SendConfig,
  ): Promise<ProviderTemplateAnalyticsRow[]>;
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
   * Request a customer's permission to be called. Permission is required
   * before EVERY business-initiated call — there is no service-window
   * exemption; the window only decides how you may ask (a free-form message
   * inside it, an approved template outside it).
   *
   * The provider rate-limits these (1/24h and 2/7d per contact, both reset by
   * any connected call). Don't mirror those caps locally — read them from
   * `getCallPermission`, which returns the live quota.
   *
   * Identify the customer by `to` (phone) or `recipient` (business-scoped user
   * id); at least one is required, and `to` wins if both are given. A cold
   * caller the provider hasn't seen in 30 days has only a BSUID, so a
   * phone-only signature would make them permanently unreachable.
   *
   * `bodyText` is optional context shown above the Allow/Deny prompt. The
   * prompt itself is provider-rendered and cannot be customized.
   *
   * Returns the id of the request MESSAGE — the same id the customer's reply
   * webhook echoes back as its context, which is how a grant is correlated to
   * the exact request that produced it. `expiresAt` is the REQUEST's validity
   * (it lapses if the customer never responds), NOT a grant: the grant's own
   * expiry arrives on the reply webhook and is authoritative.
   */
  sendCallPermissionRequest?(
    args: { to?: string; recipient?: string; bodyText?: string },
    config: SendConfig,
  ): Promise<{ permissionRequestId: string; expiresAt: Date }>;

  /**
   * Read the customer's CURRENT call-permission state and live quota from the
   * provider. This is the authoritative pre-flight gate for an outbound call —
   * see CallPermissionState for why a local ledger cannot serve that role.
   *
   * Identified by `to` (phone) or `recipient` (BSUID), same rule as above.
   */
  getCallPermission?(
    args: { to?: string; recipient?: string },
    config: SendConfig,
  ): Promise<CallPermissionState>;

  /**
   * Initiate an outbound call. The BROWSER generates an SDP offer first
   * (via `RTCPeerConnection.createOffer`) and we forward it to Meta in the
   * connect-action payload. Meta returns a call_id immediately; the
   * customer's phone starts ringing. When the customer answers, Meta sends
   * a webhook with the SDP ANSWER, which the browser feeds into
   * `setRemoteDescription` to complete the WebRTC handshake.
   *
   * Identify the callee by `to` (phone) or `recipient` (BSUID) — at least one,
   * `to` wins if both. `correlationId` is an opaque string the provider echoes
   * back on every subsequent webhook for this call, which is what lets ingest
   * match a webhook to the row we created without racing on the provider's id.
   */
  placeCall?(
    args: {
      to?: string;
      recipient?: string;
      sdpOffer: string;
      correlationId?: string;
    },
    config: SendConfig,
  ): Promise<{ externalCallId: string }>;

  /**
   * Preamble before acceptCall, carrying the SAME SDP answer (pre_accept
   * without session.sdp returns 131009 "Missing session parameter").
   *
   * Its POINT is media timing, and it only pays off if the two hops are
   * actually separated: pre_accept lets the WebRTC connection establish, and
   * `accept` is sent only once it has. Media must not flow until accept
   * returns 200, or the caller loses the first words of the call. Firing both
   * back-to-back defeats the mechanism entirely.
   */
  preAcceptCall?(
    args: { externalCallId: string; sdpAnswer: string },
    config: SendConfig,
  ): Promise<void>;

  /**
   * Accept an incoming call, once the WebRTC connection from `preAcceptCall`
   * is established. Carries the same SDP answer. After the 200, media may
   * flow DTLS+SRTP browser ↔ provider.
   */
  acceptCall?(
    args: { externalCallId: string; sdpAnswer: string },
    config: SendConfig,
  ): Promise<void>;

  /**
   * Decline an incoming call before any answer. No reason is sent to the
   * provider — its reject action takes only the call id, and passing an
   * undocumented field risks the whole request being rejected. Record any
   * decline reason locally instead.
   */
  rejectCall?(
    args: { externalCallId: string },
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
   * Admin one-shot: turn calling on with sensible defaults. Required once
   * before any call can be placed or received (the provider otherwise rejects
   * with "Calling API not enabled"). Idempotent.
   *
   * Kept distinct from `updateCallSettings` because what "enable" means differs
   * by channel: on a phone number it writes calling settings, while on a
   * Messenger Page it routes inbound calls to us and reports the Page's feature
   * status. Channels with the richer settings surface implement both.
   */
  enableCalling?(config: SendConfig): Promise<{ ok: true; raw: unknown }>;

  /**
   * Admin: update calling configuration on the provider's phone number.
   *
   * Calling must be enabled at least once before any call can be placed (the
   * provider otherwise rejects with "Calling API not enabled"). Idempotent, and
   * a PATCH — only the fields present are written, so this can also be used for
   * targeted changes like hiding the call icon.
   *
   * Changes can take up to 7 days to reach every customer's client, so the UI
   * should not promise an immediate effect.
   */
  updateCallSettings?(
    settings: CallSettings,
    config: SendConfig,
  ): Promise<CallSettingsState>;

  /**
   * Admin: read the provider's current calling configuration + any active
   * restrictions. Both a diagnostic ("why aren't inbound calls arriving?") and
   * the source of the Settings screen's truth — an admin can change these in
   * the provider's own console, so a locally cached view drifts.
   */
  getCallSettings?(config: SendConfig): Promise<CallSettingsState>;

  /**
   * Admin helper: GET the provider's stored phone-number settings, unparsed.
   * Kept alongside `getCallSettings` for raw ops diagnosis of fields we don't
   * model.
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
