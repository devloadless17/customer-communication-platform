import type { MediaKind, MessageStatus, Channel } from "../types";

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
  /** Provider-side id used to fetch the binary. */
  externalMediaId: string;
  mimeType: string;
  /** Filename (documents) — Meta only sends this for type=document. */
  filename?: string;
  /** Audio + video duration if the provider includes it. */
  durationMs?: number;
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

export interface NormalizedInboundMessage {
  kind: "message";
  /** Provider-assigned id; the dedupe key. */
  externalId: string;
  /** E.164 digits, no '+'. e.g. "5511999999999". */
  contactPhone: string;
  /** Display name from the provider, if any. We fall back to the phone number. */
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
  timestamp: Date;
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
  /** E.164 digits, no '+'. Same shape as messages. */
  contactPhone: string;
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

export type NormalizedEvent =
  | NormalizedInboundMessage
  | NormalizedStatusUpdate
  | NormalizedCallEvent;

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
}

export interface SendTextResult {
  externalId: string;
  timestamp: Date;
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
 * own `header` component entry, separate from body. Buttons with URL/COPY_CODE
 * substitutions also have their own component entries; we don't support those
 * yet (TODO: dynamic button URLs).
 */
export interface TemplateVariableSet {
  /** Body `{{1}}, {{2}}, …` values in order. Empty array when body has no vars. */
  body: string[];
  /** Header `{{1}}` value when the header is TEXT with a placeholder. */
  header?: string;
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
  templates: boolean;
  readReceipts: boolean;
  typingIndicators: boolean;
  /**
   * Voice calling. True if the provider implements placeCall / acceptCall /
   * etc. Gates the inbox "Call" button at the channel level — a future
   * SMS provider with calling=false hides the button on its threads.
   */
  calling: boolean;
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
   * Outbound interactive question (buttons / list). Optional — providers
   * without interactive support fall back to plain text (the caller decides
   * how to degrade). Same 24h-window rule applies as plain text sends.
   */
  sendInteractive?(args: SendInteractiveArgs, config: SendConfig): Promise<SendTextResult>;
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
  /** Inbound media: download a file by provider-side id. */
  fetchMedia?(externalMediaId: string, config: SendConfig): Promise<FetchedMedia>;
  /**
   * Acknowledge an inbound message as read on the provider so the customer
   * sees blue ticks. Optional — providers that don't support read receipts
   * (or don't expose them via API) leave this off. Best-effort: a failure
   * here must not break the agent's view, so callers should swallow errors.
   */
  markIncomingRead?(externalId: string, config: SendConfig): Promise<void>;
  /**
   * Show the customer a "typing…" bubble on their device. Anchored to a
   * recent inbound message id (Meta requires the indicator to be sent as
   * part of marking an inbound as read). Auto-dismisses on the provider
   * side after a short window (Meta: 25s) or when an outbound is sent.
   *
   * Best-effort like markIncomingRead — callers swallow errors so a Meta
   * hiccup doesn't degrade the local typing UX.
   */
  sendTypingIndicator?(externalId: string, config: SendConfig): Promise<void>;

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
}
