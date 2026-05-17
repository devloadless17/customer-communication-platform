import type { MediaKind, MessageStatus, ProviderName } from "../types";

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
   * the caption (or empty). Either body or media (or both) will be present.
   */
  body: string;
  /** Set when the message carries an attachment that needs downloading. */
  media?: NormalizedMediaRef;
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

export type NormalizedEvent = NormalizedInboundMessage | NormalizedStatusUpdate;

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
}

export interface MessagingProvider<SendConfig = unknown> {
  name: ProviderName;
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
}
