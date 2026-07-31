import { safeMetaText } from "./meta-send";
import {
  GRAPH_BASE,
  isGraphShapeDisagreement,
  metaFetch,
  } from "./meta-transport";
import {
  blockUsersCall,
  messagingAccountField,
  postWhatsappMessages,
  sendCtaUrlButton,
  sendInteractiveCarousel,
  sendLocationRequest,
  sendRequestContactInfo,
  sendVoiceCallButton,
  whatsappDestination,
} from "./meta-send";
import type { MetaSendConfig } from "@/lib/providers/config";
import {
  MetaSendError,
  normalizeMetaSendError,
  isProvablyNotSent,
  isPairRateLimitBody,
  isPairRateLimitError,
} from "./meta-send-error";

// Meta error responses are tiny in practice (JSON envelope, a few KB).
// Cap reads so a future endpoint or a compromised upstream returning a
// multi-GB response can't OOM the worker. Errors longer than the cap
// are truncated — we keep what fits and log the truncation.

import type {
  CallHoursWindow,
  CallPermissionState,
  CallRecordingOptions,
  CallSettings,
  CallSettingsState,
  CallTranscriptionOptions,
  CreateTemplateArgs,
  CreateTemplateResult,
  DeleteTemplateArgs,
  FetchedMedia,
  MessagingProvider,
  NormalizedChannelHealth,
  NormalizedContactSync,
  NormalizedEvent,
  NormalizedInboundMessage,
  NormalizedMediaRef,
  NormalizedMessageCorrection,
  NormalizedOutboundEcho,
  NormalizedReaction,
  NormalizedStatusUpdate,
  ProviderAccountStatus,
  ProviderBusinessProfile,
  ProviderQrCode,
  ProviderTemplate,
  UpdateBusinessProfileArgs,
  SendInteractiveArgs,
  SendLocationArgs,
  SendContactsArgs,
  SendReactionArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendTextArgs,
  SendTextResult,
  BlockUsersResult,
  AuthTemplatePreview,
  AuthTemplatePreviewArgs,
  CreateFromLibraryArgs,
  EditTemplateArgs,
  UpsertAuthTemplateArgs,
  UpsertAuthTemplateResult,
  LibraryTemplate,
  TemplateLibraryFilters,
  ProviderTemplateAnalyticsRow,
  SetTemplateLinkTrackingArgs,
  ProviderTemplateComparison,
  MessagingAnalyticsArgs,
  ProviderMessagingAnalyticsRow,
  ConversationAnalyticsArgs,
  ProviderConversationAnalyticsRow,
  PricingAnalyticsArgs,
  ProviderPricingAnalyticsRow,
  CallAnalyticsArgs,
  ProviderCallAnalyticsRow,
  TemplateAnalyticsArgs,
  TemplateComparisonArgs,
  UploadHeaderMediaArgs,
  UploadHeaderMediaResult,
  UploadMediaArgs,
  UploadMediaResult,
} from "@ccp/shared/providers/types";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import type { MediaKind, MessageAttribution, MessageStructured } from "@ccp/shared/types";

/**
 * Meta WhatsApp Cloud API webhook parser.
 *
 * Payload shape (abridged):
 *   { object, entry: [{ id, changes: [{ field, value: { messages?, statuses?, contacts?, metadata } }] }] }
 *
 * Walks `entry[].changes[].value` and emits one NormalizedInboundMessage per
 * incoming text message. Statuses are dropped at parse time for now (logged
 * at the route).
 *
 * Send / read calls take a MetaSendConfig (phone_number_id + access token)
 * loaded from the Team row by the route handler — the provider itself reads
 * no env vars. CLAUDE.md rule #6.
 */

/**
 * `fetch` with a hard timeout. Every Meta Graph / CDN call goes through here
 * so a hung upstream can't stall the request that triggered it — most
 * importantly the webhook handler, which downloads inbound media synchronously
 * before it returns 200 to Meta. Without this, one slow CDN response makes
 * Meta time the webhook out and retry the whole batch.
 */
// `??` only catches null/undefined — empty string slips through to Number("")
// which is 0, making every Meta call abort instantly. docker-compose.yml
// passes the empty string when META_FETCH_TIMEOUT_MS isn't set in .env, so
// the fallback only fires via `||` on a falsy parse.
/**
 * Follow-up page ceiling for `GET /{wabaId}/message_templates` (limit=200).
 * Sized to Meta's documented maximum of 6,000 templates per WABA under a
 * VERIFIED business portfolio (250 when unverified) = 30 pages, plus headroom.
 * See `fetchTemplates`, which throws rather than returning a truncated catalog.
 */
const TEMPLATE_LIST_MAX_PAGES = 40;

/**
 * `whatsapp_business_account` webhook fields we KNOW about and deliberately do
 * not consume, so `parseWebhook` drops them without a warn.
 *
 * The warn exists to surface a field Meta newly starts sending. Our apps were
 * subscribed to 13 fields with no handler (confirmed via
 * `devtools_webhook_list{list_topics}`, 2026-07-30), so it fired on nearly every
 * delivery and had stopped being a signal. Silencing the known set restores it.
 *
 * Each entry is a per-topic decision made against its own doc page:
 *
 *   Genuinely irrelevant to a shared inbox — no entity here to keep fresh:
 *     `automatic_events`          CTWA conversion telemetry; needs a Meta-Suite
 *                                 opt-in we never ask for, and we model no
 *                                 conversion.
 *     `flows`                     health/status of WhatsApp Flows ASSETS. We ship
 *                                 no Flows builder. (A user's Flow *response*
 *                                 arrives on `messages` and IS handled.)
 *     `partner_solutions`         Multi-Partner Solution lifecycle on the
 *                                 PARTNER's portfolio. We are not one.
 *     `payment_configuration_update`  India Payments only; no payment config
 *                                 modelled. Trap if ever implemented: its enum is
 *                                 Title Case with a space, not SCREAMING_SNAKE.
 *
 *   Groups — a deliberate non-feature (group inbounds are already dropped by
 *   `group_id` gate). Kept subscribed so the metadata is flowing the day a pilot
 *   asks for it:
 *     `group_lifecycle_update` · `group_participants_update`
 *     `group_settings_update`  · `group_status_update`
 *
 *   No WhatsApp payload documented anywhere — only Messenger's shape exists, and
 *   WhatsApp has no thread ownership to hand over ("all parties the phone number
 *   is shared with receive incoming webhooks"). Implementing off the Messenger
 *   shape would be guessing at a wire format:
 *     `messaging_handovers` · `standby`
 *
 *   Not findable as documented WhatsApp fields at all, despite being subscribable.
 *   Recorded here rather than parsed on a guess:
 *     `template_correct_category_detection`  the real category signal we DO
 *                                 consume is `template_category_update`, whose
 *                                 advisory shape carries `correct_category`.
 *     `business_status_update` · `tracking_events`
 *
 *   Announces phone-number settings changes (calling status, icon, SIP). Our
 *   settings surfaces always read live from Graph, so there is no cached copy to
 *   refresh:
 *     `account_settings_update`
 *
 * `business_username_updates` is deliberately ABSENT from this list — it carries
 * state we do model (a number's username) and is handled in parseWebhook: it
 * emits a `channel_health` event carrying `businessUsername`.
 */
const QUIET_DROP_WHATSAPP_FIELDS = new Set<string>([
  "account_settings_update",
  "automatic_events",
  "business_status_update",
  "flows",
  "group_lifecycle_update",
  "group_participants_update",
  "group_settings_update",
  "group_status_update",
  "messaging_handovers",
  "partner_solutions",
  "payment_configuration_update",
  "standby",
  "template_correct_category_detection",
  "tracking_events",
]);

interface MetaEnvelope {
  object?: string;
  entry?: MetaEntry[];
}

interface MetaEntry {
  id?: string;
  changes?: MetaChange[];
}

interface MetaChange {
  field?: string;
  value?: MetaChangeValue;
}


// One chunk of the Coexistence history backfill. Meta splits the past ~180 days
// into 3 phases (0: day 0-1, 1: day 1-90, 2: day 90-180); large phases are
// further split across webhooks ordered by `chunk_order`, with `progress`
// (0-100) tracking completion. Group chats are excluded by Meta.

// One address-book change from the `smb_app_state_sync` webhook.


interface MetaCallingSettings {
  status?: string;
  call_icon_visibility?: string;
  /** Country scoping for the call icon (restrict_to_user_countries). */
  call_icons?: {
    restrict_to_user_countries?: string[];
  };
  callback_permission_status?: string;
  /** Voicemail for missed/rejected inbound calls (call-settings doc). The
   *  announcement id is numeric in Meta's samples but near the 2^53 boundary —
   *  never coerce through Number; carry it as-is and stringify for state. */
  voicemail?: {
    status?: string;
    triggers?: string[];
    audio?: {
      default?: {
        announcement_media_id?: number | string;
        timeout_seconds?: number;
      };
    };
  };
  call_hours?: {
    status?: string;
    timezone_id?: string;
    weekly_operating_hours?: Array<{
      day_of_week?: string;
      open_time?: string;
      close_time?: string;
    }>;
    /** Per-date overrides (up to 20). We don't author these, but a call_hours
     *  POST REPLACES the whole object — "if holiday_schedule is not passed…
     *  the existing holiday_schedule will be deleted" — so writes must carry
     *  the stored entries forward or silently wipe them. */
    holiday_schedule?: Array<{
      date?: string;
      start_time?: string;
      end_time?: string;
    }>;
  };
  /** Present while Meta has paused calling on this number. */
  restrictions?: {
    restrictions_list?: Array<{
      type?: string;
      reason?: string;
      /** Epoch seconds the restriction lifts. */
      expiration?: number;
    }>;
  };
  /** SIP signaling config. We never enable it — ENABLED means the Graph
   *  calling endpoints this platform uses stop working on the number, so
   *  the read-back exists purely to DIAGNOSE that state. */
  sip?: {
    status?: string;
    servers?: Array<{ app_id?: string | number; hostname?: string }>;
  };
  /** DTLS (default) | SDES. Browser RTCPeerConnection only speaks DTLS-SRTP,
   *  so SDES set out-of-band silently breaks our media negotiation. */
  srtp_key_exchange_protocol?: string;
}





/**
 * Display name for a shared contact card. `formatted_name` when present (the
 * WhatsApp client normally builds it), else composed from the name parts — the
 * contacts webhook doc warns ANY property may be omitted, and a card with only
 * `first_name`/`last_name` must not render nameless.
 */
function contactCardName(c: MetaContactsPayload): string {
  const formatted = c.name?.formatted_name?.trim();
  if (formatted) return formatted;
  const n = c.name;
  if (!n) return "";
  return [n.prefix, n.first_name, n.middle_name, n.last_name, n.suffix]
    .map((x) => x?.trim())
    .filter((x): x is string => !!x && x.length > 0)
    .join(" ");
}


const META_MEDIA_TYPES: MediaKind[] = ["image", "video", "audio", "document", "sticker"];


/**
 * Customer message types we don't render with a dedicated bubble yet —
 * location pins, contact cards (vCard), orders, and Meta's `unsupported`
 * fallback. Rather than dropping them silently (which loses the message, never
 * updates unread / the 24h window, and leaves Meta no reason to redeliver), we
 * ingest them as a plain text row carrying a typed placeholder body. The raw
 * payload is preserved on the Message row, so proper rendering can be layered
 * on later without data loss. Returns null only for genuinely empty/unknown
 * shapes where no useful placeholder exists.
 */
function placeholderForUnhandledType(m: MetaMessage): string | null {
  switch (m.type) {
    case "location": {
      const loc = m.location;
      const place = loc?.name || loc?.address;
      if (place) return `📍 Location: ${place}`;
      if (loc && loc.latitude != null && loc.longitude != null) {
        return `📍 Location shared (${loc.latitude}, ${loc.longitude})`;
      }
      return "📍 Location shared";
    }
    case "contacts": {
      const names = (m.contacts ?? [])
        .map((c) => contactCardName(c))
        .filter((n) => n.length > 0);
      if (names.length > 0) return `👤 Contact card: ${names.join(", ")}`;
      return "👤 Contact card shared";
    }
    case "order": {
      // Surface the buyer's note attached to the order (doc `order.text`) instead
      // of dropping it — otherwise the customer's message is invisible in-inbox.
      const note = m.order?.text?.trim();
      return note ? `🛒 Order shared — ${note}` : "🛒 Order shared";
    }
    case "unsupported": {
      // Meta strips the content for unsupported types; the errors array and
      // the `unsupported.type` sub-object are the only context. Causes: a
      // message kind the Cloud API can't represent (poll, pin, group invite,
      // an edit while Meta's edit delivery is down, …) — named in
      // `unsupported.type`; or 131060 "currently unavailable" (typically the
      // first CTWA message to a Coexistence number). Surface both the KIND
      // and Meta's reason so it's not a context-free "Unsupported message".
      const err = m.errors?.[0];
      const reason = err?.error_data?.details?.trim() || err?.title?.trim();
      const kind = m.unsupported?.type?.trim();
      const label = kind
        ? `⚠️ Unsupported message (${kind.replace(/_/g, " ")})`
        : "⚠️ Unsupported message";
      return reason ? `${label} — ${reason}` : label;
    }
    case "system": {
      // A system NOTICE about the account. `user_changed_number` is
      // intercepted upstream (contact migration), so what reaches here is any
      // OTHER system subtype — notably the opt-in identity-change signal
      // ("the person behind this account may have changed"). That one matters
      // operationally: once it fires, Meta BLOCKS every outbound to this
      // person until the business acknowledges, so this bubble is the only
      // in-inbox explanation for sends suddenly failing. `system.body` is
      // Meta's own human-readable sentence — surface it verbatim instead of
      // a context-free "Unsupported message (system)".
      const body = m.system?.body?.trim();
      if (body) return `ℹ️ ${body}`;
      const sub = m.system?.type?.trim();
      return sub
        ? `ℹ️ WhatsApp system notice (${sub.replace(/_/g, " ")})`
        : "ℹ️ WhatsApp system notice";
    }
    default:
      // Unknown future type Meta might add — surface SOMETHING so it's
      // visible + counts toward unread, rather than vanishing.
      return m.type ? `Unsupported message (${m.type})` : null;
  }
}

/**
 * Build the structured (non-media) payload for a location pin or contact card so
 * the bubble can render a map / vCard instead of the bare text placeholder.
 * Returns undefined for types without structured rendering (order/unsupported
 * stay text-only). The raw payload is always retained on the row regardless.
 */
function structuredForMessage(m: MetaMessage): MessageStructured | undefined {
  if (m.type === "location" && m.location) {
    const { latitude, longitude, name, address } = m.location;
    if (latitude == null || longitude == null) return undefined;
    return {
      kind: "location",
      latitude,
      longitude,
      ...(name?.trim() ? { name: name.trim() } : {}),
      ...(address?.trim() ? { address: address.trim() } : {}),
    };
  }
  if (m.type === "contacts" && Array.isArray(m.contacts)) {
    const contacts = m.contacts
      .map((c) => {
        // Fold a vCard address into one human line ("1 Lucky Way, Menlo Park,
        // CA 94025, US"), dropping empty parts — the same way WhatsApp shows it.
        const addresses = (c.addresses ?? [])
          .map((a) =>
            [a.street, a.city, a.state, a.zip, a.country ?? a.country_code]
              .map((x) => x?.trim())
              .filter((x): x is string => !!x && x.length > 0)
              .join(", "),
          )
          .filter((a) => a.length > 0);
        // "Title · Company" (either part optional).
        const company = [c.org?.title?.trim(), c.org?.company?.trim()]
          .filter((x): x is string => !!x && x.length > 0)
          .join(" · ");
        // `origin` + `phones[].wa_id` (BSUID rollout): "contact_request" marks
        // a reply to our REQUEST_CONTACT_INFO button — the user sharing THEIR
        // OWN number — and `wa_id` is Meta's resolution of it to a WhatsApp
        // account. Carried so ingest can apply the self-asserted phone to the
        // sending contact; an ordinary forwarded vCard ("other"/absent) stays
        // display-only.
        const origin = c.origin?.trim();
        const waIds = (c.phones ?? [])
          .map((p) => p.wa_id?.replace(/\D/g, "") ?? "")
          .filter((w) => w.length >= 8);
        return {
          name: contactCardName(c),
          phones: (c.phones ?? [])
            .map((p) => p.phone?.trim() ?? "")
            .filter((p) => p.length > 0),
          emails: (c.emails ?? [])
            .map((e) => e.email?.trim() ?? "")
            .filter((e) => e.length > 0),
          addresses,
          ...(company ? { company } : {}),
          ...(origin ? { origin } : {}),
          ...(waIds.length ? { waIds } : {}),
        };
      })
      .filter(
        (c) =>
          c.name.length > 0 ||
          c.phones.length > 0 ||
          c.emails.length > 0 ||
          c.addresses.length > 0,
      )
      // Keep the wire lean: drop empty optional arrays so an old-shape row and a
      // new phones-only row serialize identically.
      .map((c) => ({
        name: c.name,
        phones: c.phones,
        ...(c.emails.length ? { emails: c.emails } : {}),
        ...(c.addresses.length ? { addresses: c.addresses } : {}),
        ...(c.company ? { company: c.company } : {}),
        ...(c.origin ? { origin: c.origin } : {}),
        ...(c.waIds?.length ? { waIds: c.waIds } : {}),
      }));
    if (contacts.length === 0) return undefined;
    return { kind: "contacts", contacts };
  }
  if (m.type === "order" && m.order?.product_items?.length) {
    const items = m.order.product_items
      .map((it) => {
        const retailerId = it.product_retailer_id?.trim() ?? "";
        const quantity = Number(it.quantity ?? 0) || 0;
        const price = it.item_price != null ? Number(it.item_price) : undefined;
        return {
          retailerId,
          quantity,
          ...(price != null && Number.isFinite(price) ? { price } : {}),
        };
      })
      .filter((it) => it.retailerId.length > 0 && it.quantity > 0);
    if (items.length === 0) return undefined;
    const currency = m.order.product_items.find((it) => it.currency)?.currency;
    // Only surface a `total` when EVERY item is priced — otherwise it would
    // understate the real order while being labelled a definitive "Total".
    const allPriced = items.every((it) => it.price != null);
    const total = allPriced
      ? items.reduce((sum, it) => sum + (it.price ?? 0) * it.quantity, 0)
      : 0;
    return {
      kind: "order",
      items,
      itemCount: items.reduce((n, it) => n + it.quantity, 0),
      ...(allPriced && total > 0 ? { total } : {}),
      ...(currency ? { currency } : {}),
    };
  }
  return undefined;
}

/** New body text carried by a WhatsApp `edit.message` — the text body, or a
 *  media CAPTION (only the caption is editable on media). Undefined for an edit
 *  whose new content we can't represent as text (ingest then just marks it
 *  edited without rewriting the body). */
function editBody(msg: NonNullable<MetaMessage["edit"]>["message"]): string | undefined {
  return (
    msg?.text?.body ??
    msg?.image?.caption ??
    msg?.video?.caption ??
    msg?.document?.caption ??
    undefined
  );
}

/**
 * Build ad / deep-link attribution from a WhatsApp inbound `referral` (Click-to-
 * WhatsApp). Present only on the first message of an ad-sourced conversation;
 * undefined otherwise. Surfaced as the "from your ad" chip.
 */
function attributionForMessage(m: MetaMessage): MessageAttribution | undefined {
  const r = m.referral;
  if (!r) return undefined;
  const source: MessageAttribution["source"] =
    r.source_type === "ad" ? "ad" : r.source_type === "post" ? "post" : "unknown";
  return {
    source,
    ...(r.headline?.trim() ? { headline: r.headline.trim() } : {}),
    ...(r.body?.trim() ? { body: r.body.trim() } : {}),
    ...(r.source_url?.trim() ? { sourceUrl: r.source_url.trim() } : {}),
    ...(r.ctwa_clid?.trim() ? { clickId: r.ctwa_clid.trim() } : {}),
    // `source_id` is documented as "the ID of the ad or post", so which field it
    // belongs in depends on `source_type`. It was parsed into the wire type and
    // then never mapped at all — so a Click-to-WhatsApp campaign could be seen
    // one conversation at a time but never grouped by the ad that drove it.
    ...(r.source_id?.trim() && source === "ad" ? { adId: r.source_id.trim() } : {}),
    ...(r.source_id?.trim() && source === "post" ? { postId: r.source_id.trim() } : {}),
    ...(r.media_type === "image" || r.media_type === "video"
      ? { mediaType: r.media_type }
      : {}),
    ...(r.image_url?.trim() ? { imageUrl: r.image_url.trim() } : {}),
    ...(r.video_url?.trim() ? { videoUrl: r.video_url.trim() } : {}),
    ...(r.thumbnail_url?.trim() ? { thumbnailUrl: r.thumbnail_url.trim() } : {}),
    ...(r.welcome_message?.text?.trim()
      ? { greeting: r.welcome_message.text.trim() }
      : {}),
  };
}

/**
 * Extract the renderable content (body + optional media ref) from a Meta
 * message object WITHOUT the direction/contact wrapper. Shared by the
 * Coexistence echo + history parsers, which build both inbound and outbound
 * normalized events from the same message shape depending on who sent it.
 *
 * Mirrors the inbound `messages[]` walk's text/media/placeholder handling. Two
 * deliberate simplifications vs. that walk:
 *   - interactive-reply + reaction subtypes fall through to the typed
 *     placeholder here. Those only ever originate customer-side in the LIVE
 *     `messages` field; an echo is business-sent (a business doesn't tap its
 *     own buttons) and their appearance in a history backfill is rare enough
 *     that a placeholder row is an acceptable, non-lossy fallback.
 *   - history media first arrives as `type: "media_placeholder"` (no asset id);
 *     we render it as a "📎 Media" row so the message is never silently lost.
 *     For messages within 14 days of onboarding Meta follows up with the real
 *     media; if that carries the same wamid it dedupes against this placeholder
 *     (best-effort — historical media fidelity is not load-bearing).
 */
function extractMetaMessageContent(
  m: MetaMessage,
): { body: string; media?: NormalizedMediaRef } | null {
  if (m.type === "text") {
    const body = m.text?.body;
    return body ? { body } : null;
  }
  if (m.type === "media_placeholder") {
    return { body: "📎 Media" };
  }
  const mediaKind = m.type as MediaKind | undefined;
  if (mediaKind && META_MEDIA_TYPES.includes(mediaKind)) {
    const mediaPayload = m[mediaKind] as MetaMediaPayload | undefined;
    if (!mediaPayload?.id || !mediaPayload.mime_type) return null;
    const media: NormalizedMediaRef = {
      kind: mediaKind,
      externalMediaId: mediaPayload.id,
      mimeType: mediaPayload.mime_type,
      ...(mediaPayload.filename ? { filename: mediaPayload.filename } : {}),
      ...(mediaPayload.duration ? { durationMs: mediaPayload.duration * 1000 } : {}),
      ...(mediaKind === "audio" && mediaPayload.voice ? { voice: true } : {}),
    };
    return { body: mediaPayload.caption ?? "", media };
  }
  const placeholder = placeholderForUnhandledType(m);
  return placeholder ? { body: placeholder } : null;
}

export const metaProvider: MessagingProvider<MetaSendConfig> = {
  name: "whatsapp",

  // Static per-channel capabilities live in @ccp/shared so the frontend reads
  // the exact same values (no endpoint/plumbing). WhatsApp: 24h window, no
  // human-agent extension, templates + calling.
  capabilities: CHANNEL_CAPABILITIES.whatsapp,

  parseWebhook(payload: unknown): NormalizedEvent[] {
    if (!isObject(payload)) return [];
    const env = payload as MetaEnvelope;
    if (env.object !== "whatsapp_business_account") return [];

    const events: NormalizedEvent[] = [];

    for (const entry of Array.isArray(env.entry) ? env.entry : []) {
      // For `object: "whatsapp_business_account"` (guarded above) `entry.id`
      // IS the WABA id. Account-level webhooks (template lifecycle, quality,
      // capability, account_update) carry no `metadata.phone_number_id`, so
      // this is the scope that lets ingest attribute them to the right
      // rows instead of whichever number happens to be the workspace default.
      const wabaId =
        typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
      for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
        const value = change.value;
        if (!value) continue;

        // Every event produced from THIS change arrived on THIS business phone
        // number. Meta batches changes for SEVERAL of a workspace's numbers into
        // one POST ("multiple changes from different objects that are of the same
        // type may be batched together"), so the receiving account is stamped per
        // change and never resolved once for the whole body — doing the latter
        // bound a second number's threads to the first number, and the reply then
        // went out a number with no open 24h window.
        //
        // Account-level changes (template lifecycle, quality, capability,
        // account_update) carry no `metadata`, so they stay UNSTAMPED on purpose:
        // their subject is the WABA or a number named in the body, which ingest
        // resolves per-event from `wabaId` / `display_phone_number`.
        const receivingAccountId = value.metadata?.phone_number_id;
        const emit = <E extends NormalizedEvent>(evt: E): void => {
          events.push(
            receivingAccountId ? ({ ...evt, externalAccountId: receivingAccountId } as E) : evt,
          );
        };

        // Template lifecycle: Meta sends `message_template_status_update` when a
        // template is approved, paused for quality, disabled, or rejected. These
        // arrive under their own `field` (NOT "messages") with flat value fields.
        // Ingesting them keeps the local catalog's status fresh automatically —
        // without this, a Meta-paused marketing template silently mass-fails a
        // scheduled broadcast and a newly-approved one never becomes sendable
        // until someone clicks the manual "Sync" button.
        if (change.field === "message_template_status_update") {
          const evt = parseTemplateStatusUpdate(value, payload as Record<string, unknown>);
          if (evt) emit({ ...evt, ...(wabaId ? { wabaId } : {}) });
          continue;
        }

        // A template's COMPONENTS changed at Meta (an edit in WhatsApp Manager,
        // or a Meta-side correction). Our cached `components` drive the whole
        // send-time parameter shape — how many body values, whether the header
        // is media, which buttons need a value — so a stale copy builds the
        // wrong wire payload and Meta rejects every send with 132000.
        //
        // The webhook body doesn't carry enough to rebuild a row safely, so this
        // event asks for a catalog refetch rather than trying to patch in place.
        if (change.field === "message_template_components_update") {
          emit({
            kind: "template_components_changed",
            ...(value.message_template_id != null
              ? { externalId: String(value.message_template_id) }
              : {}),
            ...(value.message_template_name ? { name: value.message_template_name } : {}),
            rawPayload: payload as Record<string, unknown>,
          });
          continue;
        }

        // Template category migration: Meta auto-moved a template between
        // categories (e.g. MARKETING→UTILITY). Category drives pricing + which
        // window reopens the conversation, so keep the local row accurate rather
        // than showing a stale category until the next manual Sync.
        if (change.field === "template_category_update") {
          const evt = parseTemplateCategoryUpdate(value, payload as Record<string, unknown>);
          if (evt) emit({ ...evt, ...(wabaId ? { wabaId } : {}) });
          continue;
        }

        // Marketing opt-out / opt-in. Meta reports when a WhatsApp user stops (or
        // resumes) marketing messages from this business. Ingest applies it to
        // Contact.marketingOptOutAt, which the broadcast audience resolver then
        // suppresses on. Dropped entirely before this existed.
        if (change.field === "user_preferences") {
          for (const pref of value.user_preferences ?? []) {
            const waId = pref.wa_id;
            const val = pref.value?.toLowerCase();
            if (!waId || (val !== "stop" && val !== "resume")) continue;
            // Category gate, consent-safe in both directions. Meta has already
            // renamed this once (docs said "marketing", the reference now says
            // "marketing_messages"), so a prefix match accepts both spellings
            // — never-tighten. But an ABSENT match must skip: this event
            // clears opt-outs on "resume", and clearing a MARKETING opt-out
            // off some future non-marketing category would be a consent
            // violation. Absent category (older payloads) passes.
            const category = pref.category?.trim().toLowerCase();
            if (category && !category.startsWith("marketing")) {
              console.warn(
                JSON.stringify({
                  event: "meta.user_preferences.unknown_category",
                  severity: "info",
                  category,
                }),
              );
              continue;
            }
            emit({
              kind: "marketing_preference",
              contactPhone: waId.replace(/\D/g, ""),
              optedOut: val === "stop",
              timestamp: pref.timestamp
                ? new Date(Number(pref.timestamp) * 1000)
                : new Date(),
              rawPayload: payload as Record<string, unknown>,
            });
          }
          continue;
        }

        // Number messaging-health: Meta pushes the phone number's messaging-limit
        // TIER (how many unique customers it may message per 24h) via
        // `phone_number_quality_update` (`current_limit`) and
        // `business_capability_update` (`max_daily_conversation_per_phone`).
        // Ingesting them keeps the cached snapshot fresh so a large template
        // broadcast is gated on the number's real capacity. `account_alerts` is
        // a generic envelope with no reliable tier — the periodic Graph poll
        // covers that. All three fell through the gate below (silently dropped)
        // before this block.
        // `account_update` joins them because it carries calling ENFORCEMENT —
        // an early quality warning, or an active ~7-day pause on calling during
        // which every call and permission request fails. Storing it is what
        // turns "calling randomly stopped working" into a dated explanation.
        // `account_review_update` rides the same channel: its decision gates
        // whether the WHOLE WABA may use the API at all (REJECTED / PENDING /
        // DEFERRED = no sends), and the last-alert slot is WABA-scoped in
        // persistWhatsappHealth, so the verdict lands on every number under it.
        if (
          change.field === "phone_number_quality_update" ||
          change.field === "business_capability_update" ||
          change.field === "account_update" ||
          change.field === "account_alerts" ||
          change.field === "account_review_update" ||
          // Two-step-verification PIN events — per-number security signals
          // the operator must see (an unexpected reset is the takeover tell).
          change.field === "security"
        ) {
          const evt = parseChannelHealthUpdate(
            change.field,
            value,
            payload as Record<string, unknown>,
          );
          if (evt) {
            emit({
              ...evt,
              ...(wabaId ? { wabaId } : {}),
              // Per-number webhooks name their subject flat on `value` — the
              // attribution hint ingest digit-matches against stored configs.
              ...(value.display_phone_number
                ? { displayPhoneNumber: value.display_phone_number }
                : {}),
            });
          }
          continue;
        }

        // The number's @username changed (`business_username_updates`) —
        // adopted, renamed, deleted, or force-transferred onto/off this
        // number. Handled as a channel_health partial (the username is
        // per-NUMBER state, like quality), carrying the same display-number/
        // WABA attribution hints as its siblings. The documented value is
        // `{display_phone_number, username, status}` with status
        // approved | reserved | deleted — and on `deleted` the username field
        // is OMITTED, so the status is load-bearing: storing the payload's
        // username on a deleted/unknown status would re-assert a handle the
        // event just revoked.
        if (change.field === "business_username_updates") {
          const rawUsername =
            (typeof value.username === "string" ? value.username : undefined) ??
            (typeof value.business_username === "string"
              ? value.business_username
              : undefined);
          const username = rawUsername?.trim().toLowerCase();
          const status =
            typeof value.status === "string"
              ? value.status.trim().toLowerCase()
              : undefined;
          const attribution = {
            ...(wabaId ? { wabaId } : {}),
            ...(value.display_phone_number
              ? { displayPhoneNumber: value.display_phone_number }
              : {}),
          };
          if (status === "deleted") {
            // Deleted via the Business app / WhatsApp Manager, or force-
            // transferred onto a sibling number — clear the stored handle.
            emit({
              kind: "channel_health",
              businessUsername: null,
              ...attribution,
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedChannelHealth);
          } else if (
            username &&
            (status === undefined || status === "approved" || status === "reserved")
          ) {
            // `approved` = live and visible; `reserved` = held for this number
            // until the feature launches (pre-GA every adoption lands here).
            // Both mean "this number's adopted handle", which is exactly what
            // the stored column means — the settings GET read-through caches
            // reserved handles the same way. A missing status is tolerated as
            // an adopt (earlier payload generations carried no status).
            emit({
              kind: "channel_health",
              businessUsername: username,
              ...attribution,
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedChannelHealth);
          } else {
            // Unrecognized shape (unknown status, or a recognized status with
            // no username). Store nothing rather than storing a guess; the
            // settings read-through re-syncs the stored copy from Graph.
            console.warn(
              JSON.stringify({
                event: "meta.business_username_update_unparsed",
                severity: "info",
                value,
              }),
            );
          }
          continue;
        }

        // Display-name review concluded (`phone_number_name_update`). More
        // than cosmetics: an unapproved name voids the number's certificate,
        // which blocks Cloud API (re)registration — a DECLINED rename used to
        // be invisible (this field fell through the catch-all) and the number
        // silently kept its old name.
        if (change.field === "phone_number_name_update") {
          const decision = value.decision?.trim();
          if (decision) {
            emit({
              kind: "number_name_update",
              decision: decision.toUpperCase(),
              ...(value.display_phone_number
                ? { displayPhoneNumber: value.display_phone_number }
                : {}),
              ...(wabaId ? { wabaId } : {}),
              ...(value.requested_verified_name
                ? { requestedVerifiedName: value.requested_verified_name }
                : {}),
              ...(value.rejection_reason
                ? { rejectionReason: value.rejection_reason }
                : {}),
              rawPayload: payload as Record<string, unknown>,
            });
          }
          continue;
        }

        // Template quality band change (GREEN/YELLOW/RED/UNKNOWN). Not a
        // sendability decision — the pause arrives separately as a status
        // update (PAUSED), which we already ingest — but it is the EARLY
        // warning, and by the time the pause lands the campaign is dead. So it
        // is stored and surfaced, not just logged.
        if (change.field === "message_template_quality_update") {
          const evt = parseTemplateQualityUpdate(
            value,
            payload as Record<string, unknown>,
          );
          if (evt) emit({ ...evt, ...(wabaId ? { wabaId } : {}) });
          continue;
        }

        // --- WhatsApp Coexistence webhooks -------------------------------
        // Emitted only when the number runs on both the Business App and the
        // Cloud API. Each keeps the shared inbox in sync with the owner's
        // phone. Silently dropped before this block existed (the field gate
        // below rejects everything except messages/calls).

        // smb_message_echoes: a message the owner just sent FROM the phone app.
        // `from` is the business, `to` is the customer — so the conversation
        // key is `to`, and we emit an OUTBOUND echo (no authoring agent).
        if (change.field === "smb_message_echoes") {
          for (const m of Array.isArray(value.message_echoes) ? value.message_echoes : []) {
            const externalId = m.id;
            const contactPhone = digitsOnly(m.to);
            if (!externalId || !contactPhone) continue;
            // Owner-side corrections (smb-message-echoes doc): the Business
            // App user revoked/edited a previously-sent message. These are
            // CORRECTIONS to the ORIGINAL row (by its wamid), not new sends —
            // running them through the content walker minted a phantom
            // "unsupported" echo bubble while the agent's copy silently
            // diverged from what the customer actually sees. Same machinery
            // as customer-side revokes, pinned to OUTBOUND rows only.
            if (m.type === "edit" && m.edit?.original_message_id) {
              const newBody = editBody(m.edit.message);
              emit({
                kind: "message_correction",
                action: "edit",
                targetExternalId: m.edit.original_message_id,
                expectedDirection: "out",
                ...(newBody ? { newBody } : {}),
                timestamp: tsFromMeta(m.timestamp),
                rawPayload: payload as Record<string, unknown>,
              } satisfies NormalizedMessageCorrection);
              continue;
            }
            if (m.type === "revoke" && m.revoke?.original_message_id) {
              emit({
                kind: "message_correction",
                action: "delete",
                targetExternalId: m.revoke.original_message_id,
                expectedDirection: "out",
                timestamp: tsFromMeta(m.timestamp),
                rawPayload: payload as Record<string, unknown>,
              } satisfies NormalizedMessageCorrection);
              continue;
            }
            const content = extractMetaMessageContent(m);
            if (!content) continue;
            emit({
              kind: "echo",
              externalId,
              contactPhone,
              body: content.body,
              ...(content.media ? { media: content.media } : {}),
              timestamp: tsFromMeta(m.timestamp),
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedOutboundEcho);
          }
          continue;
        }

        // history: the past-180d backfill. Each thread is one customer
        // (`thread.id` = their number); each message is inbound (from=customer)
        // or an outbound echo (from=business). Chunked across phases — we log
        // progress and let dedup make re-delivery idempotent.
        if (change.field === "history") {
          const businessNumber = digitsOnly(value.metadata?.display_phone_number);
          // Value-level decline: sharing is off, nothing to ingest.
          if (Array.isArray(value.errors) && value.errors.some((e) => e.code === HISTORY_DECLINED_CODE)) {
            console.warn(
              JSON.stringify({ event: "coexistence.history_declined", severity: "info" }),
            );
            continue;
          }
          for (const h of Array.isArray(value.history) ? value.history : []) {
            if (Array.isArray(h.errors) && h.errors.some((e) => e.code === HISTORY_DECLINED_CODE)) {
              console.warn(
                JSON.stringify({ event: "coexistence.history_declined", severity: "info" }),
              );
              continue;
            }
            console.log(
              JSON.stringify({
                event: "coexistence.history_chunk",
                phase: h.metadata?.phase,
                chunkOrder: h.metadata?.chunk_order,
                progress: h.metadata?.progress,
                threads: Array.isArray(h.threads) ? h.threads.length : 0,
              }),
            );
            for (const thread of Array.isArray(h.threads) ? h.threads : []) {
              const threadPhone = digitsOnly(thread.id);
              for (const m of Array.isArray(thread.messages) ? thread.messages : []) {
                const externalId = m.id;
                if (!externalId) continue;
                const content = extractMetaMessageContent(m);
                if (!content) continue;
                const ts = tsFromMeta(m.timestamp);
                const fromDigits = digitsOnly(m.from);
                // DIRECTION, and it must not fail open.
                //
                // `metadata.display_phone_number` is OPTIONAL in the payload
                // type. When it was absent, `isBusinessSent` was false for
                // every message in the backfill — so the owner's own replies
                // were ingested as INBOUND. That is not merely a cosmetic
                // mislabel: `direction: "in"` stamps `Contact.lastInboundAt`,
                // which OPENS the 24h customer-service window in the UI when
                // it is actually closed. The composer then accepts a
                // free-form reply that Meta rejects.
                //
                // The thread id IS the customer's number, so direction is
                // inferable without the metadata at all: anything not from
                // the customer came from us. Use the business number when we
                // have it (most precise), else fall back to the thread.
                const isBusinessSent = businessNumber
                  ? fromDigits === businessNumber
                  : threadPhone
                    ? fromDigits !== threadPhone
                    : null;
                if (isBusinessSent === null) {
                  // Neither signal available — we genuinely cannot tell who
                  // sent this. DROP it rather than guess: a wrong guess
                  // corrupts the send window, while a missing history message
                  // is merely missing.
                  console.warn(
                    JSON.stringify({
                      event: "coexistence.history_direction_unknown",
                      severity: "warn",
                      externalId,
                    }),
                  );
                  continue;
                }
                // Customer number: prefer the thread id; else the non-business
                // endpoint of the message (`to` for echoes, `from` for inbound).
                const contactPhone =
                  threadPhone ?? (isBusinessSent ? digitsOnly(m.to) : fromDigits);
                if (!contactPhone) continue;
                if (isBusinessSent) {
                  const historyStatus = mapHistoryStatus(m.history_context?.status);
                  emit({
                    kind: "echo",
                    externalId,
                    contactPhone,
                    body: content.body,
                    ...(content.media ? { media: content.media } : {}),
                    ...(historyStatus ? { status: historyStatus } : {}),
                    timestamp: ts,
                    rawPayload: payload as Record<string, unknown>,
                  } satisfies NormalizedOutboundEcho);
                } else {
                  emit({
                    kind: "message",
                    externalId,
                    contactPhone,
                    contactName: null,
                    body: content.body,
                    ...(content.media ? { media: content.media } : {}),
                    timestamp: ts,
                    rawPayload: payload as Record<string, unknown>,
                  } satisfies NormalizedInboundMessage);
                }
              }
            }
          }
          // The ≤14-day MEDIA FOLLOW-UPS (history reference, second example):
          // Meta re-sends a media message's real contents as `field:"history"`
          // with a plain `value.messages` array — NOT under `value.history`.
          // This branch used to walk `value.history` only, so every follow-up
          // was dropped and the "📎 Media" placeholder never had a chance to
          // resolve (the placeholder's own comment believed these dedupe
          // against it; they never arrived). Same direction rule as above:
          // the business number is the sender for echoes.
          for (const m of Array.isArray(value.messages) ? value.messages : []) {
            const externalId = m.id;
            if (!externalId) continue;
            const content = extractMetaMessageContent(m);
            if (!content) continue;
            const ts = tsFromMeta(m.timestamp);
            const fromDigits = digitsOnly(m.from);
            const toDigits = digitsOnly(m.to);
            const isBusinessSent = businessNumber
              ? fromDigits === businessNumber
              : toDigits !== undefined; // `to` is only present on echo shapes
            const contactPhone = isBusinessSent ? toDigits : fromDigits;
            if (!contactPhone) continue;
            if (isBusinessSent) {
              const historyStatus = mapHistoryStatus(m.history_context?.status);
              emit({
                kind: "echo",
                externalId,
                contactPhone,
                body: content.body,
                ...(content.media ? { media: content.media } : {}),
                ...(historyStatus ? { status: historyStatus } : {}),
                timestamp: ts,
                rawPayload: payload as Record<string, unknown>,
              } satisfies NormalizedOutboundEcho);
            } else {
              emit({
                kind: "message",
                externalId,
                contactPhone,
                contactName: null,
                body: content.body,
                ...(content.media ? { media: content.media } : {}),
                timestamp: ts,
                rawPayload: payload as Record<string, unknown>,
              } satisfies NormalizedInboundMessage);
            }
          }
          continue;
        }

        // smb_app_state_sync: the owner's phone address book changed. We use it
        // only to NAME contacts that already exist (see ingestContactSync).
        if (change.field === "smb_app_state_sync") {
          for (const s of Array.isArray(value.state_sync) ? value.state_sync : []) {
            if (s.type !== "contact" || !s.contact) continue;
            const phone = digitsOnly(s.contact.phone_number);
            if (!phone) continue;
            emit({
              kind: "contact_sync",
              phone,
              fullName: s.contact.full_name?.trim() || null,
              action: s.action === "remove" ? "remove" : "add",
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedContactSync);
          }
          continue;
        }

        // Meta uses two relevant `field` values for content:
        //   "messages" — text / media / interactive / status updates
        //   "calls"    — voice call lifecycle (offer, answer, terminate, ICE,
        //                permission granted/revoked, etc.) — confirmed by
        //                live webhook payloads 2026-05-29.
        // We accept both; the per-array walkers below safely no-op on the
        // other type since `value.messages` / `value.calls` / `value.statuses`
        // are independently present.
        if (change.field !== "messages" && change.field !== "calls") {
          // Fields we KNOW about and deliberately do not consume. Dropped
          // quietly, because each one Meta has us subscribed to would otherwise
          // emit an unhandled-field warn on every delivery and drown the signal
          // the warn below exists for: a genuinely NEW field.
          //
          // That was not hypothetical. `devtools_webhook_list{list_topics}` on
          // 2026-07-30 showed our apps subscribed to 13 fields with no handler,
          // so the tripwire was firing constantly and had stopped meaning
          // anything. Each entry below is a decision, reviewed against its own
          // doc page — not a blanket silence:
          if (change.field && QUIET_DROP_WHATSAPP_FIELDS.has(change.field)) continue;
          // Everything above is handled; anything else Meta subscribed us to
          // (account/phone-number quality alerts, flows, etc.) is dropped — but
          // logged so a NEW field type Meta starts sending surfaces in ops
          // instead of vanishing silently. Fail-soft: still a 200.
          console.warn(
            JSON.stringify({
              event: "meta.webhook.unhandled_field",
              severity: "info",
              object: "whatsapp_business_account",
              field: change.field,
            }),
          );
          continue;
        }

        // MM-API click events ride the SAME `messages` field as everything
        // else, as a `user_actions` array. This platform doesn't use MM API
        // (maintainer decision), so they're dropped — but their PRESENCE means
        // a tenant signed the MM ToS in WhatsApp Manager out-of-band, which is
        // worth an ops trace instead of a silent vanish.
        if (Array.isArray((value as { user_actions?: unknown }).user_actions)) {
          console.warn(
            JSON.stringify({
              event: "meta.mm_api_user_action_dropped",
              note: "MM-API click webhook received — a tenant WABA appears to be onboarded to MM API; this platform sends via Cloud API only",
            }),
          );
        }

        // `value.errors[]` is Meta's third error surface (besides per-message
        // `messages[].errors` on `type:"unsupported"` and per-status
        // `statuses[].errors`): system-, app- and account-level errors. When it
        // rides alongside `calls[]` it is the call-failure reason and
        // parseMetaCall consumes it below; standalone it announces an
        // account/app problem (rate limit, restriction) that yields NO events —
        // without this trace the controller 200s `{ingested: 0}` and the only
        // signal Meta will ever send about the problem vanishes silently.
        if (
          Array.isArray(value.errors) &&
          value.errors.length > 0 &&
          !(Array.isArray(value.calls) && value.calls.length > 0)
        ) {
          for (const e of value.errors) {
            console.warn(
              JSON.stringify({
                event: "meta.webhook.value_error",
                code: e.code,
                title: e.title,
                detail: e.error_data?.details ?? e.message,
              }),
            );
          }
          // Also PERSIST the batch's first error as the number's last-alert:
          // a warn log is invisible to the tenant, and this surface includes
          // real data loss — 131035 (No-Storage numbers: an inbound message
          // Meta dropped because our webhook was unreachable past the 1-hour
          // retention; the customer's message is gone and this is the ONLY
          // signal), rate limits, account problems. Number-attributed via the
          // metadata hint below. 131035 gets an operator sentence; other
          // codes carry Meta's own title/detail.
          const first = value.errors[0]!;
          emit({
            kind: "channel_health",
            phoneNumberId: value.metadata?.phone_number_id,
            displayPhoneNumber: value.metadata?.display_phone_number,
            accountAlert: {
              source: "webhook_errors",
              event: first.code != null ? String(first.code) : null,
              detail:
                first.code === 131035
                  ? "An incoming message was permanently dropped: this number has No-Storage " +
                    "retention and the webhook could not be delivered within its 1-hour limit. " +
                    "The customer's message cannot be recovered — check webhook uptime."
                  : `${first.title ?? "webhook error"}: ${first.error_data?.details ?? first.message ?? ""}`.slice(0, 400),
            },
            rawPayload: payload as Record<string, unknown>,
          });
        }

        // `contacts[]` — not `messages[]` — is where Meta puts the customer's
        // identity: display name, the business-scoped user id (`user_id`, the
        // BSUID) and the optional WhatsApp `username`. Index by BOTH keys: since
        // the 2026 rollout Meta omits `wa_id` for a contact we haven't messaged
        // in 30 days, and then `messages[].from` is the BSUID instead.
        const contactByKey = new Map<string, MetaContact>();
        for (const c of Array.isArray(value.contacts) ? value.contacts : []) {
          if (c.wa_id) contactByKey.set(c.wa_id.replace(/\D/g, ""), c);
          if (c.user_id) contactByKey.set(c.user_id, c);
        }

        for (const m of Array.isArray(value.messages) ? value.messages : []) {
          // GROUP message — not a 1:1 conversation, and not ours to ingest.
          //
          // Meta's Groups API delivers group posts on the SAME `messages` field as
          // direct messages, and the ONLY thing that distinguishes them is
          // `messages[].group_id`: `from` is the participant's phone and
          // `contacts[0].wa_id` is that same participant ("The from field in the
          // message object and the contact object point to the same participant"),
          // so a group post is byte-indistinguishable from a DM unless this field
          // is read.
          //
          // Unread, ingesting one fabricated a direct conversation with a person
          // who never messaged us: it opened their 24h window, raised unread,
          // fired assignment/SLA/workflows, and an agent answering the group's
          // question would have replied PRIVATELY (we always send
          // `recipient_type: "individual"`) while the group saw nothing. On a
          // Coexistence number — still used in the WhatsApp Business app, so
          // typically already in groups — that is ordinary group chatter flooding
          // the inbox as customer inquiries.
          //
          // Dropped rather than modelled: a group is a different conversation
          // primitive (many participants, no per-person window) and we have no
          // Group entity. Logged, not silent, so this becomes visible the moment
          // it starts happening — same treatment as social `standby[]`.
          // TRIGGER to revisit: a pilot asks for group inboxes, which means a
          // Group entity + the four `group_*` metadata subscriptions.
          if (typeof m.group_id === "string" && m.group_id.length > 0) {
            console.warn(
              JSON.stringify({
                event: "meta.webhook.group_message_dropped",
                severity: "info",
                groupId: m.group_id,
                messageId: m.id ?? null,
                note: "WhatsApp group message; no Group model — not ingested as a 1:1 thread",
              }),
            );
            continue;
          }
          const externalId = m.id;
          const rawFrom = typeof m.from === "string" ? m.from.trim() : "";
          // A wa_id is digits-only by spec; a BSUID is prefixed and dotted
          // ("LB.946402411360800"). Never digit-strip a BSUID — that would mint
          // a bogus phone number and create a contact under a fake identity.
          // A phone `from` is all digits; tolerate the doc's leading "+"
          // (`+16505551234`) by stripping it before the digit test so a plus-
          // prefixed number isn't misclassified as a BSUID (phone is stored
          // digits-only elsewhere anyway).
          const phoneDigits = rawFrom.replace(/^\+/, "");
          const fromIsPhone = phoneDigits.length > 0 && !/\D/.test(phoneDigits);
          const phone = fromIsPhone ? phoneDigits : undefined;
          // `contactByKey` is keyed by DIGIT-STRIPPED wa_id / verbatim user_id,
          // so the lookup key must match that normalization: a plus-prefixed
          // `from` (`+16505551234` — documented verbatim in the unsupported-
          // messages reference) looked up raw missed the digit-stripped entry
          // and silently dropped the profile-name/username enrichment. An
          // EMPTY `from` misses the map entirely — fall back to the sole
          // `contacts[]` entry, which is where the identity still is. Meta
          // empties/omits BOTH `from` and `contacts[].wa_id` for a customer
          // who adopted a @username outside the 30-day phone window.
          const contact =
            contactByKey.get(fromIsPhone ? phoneDigits : rawFrom) ??
            (rawFrom ? undefined : value.contacts?.[0]);
          // Resolve the BSUID the same way the CALL path does (see `parseMetaCall`):
          // `from` when it is itself the BSUID, else the dedicated message-level
          // field, else `contacts[]`. Reading only the first of those dropped a
          // username-adopter's message outright — no row, no unread, no 24h window,
          // and a 200 that stops Meta ever redelivering it.
          const bsuid =
            (!fromIsPhone && rawFrom ? rawFrom : undefined) ||
            m.from_user_id?.trim() ||
            contact?.user_id?.trim() ||
            undefined;
          // Documented location is `profile.username`; the top-level read is wire
          // tolerance only (see MetaContact).
          const username = contact?.profile?.username?.trim() || contact?.username?.trim() || undefined;
          if (!externalId || (!phone && !bsuid)) continue;
          const contactName = contact?.profile?.name ?? null;
          // Parent BSUID (cross-portfolio key, "US.ENT.…") — message-level
          // field first, contacts[] mirror second, same layering as bsuid.
          const parentBsuid =
            m.from_parent_user_id?.trim() ||
            contact?.parent_user_id?.trim() ||
            undefined;
          // `profile.country_code` (BSUID rollout, "subject to change") — the
          // only country signal a phone-less contact has; ingest lets a
          // phone-derived country win over it.
          const profileCountryCode = contact?.profile?.country_code?.trim() || undefined;
          // Shared identity fragment spread into every inbound-message emit
          // below (exactly one of phone/bsuid/parentBsuid is the resolve key
          // at ingest).
          const identity = {
            ...(phone ? { contactPhone: phone } : {}),
            ...(bsuid ? { bsuid } : {}),
            ...(parentBsuid ? { parentBsuid } : {}),
            ...(username ? { username } : {}),
            ...(profileCountryCode ? { countryCode: profileCountryCode } : {}),
          };
          // Click-to-WhatsApp ad attribution (only on the first ad-sourced
          // inbound) — spread into the content emits so the "from your ad" chip
          // renders on whichever message type carried the referral.
          const attribution = attributionForMessage(m);
          const attributionSpread = attribution ? { attribution } : {};

          const tsSecs = m.timestamp ? Number(m.timestamp) : NaN;
          const ts = Number.isFinite(tsSecs) ? new Date(tsSecs * 1000) : new Date();

          // Customer changed their WhatsApp number (`type:"system"`). Migrate the
          // existing contact to the NEW number (`system.wa_id`) so their thread
          // CONTINUES instead of forking into a second contact/conversation when
          // they next message. `from` (= `phone` here) is the OLD number.
          if (m.type === "system" && m.system?.type === "user_changed_number") {
            const newPhone = m.system.wa_id?.replace(/^\+/, "").trim();
            if (phone && newPhone && /^\d+$/.test(newPhone) && newPhone !== phone) {
              emit({
                kind: "contact_number_change",
                oldPhone: phone,
                newPhone,
                rawPayload: payload as Record<string, unknown>,
              });
            }
            continue;
          }

          // Customer EDITED or UNSENT (revoked) a prior message — a correction,
          // not a new message. Match is EXACT (`original_message_id` = the target
          // wamid), so ingest rewrites/tombstones precisely that row. Checked
          // BEFORE the content branches. (Best-effort on the Cloud API; honoured
          // when delivered — mirrors the Messenger/IG `is_deleted` path.)
          if (m.type === "edit" && m.edit?.original_message_id) {
            const newBody = editBody(m.edit.message);
            emit({
              kind: "message_correction",
              action: "edit",
              targetExternalId: m.edit.original_message_id,
              ...(newBody ? { newBody } : {}),
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedMessageCorrection);
            continue;
          }
          if (m.type === "revoke" && m.revoke?.original_message_id) {
            emit({
              kind: "message_correction",
              action: "delete",
              targetExternalId: m.revoke.original_message_id,
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedMessageCorrection);
            continue;
          }

          // Pre-extract the optional reply context so both text + media branches
          // share the same shape. Meta sends `context.id` as the wamid of the
          // original; we round-trip the wamid and let ingest resolve to our id.
          const replyToExternalId = m.context?.id;

          if (m.type === "text") {
            const body = m.text?.body;
            if (!body) continue;
            emit({
              kind: "message",
              externalId,
              ...identity,
              contactName,
              body,
              ...attributionSpread,
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
              ...(replyToExternalId ? { replyToExternalId } : {}),
            } satisfies NormalizedInboundMessage);
            continue;
          }

          // Interactive reply: the contact tapped a button or list row on a
          // previous outbound interactive message. The author-assigned id
          // round-trips back as `interactive.button_reply.id` (or
          // `list_reply.id`); the displayed text comes back as `title`.
          // We fold the title into `body` for uniform search + preview AND
          // surface the structured payload via `interactiveReply` for the
          // ask_question step to route on.
          if (m.type === "interactive") {
            const inner = m.interactive;
            // Call-permission decision. Must be checked BEFORE the generic
            // fallback below, which would otherwise turn the customer's
            // "Allow calls" into a meaningless "💬 Interactive reply" bubble
            // and leave the permission itself unrecorded.
            if (
              inner?.type === "call_permission_reply" &&
              inner.call_permission_reply
            ) {
              const permEvent = parseMetaCallPermissionReply(
                inner.call_permission_reply,
                identity,
                contactName,
                // context.id is the request message we sent (or, for a callback
                // grant, the missed call that triggered it).
                replyToExternalId,
                ts,
                payload as Record<string, unknown>,
              );
              if (permEvent) emit(permEvent);
              continue;
            }
            if (inner?.type === "button_reply" && inner.button_reply) {
              // Both fields round-trip from our own outbound message, so both
              // should always be present — but a tap must never be droppable on
              // one going missing (we 200; a drop is permanent). Same fallback
              // as the template quick-reply branch below.
              const optId = inner.button_reply.id?.trim() || inner.button_reply.title?.trim();
              const title = inner.button_reply.title?.trim() || inner.button_reply.id?.trim();
              if (!optId || !title) continue;
              emit({
                kind: "message",
                externalId,
                ...identity,
                contactName,
                body: title,
                interactiveReply: { kind: "button_reply", id: optId, title },
                timestamp: ts,
                rawPayload: payload as Record<string, unknown>,
                ...(replyToExternalId ? { replyToExternalId } : {}),
              } satisfies NormalizedInboundMessage);
              continue;
            }
            if (inner?.type === "list_reply" && inner.list_reply) {
              // Same missing-field fallback as button_reply above. The row
              // `description` is deliberately not captured: it echoes what WE
              // configured on the outbound list (visible just above in-thread),
              // and WhatsApp's own reply bubble shows only the title.
              const optId = inner.list_reply.id?.trim() || inner.list_reply.title?.trim();
              const title = inner.list_reply.title?.trim() || inner.list_reply.id?.trim();
              if (!optId || !title) continue;
              emit({
                kind: "message",
                externalId,
                ...identity,
                contactName,
                body: title,
                interactiveReply: { kind: "list_reply", id: optId, title },
                timestamp: ts,
                rawPayload: payload as Record<string, unknown>,
                ...(replyToExternalId ? { replyToExternalId } : {}),
              } satisfies NormalizedInboundMessage);
              continue;
            }
            // Any other interactive subtype — today most importantly an NFM
            // submission (`nfm_reply`: a WhatsApp Flow, or an address-message
            // form). Persist a row rather than dropping it: we 200 the
            // webhook, so Meta never redelivers, and a bare `continue` loses
            // the customer's submission completely — no message row, no unread
            // bump, no 24h-window reset, not even the raw payload to recover
            // from later. Same contract as placeholderForUnhandledType for
            // location/contacts/order.
            //
            // `nfm_reply.body` is the human-readable summary the CUSTOMER sees
            // in their own chat (for an address form: the actual address), so
            // when Meta sends it, the agent reads the real content instead of
            // a "📝 Form response" placeholder. The structured field data
            // (`response_json`) stays recoverable in rawPayload.
            const nfmBody =
              inner?.type === "nfm_reply" ? inner.nfm_reply?.body?.trim() : undefined;
            emit({
              kind: "message",
              externalId,
              ...identity,
              contactName,
              body:
                nfmBody ||
                (inner?.type === "nfm_reply" ? "📝 Form response" : "💬 Interactive reply"),
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
              ...(replyToExternalId ? { replyToExternalId } : {}),
            } satisfies NormalizedInboundMessage);
            continue;
          }

          // Template quick-reply tap: a customer tapped a QUICK_REPLY button on
          // an approved template we sent. Arrives as `type:"button"` with
          // `button.payload` = the author-assigned id + `button.text` = the label.
          // Without this branch it fell through to the "unsupported message"
          // placeholder — losing the payload the ask_question step routes on.
          // Emit a structured button_reply, parity with interactive replies.
          if (m.type === "button") {
            // Meta defaults `payload` to the label text when the template author
            // set no id, so it should always be present — but a tap must never
            // be droppable on that guarantee (we 200; a drop is permanent).
            // Mirror Meta's own fallback in both directions.
            const payloadId = m.button?.payload?.trim() || m.button?.text?.trim();
            const title = m.button?.text?.trim() || m.button?.payload?.trim() || "";
            if (!payloadId) continue;
            emit({
              kind: "message",
              externalId,
              ...identity,
              contactName,
              body: title,
              interactiveReply: { kind: "button_reply", id: payloadId, title },
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
              ...(replyToExternalId ? { replyToExternalId } : {}),
            } satisfies NormalizedInboundMessage);
            continue;
          }

          // Inbound emoji reactions (m.type === "reaction", payload
          // `m.reaction = { message_id, emoji }`). The customer reacted to one
          // of our messages; `message_id` is that message's wamid. A REMOVAL
          // arrives as another reaction webhook with `emoji` OMITTED entirely
          // (per the reaction webhook reference) — we also tolerate an empty
          // string; both normalize to emoji:null. Ingest resolves the target by
          // wamid and patches its `reaction` column. We never create a Message
          // row for the reaction itself.
          if (m.type === "reaction") {
            const targetExternalId = m.reaction?.message_id;
            if (!targetExternalId) continue;
            const rawEmoji = m.reaction?.emoji;
            emit({
              kind: "reaction",
              externalId,
              targetExternalId,
              emoji: rawEmoji && rawEmoji.length > 0 ? rawEmoji : null,
              contactPhone: phone,
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
            } satisfies NormalizedReaction);
            continue;
          }

          // Media: image / video / audio / document / sticker. Each has its
          // own subobject with id, mime_type, optional caption + filename.
          const mediaKind = m.type as MediaKind | undefined;
          if (!mediaKind || !META_MEDIA_TYPES.includes(mediaKind)) {
            // Non-media, non-text, non-interactive customer content: location
            // pins, contact cards, orders, and Meta's `unsupported` fallback.
            // Ingest as a text placeholder so unread / 24h-window / list preview
            // stay correct and the raw payload is preserved (the webhook returns
            // 200, so Meta never redelivers — dropping these loses them forever).
            const placeholder = placeholderForUnhandledType(m);
            if (!placeholder) continue;
            // Location pins + contact cards additionally carry structured data
            // for a dedicated bubble (map pin / vCard). The placeholder body
            // stays for search / list preview / unread.
            const structured = structuredForMessage(m);
            emit({
              kind: "message",
              externalId,
              ...identity,
              contactName,
              body: placeholder,
              ...(structured ? { structured } : {}),
              ...attributionSpread,
              timestamp: ts,
              rawPayload: payload as Record<string, unknown>,
              ...(replyToExternalId ? { replyToExternalId } : {}),
            } satisfies NormalizedInboundMessage);
            continue;
          }
          const mediaPayload = m[mediaKind] as MetaMediaPayload | undefined;
          if (!mediaPayload?.id || !mediaPayload.mime_type) continue;

          const media: NormalizedMediaRef = {
            kind: mediaKind,
            externalMediaId: mediaPayload.id,
            mimeType: mediaPayload.mime_type,
            ...(mediaPayload.filename ? { filename: mediaPayload.filename } : {}),
            ...(mediaPayload.duration
              ? { durationMs: mediaPayload.duration * 1000 }
              : {}),
            // WhatsApp voice notes arrive as audio with `voice: true` — flag it
            // so the bubble shows the mic / "Voice message" affordance instead
            // of the generic audio-file player.
            ...(mediaKind === "audio" && mediaPayload.voice ? { voice: true } : {}),
          };

          emit({
            kind: "message",
            externalId,
            ...identity,
            contactName,
            // Caption goes into body so search + previews stay uniform.
            body: mediaPayload.caption ?? "",
            media,
            ...attributionSpread,
            timestamp: ts,
            rawPayload: payload as Record<string, unknown>,
            ...(replyToExternalId ? { replyToExternalId } : {}),
          } satisfies NormalizedInboundMessage);
        }

        for (const c of Array.isArray(value.calls) ? value.calls : []) {
          const evt = parseMetaCall(
            c,
            payload as Record<string, unknown>,
            Array.isArray(value.contacts) ? value.contacts : [],
            // Sits alongside `calls[]` on a FAILED terminate and is the only
            // place Meta says WHY the call failed.
            Array.isArray(value.errors) ? value.errors : undefined,
          );
          if (!evt) continue;
          emit(evt);
        }

        for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
          // `statuses[]` is overloaded: `type: "call"` rows are CALL progress
          // (RINGING/ACCEPTED/REJECTED), everything else is message delivery.
          // Routing the whole array into the message-status path below silently
          // dropped every call status, including `ACCEPTED` — the one
          // authoritative "the customer picked up" signal Meta sends.
          if (s.type === "call") {
            const callEvt = parseMetaCallStatus(
              s,
              payload as Record<string, unknown>,
            );
            if (callEvt) emit(callEvt);
            continue;
          }
          const status = mapMetaStatus(s.status);
          // Surface WHY Meta failed delivery — otherwise a `failed` status is a
          // silent red icon with no reason. These are the (#13xxxx) codes from
          // Meta's status webhook (rate/quality limits, undeliverable, etc.).
          // First error wins for the persisted reason (Meta sends one per status
          // in practice); we still log every error for forensics.
          let errorCode: number | undefined;
          let errorTitle: string | undefined;
          let errorDetail: string | undefined;
          if (status === "failed" && s.errors?.length) {
            for (const e of s.errors) {
              console.error(
                `[meta] message ${s.id} delivery FAILED: (#${e.code ?? "?"}) ${
                  e.title ?? ""
                } — ${e.error_data?.details ?? e.message ?? "no detail"}`,
              );
            }
            const first = s.errors[0];
            if (typeof first?.code === "number") errorCode = first.code;
            if (first?.title) errorTitle = first.title;
            // Prefer the actionable error_data.details, fall back to message.
            const detail = first?.error_data?.details ?? first?.message;
            if (detail) errorDetail = detail;
          }
          if (!status || !s.id) continue;
          const tsSecs = s.timestamp ? Number(s.timestamp) : NaN;
          const ts = Number.isFinite(tsSecs) ? new Date(tsSecs * 1000) : new Date();
          const evt: NormalizedStatusUpdate = {
            kind: "status",
            externalId: s.id,
            status,
            ...(errorCode !== undefined ? { errorCode } : {}),
            ...(errorTitle !== undefined ? { errorTitle } : {}),
            ...(errorDetail !== undefined ? { errorDetail } : {}),
            // Billing metadata, when Meta attached it (normally on `sent`).
            // Narrow, named shape rather than the raw Meta object: the provider
            // layer's job is to translate wire shapes, and NormalizedStatusUpdate
            // is a cross-channel contract that must not grow WhatsApp blobs.
            ...(s.pricing
              ? {
                  pricing: {
                    // `billable` is deprecated in a future Graph version; when
                    // absent, derive it from `type` ("regular" bills, the two
                    // free_* values don't) so campaign billing counts keep
                    // working after Meta drops the boolean.
                    ...(typeof s.pricing.billable === "boolean"
                      ? { billable: s.pricing.billable }
                      : s.pricing.type
                        ? { billable: s.pricing.type === "regular" }
                        : {}),
                    ...(s.pricing.category ? { category: s.pricing.category } : {}),
                    ...(s.pricing.pricing_model ? { model: s.pricing.pricing_model } : {}),
                    // Kept as well as consumed: `type` is what explains a FREE
                    // message ("inside the service window") rather than just
                    // asserting it wasn't charged.
                    ...(s.pricing.type ? { type: s.pricing.type } : {}),
                  },
                }
              : {}),
            // The wa_id Meta actually delivered to. When it differs from the
            // number we dialed (Brazil/Mexico digit normalization), ingest
            // re-keys/links the contact so the reply threads correctly — see
            // NormalizedStatusUpdate.recipientId. Digits-gated: a malformed
            // value must not masquerade as a phone identity. Group statuses are
            // excluded outright — there `recipient_id` is the GROUP id, which
            // can be purely numeric and would otherwise pass the digits gate
            // and re-key a contact onto a group id.
            ...(s.recipient_type !== "group" &&
            s.recipient_id &&
            /^\d{8,15}$/.test(s.recipient_id.trim())
              ? { recipientId: s.recipient_id.trim() }
              : {}),
            // The recipient's BSUID — present on every message status once the
            // rollout reaches the account, even for phone sends. Shape-gated
            // the inverse way of recipientId: a BSUID is `<ISO>.<digits>`
            // (parent: `<ISO>.ENT.<digits>`), NEVER digits-only, so a bare
            // number can't masquerade as one; group traffic excluded like
            // recipientId above. Ingest backfills Contact.bsuid off this —
            // the pre-emptive join that beats the 30-day window closing.
            ...(s.recipient_type !== "group" &&
            s.recipient_user_id &&
            /^[A-Za-z]{2}\.(?:ENT\.)?\w+$/.test(s.recipient_user_id.trim())
              ? { recipientBsuid: s.recipient_user_id.trim() }
              : {}),
            ...(s.recipient_type !== "group" &&
            s.recipient_parent_user_id &&
            /^[A-Za-z]{2}\.ENT\.\w+$/.test(s.recipient_parent_user_id.trim())
              ? { recipientParentBsuid: s.recipient_parent_user_id.trim() }
              : {}),
            timestamp: ts,
            rawPayload: payload as Record<string, unknown>,
          };
          emit(evt);
        }
      }
    }

    return events;
  },

  async sendText(args: SendTextArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // No `retry:` — customer-visible /messages sends are NON-idempotent (Meta
    // assigns the wamid, there's no client idempotency key), so a metaFetch
    // 5xx/timeout retry could deliver the same message twice. The worker-level
    // OutboundSendAttempt guard owns the retry/refuse decision (it classifies
    // rate_limited / 5xx as recoverable). Same for sendInteractive/sendMedia/
    // sendTemplate below and placeCall.
    const res = await postWhatsappMessages(url, config, {
        messaging_product: "whatsapp",
        ...messagingAccountField(config),
        recipient_type: "individual",
        ...whatsappDestination(args),
        type: "text",
        // `preview_url` renders a link-preview card for the first URL in the
        // body. Auto-enabled when the body contains an http(s) link (caller can
        // force it either way). Meta ignores it when there's no URL.
        text: {
          body: args.body,
          preview_url: args.previewUrl ?? /https?:\/\//i.test(args.body),
        },
        // When replying, include `context` so the customer's WhatsApp shows
        // the quote + jump-to-original behavior. Meta validates the wamid
        // is recent enough; a stale wamid returns error 131xxx.
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      });

    if (!res.ok) {
      // Surface Meta's error body so 24h-window failures (code 131047) and
      // similar policy errors land in our logs verbatim. Caller decides how
      // to render this to the agent.
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta sendText failed: ${res.status} ${text}`, res.status, text);
    }

    const json = (await res.json()) as {
      messages?: Array<{ id?: string; message_status?: string }>;
    };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendText response missing message id: ${JSON.stringify(json)}`);
    }

    // Meta's response doesn't include a server timestamp; we stamp at send.
    return {
      externalId,
      timestamp: new Date(),
      // Meta documents portfolio pacing for TEMPLATE sends. Reading the field
      // here too costs one comparison and means a freeform send that ever gets
      // held is reported honestly rather than as delivered-and-fine.
      ...(isHeldForQualityAssessment(json) ? { heldForQualityAssessment: true } : {}),
    };
  },

  async sendInteractive(
    args: SendInteractiveArgs,
    config: MetaSendConfig,
  ): Promise<SendTextResult> {
    // A call button has no options — it's a single CTA that dials us — so it
    // takes its own short path before the option-count checks below.
    if (args.kind === "voice_call") {
      return sendVoiceCallButton(args, config);
    }
    // A location request has no options either: WhatsApp renders its own
    // "send location" button (location-request-messages doc), and the reply
    // comes back as a normal inbound `location` message with `context`.
    if (args.kind === "location_request") {
      return sendLocationRequest(args, config);
    }
    // A contact-info request likewise: WhatsApp renders its own fixed-label
    // "share contact info" button (request_contact_info, renamed from
    // contact_request 2026-05-28), and the reply comes back as a normal
    // inbound `contacts` card with `origin: "contact_request"`.
    if (args.kind === "request_contact_info") {
      return sendRequestContactInfo(args, config);
    }
    // One URL-opening button (cta-url-messages doc) — configured via
    // `args.ctaUrl`, no authored options.
    if (args.kind === "cta_url") {
      return sendCtaUrlButton(args, config);
    }
    // 2-10 scrollable media cards (interactive-carousel doc) — configured via
    // `args.carouselCards`, no authored options.
    if (args.kind === "carousel") {
      return sendInteractiveCarousel(args, config);
    }

    // Pre-flight option-count check. Meta rejects with a cryptic 132xxx
    // error for "wrong option count"; failing fast with a clear message
    // saves the admin a debugging round-trip.
    if (args.options.length === 0) {
      throw new MetaSendError("sendInteractive: at least one option required", 400, "");
    }
    if (args.kind === "buttons" && args.options.length > 3) {
      throw new MetaSendError(
        "sendInteractive: WhatsApp buttons cap at 3 options — use kind=list for more",
        400,
        "",
      );
    }
    if (args.kind === "list" && args.options.length > 10) {
      throw new MetaSendError("sendInteractive: WhatsApp lists cap at 10 rows", 400, "");
    }

    // Build the interactive payload. Buttons + list share the outer
    // shape; only `interactive.type` + `action` differ.
    const interactive =
      args.kind === "buttons"
        ? {
            type: "button" as const,
            // Optional text header/footer (reply-buttons doc: header may be
            // text/image/video/document — TEXT modeled today; footer ≤60).
            ...(args.headerText
              ? { header: { type: "text" as const, text: args.headerText.slice(0, 60) } }
              : {}),
            body: { text: args.bodyText },
            ...(args.footerText ? { footer: { text: args.footerText.slice(0, 60) } } : {}),
            action: {
              buttons: args.options.map((o) => ({
                type: "reply" as const,
                reply: {
                  // Meta caps button title length at 20 chars + id length at
                  // 256. We rely on the caller / UI to enforce; truncate
                  // defensively to keep a stray long title from causing a
                  // 400 (which would surface in the workflow run as a
                  // generic "send failed").
                  id: o.id.slice(0, 256),
                  title: o.title.slice(0, 20),
                },
              })),
            },
          }
        : {
            type: "list" as const,
            // Optional text header/footer (≤60 each — the list wire supports
            // TEXT headers only, interactive-list-messages doc).
            ...(args.headerText
              ? { header: { type: "text" as const, text: args.headerText.slice(0, 60) } }
              : {}),
            body: { text: args.bodyText },
            ...(args.footerText
              ? { footer: { text: args.footerText.slice(0, 60) } }
              : {}),
            action: {
              button: (args.listCtaLabel ?? "Choose").slice(0, 20),
              sections: [
                {
                  title: (args.listSectionTitle ?? "Options").slice(0, 24),
                  rows: args.options.map((o) => ({
                    // Id caps: Meta's docs split them — BUTTON reply ids cap at
                    // 256, LIST row ids at 200 (interactive-list-messages doc,
                    // 2026-07). We deliberately do NOT truncate to either
                    // number here: truncating at 200 once silently corrupted a
                    // >200-char id, so `list_reply.id` didn't match on reply
                    // and ask_question routing fell through. The 256 slice is
                    // a hard backstop only; the request schemas hold NEW list
                    // ids to 200 at authoring time, where a violation can be
                    // rejected instead of corrupted.
                    id: o.id.slice(0, 256),
                    // List rows: title cap 24, description cap 72.
                    title: o.title.slice(0, 24),
                    ...(o.description
                      ? { description: o.description.slice(0, 72) }
                      : {}),
                  })),
                },
              ],
            },
          };

    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await postWhatsappMessages(url, config, {
        messaging_product: "whatsapp",
        ...messagingAccountField(config),
        recipient_type: "individual",
        ...whatsappDestination(args),
        type: "interactive",
        interactive,
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      });

    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta sendInteractive failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendInteractive response missing message id: ${JSON.stringify(json)}`);
    }
    return { externalId, timestamp: new Date() };
  },

  async sendLocation(args: SendLocationArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await postWhatsappMessages(url, config, {
        messaging_product: "whatsapp",
        ...messagingAccountField(config),
        recipient_type: "individual",
        ...whatsappDestination(args),
        type: "location",
        location: {
          latitude: args.latitude,
          longitude: args.longitude,
          ...(args.name ? { name: args.name } : {}),
          ...(args.address ? { address: args.address } : {}),
        },
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta sendLocation failed: ${res.status} ${text}`, res.status, text);
    }
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendLocation response missing message id: ${JSON.stringify(json)}`);
    }
    return { externalId, timestamp: new Date() };
  },

  async sendContacts(args: SendContactsArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // Map our vCard shape → Meta's `contacts` wire shape. Meta requires
    // `name.formatted_name` + at least one of first/last, so seed first_name
    // from the display name. Our addresses are pre-joined human lines, so they
    // go in the `street` slot (Meta renders them fine).
    const contacts = args.contacts.map((c) => {
      const [first = c.name, ...rest] = c.name.trim().split(/\s+/);
      const last = rest.join(" ");
      return {
        name: {
          formatted_name: c.name || "Contact",
          first_name: first || c.name || "Contact",
          ...(last ? { last_name: last } : {}),
        },
        ...(c.phones.length
          ? {
              // Our contacts store the number as digits (the wa_id shape). Send
              // `phone` in display E.164 (leading "+") so the customer sees the
              // full international number, and set `wa_id` (digits) so the card
              // gets working "Message" + "Save contact" buttons on WhatsApp
              // (without wa_id Meta shows only "Invite to WhatsApp").
              phones: c.phones.map((raw) => {
                const digits = raw.replace(/\D/g, "");
                return {
                  phone: digits ? `+${digits}` : raw,
                  type: "CELL",
                  ...(digits.length >= 8 ? { wa_id: digits } : {}),
                };
              }),
            }
          : {}),
        ...(c.emails?.length
          ? { emails: c.emails.map((email) => ({ email, type: "WORK" })) }
          : {}),
        ...(c.addresses?.length
          ? { addresses: c.addresses.map((street) => ({ street, type: "HOME" })) }
          : {}),
        ...(c.company ? { org: { company: c.company } } : {}),
      };
    });
    const res = await postWhatsappMessages(url, config, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...messagingAccountField(config),
        ...whatsappDestination(args),
        type: "contacts",
        contacts,
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta sendContacts failed: ${res.status} ${text}`, res.status, text);
    }
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendContacts response missing message id: ${JSON.stringify(json)}`);
    }
    return { externalId, timestamp: new Date() };
  },

  async blockUsers(users: string[], config: MetaSendConfig): Promise<BlockUsersResult> {
    return blockUsersCall("POST", users, config);
  },

  async unblockUsers(users: string[], config: MetaSendConfig): Promise<BlockUsersResult> {
    return blockUsersCall("DELETE", users, config);
  },

  async sendReaction(args: SendReactionArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await postWhatsappMessages(url, config, {
        messaging_product: "whatsapp",
        ...messagingAccountField(config),
        recipient_type: "individual",
        ...whatsappDestination(args),
        type: "reaction",
        // Meta's convention: an empty emoji removes the business's reaction.
        reaction: { message_id: args.messageExternalId, emoji: args.emoji },
      });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta sendReaction failed: ${res.status} ${text}`, res.status, text);
    }
    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    // A reaction send returns a message id; we don't persist a new row for it
    // (it mutates the target message), but keep the shape uniform.
    return { externalId: externalId ?? `reaction:${args.messageExternalId}`, timestamp: new Date() };
  },

  async sendTypingIndicator(
    externalId: string,
    config: MetaSendConfig,
    _recipientId?: string,
    active: boolean = true,
  ): Promise<void> {
    // WhatsApp has NO "stop typing" — the indicator only auto-expires — so a
    // `typing_off` request (active:false) is a no-op here.
    if (!active) return;
    // Meta bundles the typing bubble onto the read-receipt endpoint: the call
    // marks `externalId` as read AND shows the customer a typing indicator
    // for up to 25 seconds. The indicator auto-dismisses when the next
    // outbound message lands or the timer expires — there is no explicit
    // "stop typing" endpoint. Caller is responsible for refreshing every
    // ~20s while the agent keeps typing.
    //
    // Constraint: requires a recent inbound to anchor on. Outside the 24h
    // window (no recent inbound), Meta rejects with policy errors — we
    // swallow them since the agent's local UX shouldn't degrade.
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // Idempotent best-effort — keep the transient-blip retry.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...messagingAccountField(config),
        status: "read",
        message_id: externalId,
        typing_indicator: { type: "text" },
      }),
    });

    if (!res.ok) {
      const body = await safeMetaText(res);
      console.warn(
        `[meta] sendTypingIndicator failed for ${externalId}: ${res.status} ${body}`,
      );
    }
  },

  async markIncomingRead(externalId: string, config: MetaSendConfig): Promise<void> {
    // Meta's read-receipt endpoint reuses the messages POST shape with
    // status: "read" — marking the latest wamid as read implicitly marks
    // every earlier inbound from that conversation as read on the customer's
    // device, so one call per agent-view is enough.
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // Idempotent read-receipt — marking a wamid read twice is a no-op, so the
    // transient-blip retry stays enabled.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...messagingAccountField(config),
        status: "read",
        message_id: externalId,
      }),
    });

    if (!res.ok) {
      // Non-fatal: log but don't throw. Common cause is a wamid older than
      // the 7-day window Meta accepts for read receipts.
      const body = await safeMetaText(res);
      console.warn(
        `[meta] markIncomingRead failed for ${externalId}: ${res.status} ${body}`,
      );
    }
  },

  // -------------------------------------------------------------------------
  // Media: fetch (inbound), upload (outbound staging), send (outbound).
  // -------------------------------------------------------------------------

  async fetchMedia(
    externalMediaId: string,
    config: MetaSendConfig,
    maxBytes?: number,
  ): Promise<FetchedMedia> {
    // Step 1: GET /{media-id} → { url, mime_type, ... }. The signed URL is
    // valid for ~5 minutes — we MUST hit it immediately. Don't store it.
    const metaUrl = `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(externalMediaId)}`;
    // GET — idempotent; keep the transient-blip retry (this runs on the webhook
    // hot path where a Meta CDN hiccup shouldn't drop an inbound attachment).
    const metaRes = await metaFetch(metaUrl, {
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!metaRes.ok) {
      const t = await metaRes.text();
      throw new MetaSendError(
        `meta media metadata failed: ${metaRes.status} ${t}`,
        metaRes.status,
        t,
      );
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url || !meta.mime_type) {
      throw new Error("meta media metadata missing url or mime_type");
    }

    // Step 2: download the binary. Meta's CDN ALSO requires the bearer token
    // — undocumented gotcha, requests without it 401. GET — idempotent, retry on.
    const binRes = await metaFetch(meta.url, {
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!binRes.ok) {
      const t = await binRes.text().catch(() => "");
      throw new MetaSendError(
        `meta media download failed: ${binRes.status} ${t}`,
        binRes.status,
        t,
      );
    }
    // minor#3: reject via Content-Length BEFORE buffering the whole binary into
    // heap. A 4-wide inbound batch each buffering up to ~100MB could transiently
    // spike ~400MB of api heap before the caller's post-buffer cap fired. The
    // caller still enforces the authoritative per-kind cap on the returned bytes
    // (a CDN can omit/understate Content-Length), so this is purely a RAM guard.
    if (maxBytes !== undefined) {
      const lenHeader = binRes.headers.get("content-length");
      const declared = lenHeader ? Number.parseInt(lenHeader, 10) : NaN;
      if (Number.isFinite(declared) && declared > maxBytes) {
        // Drain the unread body so the connection is released, then bail.
        await binRes.body?.cancel().catch(() => undefined);
        throw new MediaTooLargeError(declared, maxBytes);
      }
    }
    const ab = await binRes.arrayBuffer();
    return { bytes: new Uint8Array(ab), mimeType: meta.mime_type };
  },

  async uploadMedia(
    args: UploadMediaArgs,
    config: MetaSendConfig,
  ): Promise<UploadMediaResult> {
    // Multipart upload to /{phone-number-id}/media. Meta returns an id valid
    // for ~30 days.
    //
    // Whether one id may be referenced by MANY messages is UNVERIFIED here: an
    // earlier comment asserted "single-use per outbound message" with no
    // citation and no test, while Meta's template-media doc recommends ids
    // precisely to "avoid unnecessary requests to your public server" — advice
    // that only pays off if ids are reusable. Every current caller uploads one
    // id per message, so nothing depends on the answer today. It matters the
    // moment a broadcast wants to upload once and reuse across recipients; see
    // lib/templates/ for how to settle it.
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/media`;
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    // Meta requires the type field — using the mime type works. The wire
    // format of the file part is what Meta dispatches the right validators on.
    fd.append("type", args.mimeType);
    // Special-purpose uploads (voicemail announcements) carry a use_case that
    // both exempts them from the 30-day media TTL and locks them out of
    // ordinary message sends.
    if (args.useCase) fd.append("use_case", args.useCase);
    if (args.description) fd.append("description", args.description);
    // Hand the Uint8Array straight to Blob. Node 20+'s undici-backed Blob
    // accepts Uint8Array as a BlobPart at runtime — the prior `new
    // ArrayBuffer(len) + .set(bytes)` dance doubled peak RAM (one copy of
    // the bytes + the ArrayBuffer + the Blob internal). For a 100MB
    // document upload that doubled-copy was a measurable OOM risk on the
    // 4GB heap. The cast is needed because TS's BlobPart type narrows to
    // `Uint8Array<ArrayBuffer>` (excluding SharedArrayBuffer); our bytes
    // always come from `file.arrayBuffer()` or `fetch().arrayBuffer()`,
    // both of which return ArrayBuffer-backed Uint8Arrays.
    fd.append(
      "file",
      new Blob([args.bytes as Uint8Array<ArrayBuffer>], { type: args.mimeType }),
      args.filename,
    );

    // Staging upload — produces a single-use media id with no customer-visible
    // effect, so a retried 5xx blip is safe (worst case: one orphaned media id
    // that Meta expires in ~30 days). Keep the retry.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
      body: fd,
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta media upload failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) {
      throw new Error(`meta media upload missing id: ${JSON.stringify(json)}`);
    }
    return { mediaId: json.id };
  },

  async sendMedia(args: SendMediaArgs, config: MetaSendConfig): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    // Build the type-specific subobject. Caption is only accepted INLINE on
    // image/video/document; sticker + audio reject it (Meta returns 100), so for
    // those a caption is delivered as a follow-up text after the media (below).
    const captionInline =
      args.kind === "image" || args.kind === "video" || args.kind === "document";
    const sub: Record<string, unknown> = { id: args.mediaId };
    if (args.caption && captionInline) {
      sub.caption = args.caption;
    }
    if (args.kind === "document" && args.filename) {
      sub.filename = args.filename;
    }
    // Audio voice-note flag — renders with the WhatsApp waveform UI on the
    // recipient's side. Meta-side flag, not a separate payload type.
    if (args.kind === "audio" && args.voice) {
      sub.voice = true;
    }

    const res = await postWhatsappMessages(url, config, {
        messaging_product: "whatsapp",
        ...messagingAccountField(config),
        recipient_type: "individual",
        ...whatsappDestination(args),
        type: args.kind,
        [args.kind]: sub,
        ...(args.replyToExternalId
          ? { context: { message_id: args.replyToExternalId } }
          : {}),
      });

    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta sendMedia failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as { messages?: Array<{ id?: string }> };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(`meta sendMedia response missing id: ${JSON.stringify(json)}`);
    }

    // Audio / sticker can't carry an inline caption (Meta rejects it), so a
    // caption is NOT sent with them — the media goes on its own. The send layer
    // only passes a caption for kinds that inline it, and the composer sends
    // such a file alone, so nothing is silently dropped here.
    return { externalId, timestamp: new Date() };
  },

  // -------------------------------------------------------------------------
  // Templates: list approved templates + send a parameterized one.
  //
  // Meta's templates live at the WhatsApp Business Account level — not the
  // phone number. That's why fetchTemplates requires wabaId in config; if it
  // hasn't been pasted yet we throw a typed error so the route can render a
  // helpful "add your WABA id in settings" message instead of a 500.
  // -------------------------------------------------------------------------

  async fetchTemplates(config: MetaSendConfig): Promise<ProviderTemplate[]> {
    if (!config.wabaId) {
      throw new MissingWabaIdError();
    }

    // Page through the catalog. Meta's default page size is 25; we crank it
    // up because most teams have <100 templates total and one round-trip is
    // strictly better than three.
    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates`,
    );
    // `parameter_format` tells us NAMED vs POSITIONAL authoritatively. Without it
    // we were inferring it from a regex over the body text, which is a guess: a
    // POSITIONAL template whose body happens to contain `{{order_id}}` as
    // literal text would be misread, and the wire assembly would then send the
    // wrong parameter shape and 132000 every recipient.
    // `correct_category` is how Meta announces a PENDING recategorization: when
    // it differs from `category` and isn't empty, the template moves to that
    // category on the first of next month (which changes what it costs to send).
    // It is only readable by asking for it — there is no webhook that carries
    // the current pending state, only one-shot notices we may have missed.
    url.searchParams.set(
      "fields",
      "name,language,status,category,correct_category,components,id,parameter_format," +
        // `quality_score` is only returned if asked for. It is the EARLY warning
        // that a template is heading for a pause — the `PAUSED` status that
        // follows is too late to act on.
        "message_send_ttl_seconds,quality_score," +
        // `library_template_name` marks a template created from Meta's Template
        // Library — those are subject to send-time parameter TYPE checks (the
        // doc's own warning keys on this field's presence in this response).
        // Without it, a library template created in WhatsApp Manager (or a row
        // recreated by a resync) lost the marker and its type checks silently
        // vanished.
        "library_template_name," +
        // Whether button-click tracking is disabled on this template — the
        // Analytics doc's per-template opt-out. Read it so the insights UI can
        // say "clicks are off for this template" instead of rendering a null
        // that looks like a broken feature.
        "cta_url_link_tracking_opted_out",
    );
    url.searchParams.set("limit", "200");

    const results: ProviderTemplate[] = [];
    let next: string | null = url.toString();
    // Page ceiling sized to Meta's real maximum, not a guess: "if a parent
    // business portfolio is unverified, each of its WhatsApp Business Accounts is
    // limited to 250 message templates. However, if the portfolio is verified …
    // up to 6,000 templates." At limit=200 that is 30 pages, so 40 leaves
    // headroom while still bounding the loop.
    //
    // The ceiling was 5 (=1000 templates) and the loop RETURNED the truncated
    // list. `reconcileWaba` documents its input as complete-or-thrown and
    // deleteMany()s every local row absent from it, so a verified portfolio's
    // WABA holding more than 1000 templates had the remainder silently and
    // permanently deleted on first sync — taking `variableBindings`, which Meta
    // cannot give back, with them. Hence the throw below: truncation must be an
    // error, never a short list, because the caller cannot tell the difference.
    let pages = 0;

    while (next && pages < TEMPLATE_LIST_MAX_PAGES) {
      pages += 1;
      // GET — idempotent; keep the transient-blip retry.
      const res = await metaFetch(next, {
        retry: true,
        appSecret: config.appSecret,
        headers: { authorization: `Bearer ${config.accessToken}` },
      });
      if (!res.ok) {
        const text = await safeMetaText(res);
        throw new MetaSendError(
          `meta fetchTemplates failed: ${res.status} ${text}`,
          res.status,
          text,
        );
      }
      const json = (await res.json()) as {
        data?: Array<MetaTemplateRow>;
        paging?: { next?: string };
      };
      for (const row of json.data ?? []) {
        const t = normalizeMetaTemplate(row);
        if (t) results.push(t);
      }
      next = json.paging?.next ?? null;
    }

    // Still more pages than the ceiling allows: refuse rather than hand back a
    // partial catalog. `reconcileWaba` prunes against whatever it is given, so a
    // silent short list is silent permanent data loss; a throw only costs one
    // skipped sweep, and the sweeper already reports it in `failed[]`.
    if (next) {
      const detail = `meta fetchTemplates truncated: more than ${TEMPLATE_LIST_MAX_PAGES * 200} templates on this WABA`;
      throw new MetaSendError(detail, 502, detail);
    }

    return results;
  },

  async createTemplate(
    args: CreateTemplateArgs,
    config: MetaSendConfig,
  ): Promise<CreateTemplateResult> {
    if (!config.wabaId) throw new MissingWabaIdError();

    const url = `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates`;
    const res = await metaFetch(url, {
      method: "POST",
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        name: args.name,
        language: args.language,
        category: args.category.toUpperCase(),
        // Meta defaults an absent `parameter_format` to POSITIONAL. Say it
        // outright so the stored `MessageTemplate.parameterFormat` is a
        // statement of fact rather than a bet on a vendor default.
        parameter_format: args.parameterFormat.toUpperCase(),
        // Omitted unless the author set one — Meta's per-category default is the
        // right answer when nobody has an opinion, and pinning a value silently
        // would change how long delivery is retried.
        ...(args.messageSendTtlSeconds !== undefined
          ? { message_send_ttl_seconds: args.messageSendTtlSeconds }
          : {}),
        // Meta documents some component types ONLY in lower snake_case
        // (`call_permission_request`, `limited_time_offer`, `carousel` and its
        // nested card components). Every other type is accepted in either case;
        // these are only ever shown lowercase, so don't gamble on the uppercase
        // form being recognized.
        components: args.components.map(lowercaseComponentForCreate),
      }),
    });

    if (!res.ok) {
      // Meta's create endpoint is the noisiest one in the API — it rejects
      // for missing examples, duplicate names, policy issues, and per-
      // component validation failures. Surfacing the body verbatim is the
      // only way the UI can show useful error messages.
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta createTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as {
      id?: string;
      status?: string;
      category?: string;
    };
    if (!json.id) {
      throw new Error(`meta createTemplate response missing id: ${JSON.stringify(json)}`);
    }
    const status = mapTemplateStatus(json.status) ?? "pending";
    // Meta echoes the category it ACTUALLY assigned, which may not be the one we
    // asked for: since 2025-04-09 a UTILITY submission whose content reads as
    // promotional is approved as MARKETING outright (the old opt-in
    // `allow_category_change` is now the default). Persisting our request instead
    // of this answer left the row claiming a cheaper category than Meta bills.
    return { externalId: json.id, status, category: mapTemplateCategory(json.category) };
  },

  /**
   * Browse Meta's Template Library — pre-written, pre-categorized blueprints.
   *
   * A ROOT-LEVEL edge (`/message_template_library`), not WABA-scoped: the
   * library is Meta's catalogue, identical for everyone, so there is nothing
   * account-specific to scope it to. (Meta's own example curl on this endpoint
   * shows `/{waba-id}/message_templates?search=…`, which is a different endpoint
   * entirely and returns YOUR templates — the documented request syntax above it
   * is the correct one.)
   */
  async fetchTemplateLibrary(
    filters: TemplateLibraryFilters,
    config: MetaSendConfig,
  ): Promise<LibraryTemplate[]> {
    const url = new URL(`${GRAPH_BASE}/${config.graphVersion}/message_template_library`);
    for (const key of ["search", "topic", "usecase", "industry", "language", "name"] as const) {
      const value = filters[key];
      if (value) url.searchParams.set(key, value);
    }
    url.searchParams.set("limit", "200");

    // Idempotent read of a static catalogue — retry is safe.
    const res = await metaFetch(url, {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta fetchTemplateLibrary failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as { data?: unknown };
    // Graph list edges wrap in `{ data: [...] }`; the doc's example response
    // shows a bare object. Accept either rather than betting on the formatting.
    const rows = Array.isArray(json.data)
      ? json.data
      : Array.isArray(json)
        ? json
        : [json];
    return rows
      .map(normalizeLibraryTemplate)
      .filter((t): t is LibraryTemplate => t !== null);
  },

  /**
   * Instantiate a library template under our own name.
   *
   * Same endpoint as `createTemplate` but a different body: no `components` at
   * all — the blueprint owns the copy — just `library_template_name` plus the
   * per-business button/body inputs. An UNMODIFIED instantiation comes back
   * `APPROVED` immediately rather than `PENDING`, which is the whole reason the
   * library is worth a dedicated path.
   *
   * `library_template_button_inputs` is sent as a JSON STRING, which is how Meta
   * documents it — the value is a quoted array in every published example.
   */
  async createFromLibrary(
    args: CreateFromLibraryArgs,
    config: MetaSendConfig,
  ): Promise<CreateTemplateResult> {
    if (!config.wabaId) throw new MissingWabaIdError();

    const url = `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates`;
    const res = await metaFetch(url, {
      method: "POST",
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        name: args.name,
        language: args.language,
        category: args.category.toUpperCase(),
        library_template_name: args.libraryTemplateName,
        ...(args.buttonInputs && args.buttonInputs.length > 0
          ? { library_template_button_inputs: JSON.stringify(args.buttonInputs) }
          : {}),
        ...(args.bodyInputs && Object.keys(args.bodyInputs).length > 0
          ? { library_template_body_inputs: args.bodyInputs }
          : {}),
      }),
    });

    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta createFromLibrary failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as { id?: string; status?: string; category?: string };
    if (!json.id) {
      throw new Error(`meta createFromLibrary response missing id: ${JSON.stringify(json)}`);
    }
    return {
      externalId: json.id,
      // Library instantiations normally return APPROVED outright; fall back to
      // pending rather than assuming.
      status: mapTemplateStatus(json.status) ?? "pending",
      category: mapTemplateCategory(json.category),
    };
  },

  /**
   * Edit an existing template in place — `POST /{template-id}`.
   *
   * Targets the TEMPLATE node, not the WABA edge that `createTemplate` posts to.
   * `components` REPLACES the whole component array (Meta does not merge), so
   * the caller must send the complete set or silently drop what it omits.
   *
   * On success Meta re-enters the template into review automatically; an
   * approved or paused template is re-approved unless review now fails it.
   */
  /**
   * Render the preset authentication text per language.
   *
   * `GET /{waba-id}/message_template_previews`. Meta owns this wording, so this
   * is the only way to show an operator what they are about to create — the
   * strings differ per language and are not something we could compose.
   *
   * `button_types=OTP` is REQUIRED for authentication previews; without it the
   * response omits the button labels entirely.
   */
  async previewAuthTemplates(
    args: AuthTemplatePreviewArgs,
    config: MetaSendConfig,
  ): Promise<AuthTemplatePreview[]> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_template_previews`,
    );
    url.searchParams.set("category", "AUTHENTICATION");
    // Marked Optional in the syntax block and Required in the parameter table of
    // the same page. Always sent: it satisfies both readings, and without it the
    // response omits the button labels entirely.
    url.searchParams.set("button_types", "OTP");
    if (args.languages.length > 0) {
      // `languages`, PLURAL — the syntax block writes `language=` but both
      // published curl examples use `languages=en_US,es_ES`. The working example
      // wins over the prose; Meta's syntax blocks have been wrong repeatedly
      // (see the /compare millisecond timestamp and the utility footer claim).
      url.searchParams.set("languages", args.languages.join(","));
    }
    if (args.addSecurityRecommendation) {
      url.searchParams.set("add_security_recommendation", "true");
    }
    if (args.codeExpirationMinutes !== undefined) {
      url.searchParams.set("code_expiration_minutes", String(args.codeExpirationMinutes));
    }

    const res = await metaFetch(url, {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta previewAuthTemplates failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as { data?: unknown };
    if (!Array.isArray(json.data)) return [];
    return json.data.filter(isObject).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        language: typeof row.language === "string" ? row.language : "",
        body: typeof row.body === "string" ? row.body : "",
        ...(typeof row.footer === "string" ? { footer: row.footer } : {}),
        buttons: Array.isArray(row.buttons)
          ? row.buttons.filter(isObject).map((b) => {
              const btn = b as Record<string, unknown>;
              return {
                ...(typeof btn.text === "string" ? { text: btn.text } : {}),
                ...(typeof btn.autofill_text === "string"
                  ? { autofill_text: btn.autofill_text }
                  : {}),
              };
            })
          : [],
      };
    });
  },

  /**
   * `POST /{template-id}/unpause` — lift a quality pause.
   *
   * A quality pause lifts itself (3h, then 6h, then the template is DISABLED on
   * the third instance), so this is not the normal recovery path. It exists for
   * templates paused by **Template Pacing**, which never unpause on their own.
   *
   * Meta re-derives the quality band from recent feedback when a template
   * unpauses, so the stored band is cleared by the caller rather than left
   * showing the RED that caused the pause.
   */
  async unpauseTemplate(externalId: string, config: MetaSendConfig): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(externalId)}/unpause`;
    const res = await metaFetch(url, {
      method: "POST",
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta unpauseTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  /**
   * Create/update an authentication template in MANY languages at once.
   *
   * `POST /{waba-id}/upsert_message_templates` — a different edge from
   * `createTemplate`, with a different contract: `languages` (plural), and no
   * `text` or `autofill_text` at all, because the wording is Meta's. An existing
   * (name, language) pair is UPDATED rather than colliding, which is what makes
   * this safe to re-run when adding a language.
   */
  async upsertAuthTemplate(
    args: UpsertAuthTemplateArgs,
    config: MetaSendConfig,
  ): Promise<UpsertAuthTemplateResult> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const url = `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/upsert_message_templates`;

    const res = await metaFetch(url, {
      method: "POST",
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        name: args.name,
        languages: args.languages,
        category: "AUTHENTICATION",
        ...(args.messageSendTtlSeconds !== undefined
          ? { message_send_ttl_seconds: args.messageSendTtlSeconds }
          : {}),
        components: [
          {
            type: "BODY",
            ...(args.addSecurityRecommendation
              ? { add_security_recommendation: true }
              : {}),
          },
          // The footer exists ONLY to carry the expiry warning — omit the whole
          // component when there is no expiry, rather than sending an empty one.
          ...(args.codeExpirationMinutes !== undefined
            ? [{ type: "FOOTER", code_expiration_minutes: args.codeExpirationMinutes }]
            : []),
          {
            type: "BUTTONS",
            buttons: [
              {
                type: "OTP",
                otp_type: args.otpType,
                // Zero-tap will NOT be created without this acknowledgement —
                // Meta rejects rather than defaulting it.
                ...(args.otpType === "ZERO_TAP"
                  ? { zero_tap_terms_accepted: args.zeroTapTermsAccepted === true }
                  : {}),
                ...(args.supportedApps && args.supportedApps.length > 0
                  ? { supported_apps: args.supportedApps }
                  : {}),
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta upsertAuthTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as { data?: unknown };
    const rows = Array.isArray(json.data) ? json.data.filter(isObject) : [];
    return {
      templates: rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          externalId: typeof row.id === "string" ? row.id : "",
          language: typeof row.language === "string" ? row.language : "",
          status: mapTemplateStatus(
            typeof row.status === "string" ? row.status : undefined,
          ),
        };
      }),
    };
  },

  async editTemplate(args: EditTemplateArgs, config: MetaSendConfig): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(args.externalId)}`;
    const res = await metaFetch(url, {
      method: "POST",
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        ...(args.category ? { category: args.category.toUpperCase() } : {}),
        ...(args.components ? { components: args.components } : {}),
        ...(args.messageSendTtlSeconds !== undefined
          ? { message_send_ttl_seconds: args.messageSendTtlSeconds }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta editTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  async deleteTemplate(args: DeleteTemplateArgs, config: MetaSendConfig): Promise<void> {
    if (!config.wabaId) throw new MissingWabaIdError();

    // Without `hsm_id`, Meta deletes ALL language variants under `name`.
    // We pass it when we have it so deleting one language leaves the others.
    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates`,
    );
    url.searchParams.set("name", args.name);
    if (args.externalId) url.searchParams.set("hsm_id", args.externalId);

    // DELETE is idempotent (a repeat 404 is treated as success below), so the
    // transient-blip retry stays on.
    const res = await metaFetch(url, {
      method: "DELETE",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      // A 404 from Meta means the template is already gone — treat as success
      // so a stale local row that we're cleaning up doesn't keep failing.
      if (res.status === 404) return;
      throw new MetaSendError(
        `meta deleteTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  /**
   * Switch on WABA-level template analytics.
   *
   * IRREVERSIBLE at Meta — there is no `false`. Free to enable and free to
   * query; the only cost is that it cannot be undone, which is why the domain
   * layer gates it behind an explicit admin confirmation and never fires it
   * from a read path.
   */
  async enableTemplateInsights(config: MetaSendConfig): Promise<void> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}`,
    );
    url.searchParams.set("is_enabled_for_insights", "true");
    // No retry: a POST that flips an irreversible flag must not be replayed on
    // an ambiguous timeout. The caller re-checks state instead.
    const res = await metaFetch(url, {
      method: "POST",
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta enableTemplateInsights failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  /**
   * What META says about this WABA's analytics — not what we remember saying.
   *
   * `is_enabled_for_insights` is a READABLE boolean on the WABA node, so the
   * insights switch has an authoritative source. That matters because our own
   * `insightsEnabledAt` stamp is written only by our own enable button, while
   * Meta documents WhatsApp Manager as an equally valid way to confirm — an
   * account switched on there read as opted-out locally and got skipped by the
   * capture sweeper, quietly losing read/click data that expires in ~7 days.
   *
   * `currency` comes back on the same request because every cost figure in every
   * analytics surface is denominated in it and Meta does not repeat it per data
   * point. `timezone_id` is the WABA's configured zone — the one the
   * `use_waba_timezone` analytics parameter switches reporting into.
   */
  async fetchTemplateInsightsState(config: MetaSendConfig): Promise<{
    enabled: boolean | null;
    currency: string | null;
    timezoneId: string | null;
  }> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}`,
    );
    url.searchParams.set("fields", "is_enabled_for_insights,currency,timezone_id");
    const res = await metaFetch(url, {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta fetchTemplateInsightsState failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const row = (await res.json()) as {
      is_enabled_for_insights?: unknown;
      currency?: unknown;
      timezone_id?: unknown;
    };
    return {
      // Null, not false, when the field is absent: a token lacking
      // `whatsapp_business_management` reads the node without it, and reporting
      // that as "insights are off" would send an admin to flip an IRREVERSIBLE
      // switch that is already on.
      enabled:
        typeof row.is_enabled_for_insights === "boolean" ? row.is_enabled_for_insights : null,
      currency: str(row.currency),
      timezoneId: str(row.timezone_id),
    };
  },

  /**
   * Toggle button-click tracking on ONE template.
   *
   * `POST /{template-id}?cta_url_link_tracking_opted_out=<bool>&category=<cur>`
   *
   * `category` is REQUIRED by Meta and must be the template's CURRENT category
   * — sending a different one flips the template back to PENDING review, so
   * the caller resolves it from the stored row and this method never invents
   * it. Reversible (unlike WABA insights enablement).
   */
  async setTemplateLinkTracking(
    args: SetTemplateLinkTrackingArgs,
    config: MetaSendConfig,
  ): Promise<void> {
    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(args.externalId)}`,
    );
    url.searchParams.set("cta_url_link_tracking_opted_out", String(args.optedOut));
    url.searchParams.set("category", args.category.toLowerCase());
    // No retry: a POST replayed on an ambiguous timeout could race a concurrent
    // category edit; the caller re-syncs state instead.
    const res = await metaFetch(url, {
      method: "POST",
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta setTemplateLinkTracking failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  /**
   * Read Meta's own per-template daily analytics.
   *
   * Wire shape (the edge form from Meta's own doc example):
   *   GET /{WABA}/template_analytics?start=&end=&granularity=daily
   *       &metric_types=sent,delivered,read,clicked,cost&template_ids=[..]
   *
   * The edge form is used instead of the `?fields=template_analytics.<...>`
   * field expansion because its response carries a TOP-LEVEL `paging` object —
   * 10 templates over 90 days is up to 900 data points, and whatever falls
   * past page one of an unfollowed cursor silently vanishes, which reads as
   * "this template sent nothing on those days" forever.
   *
   * Two Meta constraints the caller must respect and this method enforces:
   * at most 10 template ids per request, and a 90-day lookback. Timestamps are
   * UNIX SECONDS, not milliseconds — passing ms silently returns an empty set
   * rather than an error, which reads as "no data" forever.
   */
  async fetchTemplateAnalytics(
    args: TemplateAnalyticsArgs,
    config: MetaSendConfig,
  ): Promise<ProviderTemplateAnalyticsRow[]> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const ids = args.templateExternalIds.slice(0, 10);
    if (ids.length === 0) return [];

    const startSec = Math.floor(args.start.getTime() / 1000);
    const endSec = Math.floor(args.end.getTime() / 1000);
    const first = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/template_analytics`,
    );
    first.searchParams.set("start", String(startSec));
    first.searchParams.set("end", String(endSec));
    first.searchParams.set("granularity", "daily");
    first.searchParams.set("metric_types", "sent,delivered,read,clicked,cost");
    first.searchParams.set(
      "template_ids",
      `[${ids.map((id: string) => JSON.stringify(id)).join(",")}]`,
    );

    const rows: ProviderTemplateAnalyticsRow[] = [];
    let url: URL | null = first;
    // Hard page ceiling: 900 points at Meta's smallest observed page size fits
    // comfortably; a malformed `next` loop must not fetch forever.
    for (let page = 0; url && page < 50; page++) {
      // Idempotent read — the transient-blip retry is safe here.
      const res = await metaFetch(url, {
        method: "GET",
        retry: true,
        appSecret: config.appSecret,
        headers: { authorization: `Bearer ${config.accessToken}` },
      });
      if (!res.ok) {
        const text = await safeMetaText(res);
        // Some WABAs (older Graph versions, partial rollouts) reject the edge
        // path itself with an "unknown path / nonexistent field" 400. That is
        // a shape disagreement, not a data refusal — fall back to the field-
        // expansion form (`?fields=template_analytics.<...>`) once, on the
        // first page only, rather than failing a fetch the account can serve.
        if (page === 0 && res.status === 400 && isGraphShapeDisagreement(text)) {
          return fetchTemplateAnalyticsViaFieldExpansion(
            { ids, startSec, endSec },
            config,
          );
        }
        throw new MetaSendError(
          `meta fetchTemplateAnalytics failed: ${res.status} ${text}`,
          res.status,
          text,
        );
      }
      const json = (await res.json()) as {
        data?: unknown;
        paging?: { next?: unknown };
      };
      // The edge response is `{ data, paging }` — the parser's wrapped shape.
      rows.push(...parseTemplateAnalytics({ template_analytics: json }));

      const next = typeof json.paging?.next === "string" ? json.paging.next : null;
      // Follow only cursors that stay on Graph — a response-supplied URL never
      // gets to point this token anywhere else.
      url = next && next.startsWith(`${GRAPH_BASE}/`) ? new URL(next) : null;
    }
    return rows;
  },

  /**
   * Messaging analytics — messages sent and delivered by this WABA's numbers.
   *
   * FIELD-EXPANSION ONLY. `analytics` is a FIELD on the WABA node, not an edge
   * (the Graph reference lists Call/Conversation/Pricing Analytics among the
   * account's edges; `analytics` appears only under Fields), so there is no
   * `/analytics` path to page through and attempting one is a guaranteed 400.
   *
   * Granularity here is `DAY`/`MONTH` — NOT the `DAILY`/`MONTHLY` its three
   * sibling surfaces take. The args type pins the difference; this comment
   * exists because the two spellings are one letter apart and the wrong one is
   * a `#100 Invalid parameter` on every request.
   */
  async fetchMessagingAnalytics(
    args: MessagingAnalyticsArgs,
    config: MetaSendConfig,
  ): Promise<ProviderMessagingAnalyticsRow[]> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const spec =
      `analytics.start(${unixSeconds(args.start)}).end(${unixSeconds(args.end)})` +
      `.granularity(${args.granularity})` +
      graphListArg("phone_numbers", args.phoneNumbers) +
      graphListArg("country_codes", args.countryCodes) +
      graphListArg("product_types", args.productTypes);
    const points = await fetchWabaAnalyticsField("analytics", spec, config);
    return points.map((pt) => ({
      start: new Date(numOrZero(pt.start) * 1000),
      end: new Date(numOrZero(pt.end) * 1000),
      sent: num(pt.sent) ?? 0,
      delivered: num(pt.delivered) ?? 0,
      // Groups API only. Absent is the norm — null, never 0, so "this business
      // doesn't use groups" never renders as "its group sends all failed".
      groupsSent: num(pt.groups_sent),
      groupsDelivered: num(pt.groups_delivered),
    }));
  },

  /**
   * Conversation analytics — the CONVERSATION-based pricing view.
   *
   * Kept alongside `fetchPricingAnalytics` rather than replaced by it: Meta
   * moved billing to per-message pricing, but this field still answers a
   * question pricing analytics cannot — how many CONVERSATIONS were opened, by
   * direction and by free-tier vs regular. The two are different units (a
   * conversation vs a delivered message) and must never be summed together.
   */
  async fetchConversationAnalytics(
    args: ConversationAnalyticsArgs,
    config: MetaSendConfig,
  ): Promise<ProviderConversationAnalyticsRow[]> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const spec =
      `conversation_analytics.start(${unixSeconds(args.start)}).end(${unixSeconds(args.end)})` +
      `.granularity(${args.granularity})` +
      graphListArg("phone_numbers", args.phoneNumbers) +
      graphListArg("country_codes", args.countryCodes) +
      graphListArg("metric_types", args.metricTypes) +
      graphListArg("conversation_categories", args.categories) +
      graphListArg("conversation_types", args.types) +
      graphListArg("conversation_directions", args.directions) +
      graphListArg("dimensions", args.dimensions);
    const points = await fetchWabaAnalyticsEdge(
      "conversation_analytics",
      {
        start: String(unixSeconds(args.start)),
        end: String(unixSeconds(args.end)),
        granularity: args.granularity,
        ...graphJsonParam("phone_numbers", args.phoneNumbers),
        ...graphJsonParam("country_codes", args.countryCodes),
        ...graphJsonParam("metric_types", args.metricTypes),
        ...graphJsonParam("conversation_categories", args.categories),
        ...graphJsonParam("conversation_types", args.types),
        ...graphJsonParam("conversation_directions", args.directions),
        ...graphJsonParam("dimensions", args.dimensions),
      },
      spec,
      config,
    );
    return points.map((pt) => ({
      start: new Date(numOrZero(pt.start) * 1000),
      end: new Date(numOrZero(pt.end) * 1000),
      // `conversation` and `cost` are each absent when the other was the only
      // metric requested — and cost is absent ENTIRELY for partner-billed
      // WABAs. Null, never 0: "not reported" and "free" are different answers.
      conversations: num(pt.conversation),
      cost: num(pt.cost),
      phoneNumber: str(pt.phone_number),
      country: str(pt.country),
      category: str(pt.conversation_category),
      type: str(pt.conversation_type),
      direction: str(pt.conversation_direction),
    }));
  },

  /**
   * Pricing analytics — volume and cost of messages DELIVERED in the window,
   * and the ONLY surface that reports volume TIERS.
   *
   * The tier is what makes this worth having: `"0:750000"` on a (country,
   * category) pair says where the account sits on Meta's utility/authentication
   * volume ladder, and `upper - volume` is how many more messages buy the
   * cheaper rate. Meta omits the tier for free messages (they don't count
   * toward tiering) and pins marketing at `0:MAX`, where tiers don't apply.
   */
  async fetchPricingAnalytics(
    args: PricingAnalyticsArgs,
    config: MetaSendConfig,
  ): Promise<ProviderPricingAnalyticsRow[]> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const spec =
      `pricing_analytics.start(${unixSeconds(args.start)}).end(${unixSeconds(args.end)})` +
      `.granularity(${args.granularity})` +
      graphListArg("phone_numbers", args.phoneNumbers) +
      graphListArg("country_codes", args.countryCodes) +
      graphListArg("metric_types", args.metricTypes) +
      graphListArg("pricing_types", args.types) +
      graphListArg("pricing_categories", args.categories) +
      graphListArg("dimensions", args.dimensions) +
      graphListArg("tiers", args.tiers);
    const points = await fetchWabaAnalyticsEdge(
      "pricing_analytics",
      {
        start: String(unixSeconds(args.start)),
        end: String(unixSeconds(args.end)),
        granularity: args.granularity,
        ...graphJsonParam("phone_numbers", args.phoneNumbers),
        ...graphJsonParam("country_codes", args.countryCodes),
        ...graphJsonParam("metric_types", args.metricTypes),
        ...graphJsonParam("pricing_types", args.types),
        ...graphJsonParam("pricing_categories", args.categories),
        ...graphJsonParam("dimensions", args.dimensions),
        ...graphJsonParam("tiers", args.tiers),
      },
      spec,
      config,
    );
    return points.map((pt) => {
      const tier = str(pt.tier);
      const bounds = parseTierBounds(tier);
      return {
        start: new Date(numOrZero(pt.start) * 1000),
        end: new Date(numOrZero(pt.end) * 1000),
        volume: num(pt.volume),
        cost: num(pt.cost),
        phoneNumber: str(pt.phone_number),
        country: str(pt.country),
        // Category and type pass through VERBATIM. The Graph reference and the
        // guide page list different enum members (GROUP_*, MARKETING_LITE_DYNAMIC
        // and AI_BOT in one; REFERRAL_CONVERSION in the other), so any
        // allow-list here would drop a value Meta legitimately returns — and a
        // dropped pricing row is money that silently vanishes from a cost report.
        category: str(pt.pricing_category),
        type: str(pt.pricing_type),
        tier,
        tierLower: bounds.lower,
        tierUpper: bounds.upper,
      };
    });
  },

  /**
   * Call analytics — completed-call count, average duration and cost.
   *
   * Billing context the numbers alone don't carry: business-initiated calls bill
   * in SIX-SECOND pulses (a partial pulse counts whole), by the callee's country,
   * against a tier measured in minutes per CALENDAR MONTH; a call spanning a tier
   * boundary is priced entirely at the lower rate. User-initiated calls are always
   * free, which is why DIRECTION is the dimension worth asking for — without it,
   * a zero cost beside a large count looks like a reporting failure.
   */
  async fetchCallAnalytics(
    args: CallAnalyticsArgs,
    config: MetaSendConfig,
  ): Promise<ProviderCallAnalyticsRow[]> {
    if (!config.wabaId) throw new MissingWabaIdError();
    const spec =
      `call_analytics.start(${unixSeconds(args.start)}).end(${unixSeconds(args.end)})` +
      `.granularity(${args.granularity})` +
      graphListArg("phone_numbers", args.phoneNumbers) +
      graphListArg("country_codes", args.countryCodes) +
      graphListArg("metric_types", args.metricTypes) +
      graphListArg("directions", args.directions) +
      graphListArg("dimensions", args.dimensions) +
      graphListArg("tiers", args.tiers);
    const points = await fetchWabaAnalyticsEdge(
      "call_analytics",
      {
        start: String(unixSeconds(args.start)),
        end: String(unixSeconds(args.end)),
        granularity: args.granularity,
        ...graphJsonParam("phone_numbers", args.phoneNumbers),
        ...graphJsonParam("country_codes", args.countryCodes),
        ...graphJsonParam("metric_types", args.metricTypes),
        ...graphJsonParam("directions", args.directions),
        ...graphJsonParam("dimensions", args.dimensions),
        ...graphJsonParam("tiers", args.tiers),
      },
      spec,
      config,
    );
    return points.map((pt) => ({
      start: new Date(numOrZero(pt.start) * 1000),
      end: new Date(numOrZero(pt.end) * 1000),
      count: num(pt.count),
      cost: num(pt.cost),
      averageDuration: num(pt.average_duration),
      phoneNumber: str(pt.phone_number),
      country: str(pt.country),
      direction: str(pt.direction),
      tier: str(pt.tier),
    }));
  },

  /**
   * Head-to-head comparison of two templates.
   *
   * `GET /{template-id}/compare?template_ids=[...]&start=&end=`
   *
   * Timestamps are UNIX SECONDS. Meta's own example on this endpoint shows a
   * 13-digit (millisecond) value, but its "Timeframes" section tells you to
   * subtract 604800 / 2592000 / 5184000 / 7776000 from the end value — plain
   * SECOND counts, which only work against a seconds timestamp. The example is
   * wrong; the analytics endpoint has the same seconds contract, where passing
   * ms silently returns an empty set.
   *
   * Meta answers a constraint violation (under 1,000 sends, different WABAs, an
   * unsupported window) with an EMPTY result rather than an error, so the caller
   * validates first and the empty case is reported honestly as "not enough data"
   * rather than rendered as a tie.
   */
  async compareTemplates(
    args: TemplateComparisonArgs,
    config: MetaSendConfig,
  ): Promise<ProviderTemplateComparison> {
    const url = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(args.templateExternalId)}/compare`,
    );
    url.searchParams.set(
      "template_ids",
      `[${args.againstExternalIds.map((id) => JSON.stringify(id)).join(",")}]`,
    );
    url.searchParams.set("start", String(Math.floor(args.start.getTime() / 1000)));
    url.searchParams.set("end", String(Math.floor(args.end.getTime() / 1000)));

    // Idempotent read — the transient-blip retry is safe here.
    const res = await metaFetch(url, {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta compareTemplates failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    return parseTemplateComparison(await res.json());
  },

  async uploadHeaderMedia(
    args: UploadHeaderMediaArgs,
    config: MetaSendConfig,
  ): Promise<UploadHeaderMediaResult> {
    if (!config.appId) {
      throw new MissingAppIdError();
    }

    // Step 1: create a resumable upload session. Endpoint is app-scoped, not
    // WABA-scoped — different from the per-message media upload.
    const startUrl = new URL(
      `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.appId)}/uploads`,
    );
    startUrl.searchParams.set("file_length", String(args.bytes.byteLength));
    startUrl.searchParams.set("file_type", args.mimeType);
    startUrl.searchParams.set("file_name", args.filename);
    // Token goes in the Authorization header, NOT the query string. The Graph
    // /{app-id}/uploads endpoint accepts `Authorization: Bearer`, and putting
    // the decrypted access token in the URL leaked it into logs + the 502 error
    // body whenever this call timed out (metaFetch's timeout message echoes the
    // input URL, and the 502 surfaced to any team member with templates:manage).
    const startRes = await metaFetch(startUrl, {
      method: "POST",
      // Staging upload session — no customer-visible effect, safe to retry.
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!startRes.ok) {
      const text = await startRes.text();
      throw new MetaSendError(
        `meta upload session failed: ${startRes.status} ${text}`,
        startRes.status,
        text,
      );
    }
    const startJson = (await startRes.json()) as { id?: string };
    const sessionId = startJson.id;
    if (!sessionId) {
      throw new Error(`meta upload session missing id: ${JSON.stringify(startJson)}`);
    }

    // Step 2: POST the bytes to the session. The Authorization header uses
    // `OAuth <token>` (not Bearer) for this endpoint — undocumented for a
    // long time, called out only in the resumable-upload guide.
    const uploadUrl = `${GRAPH_BASE}/${config.graphVersion}/${sessionId}`;
    const ab = new ArrayBuffer(args.bytes.byteLength);
    new Uint8Array(ab).set(args.bytes);
    const uploadRes = await metaFetch(uploadUrl, {
      method: "POST",
      // Staging upload (resumable from offset 0) — safe to retry on a blip.
      retry: true,
      appSecret: config.appSecret,
      headers: {
        authorization: `OAuth ${config.accessToken}`,
        file_offset: "0",
      },
      body: ab,
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new MetaSendError(
        `meta upload bytes failed: ${uploadRes.status} ${text}`,
        uploadRes.status,
        text,
      );
    }
    const uploadJson = (await uploadRes.json()) as { h?: string };
    if (!uploadJson.h) {
      throw new Error(`meta upload missing handle: ${JSON.stringify(uploadJson)}`);
    }
    return { headerHandle: uploadJson.h };
  },

  async sendTemplate(
    args: SendTemplateArgs,
    config: MetaSendConfig,
  ): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;

    const components = buildTemplateSendComponents(args.variables);

    const res = await postWhatsappMessages(url, config, {
        messaging_product: "whatsapp",
        ...messagingAccountField(config),
        recipient_type: "individual",
        ...whatsappDestination(args),
        type: "template",
        template: {
          name: args.name,
          language: { code: args.language },
          ...(components.length > 0 ? { components } : {}),
        },
      });

    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta sendTemplate failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }

    const json = (await res.json()) as {
      messages?: Array<{ id?: string; message_status?: string }>;
    };
    const externalId = json.messages?.[0]?.id;
    if (!externalId) {
      throw new Error(
        `meta sendTemplate response missing message id: ${JSON.stringify(json)}`,
      );
    }
    return {
      externalId,
      timestamp: new Date(),
      ...(isHeldForQualityAssessment(json) ? { heldForQualityAssessment: true } : {}),
    };
  },

  // -------------------------------------------------------------------------
  // Business profile — what a customer sees when they tap the business name.
  // -------------------------------------------------------------------------

  async getBusinessProfile(config: MetaSendConfig): Promise<ProviderBusinessProfile> {
    // Fields must be requested explicitly; an unqualified GET returns almost
    // nothing useful.
    const url =
      `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/whatsapp_business_profile` +
      `?fields=about,address,description,email,profile_picture_url,websites,vertical`;
    const res = await metaFetch(new URL(url), {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta getBusinessProfile failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    // Meta wraps a SINGLE profile in a `data` ARRAY. Reading `json.about`
    // directly returns undefined for every field and looks like an empty
    // profile rather than a parsing mistake.
    const json = (await res.json()) as {
      data?: Array<{
        about?: string;
        address?: string;
        description?: string;
        email?: string;
        profile_picture_url?: string;
        websites?: string[];
        vertical?: string;
      }>;
    };
    const row = json.data?.[0] ?? {};
    return {
      ...(row.about ? { about: row.about } : {}),
      ...(row.address ? { address: row.address } : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(row.email ? { email: row.email } : {}),
      ...(Array.isArray(row.websites) ? { websites: row.websites } : {}),
      ...(row.vertical ? { vertical: row.vertical } : {}),
      ...(row.profile_picture_url ? { profilePictureUrl: row.profile_picture_url } : {}),
    };
  },

  async updateBusinessProfile(
    args: UpdateBusinessProfileArgs,
    config: MetaSendConfig,
  ): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/whatsapp_business_profile`;
    const res = await metaFetch(new URL(url), {
      method: "POST",
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        // Only what the caller actually set. Sending `""` for an untouched
        // field CLEARS it at Meta, so an "update the description" request would
        // wipe the address.
        ...(args.about !== undefined ? { about: args.about } : {}),
        ...(args.address !== undefined ? { address: args.address } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.email !== undefined ? { email: args.email } : {}),
        ...(args.vertical !== undefined ? { vertical: args.vertical } : {}),
        ...(args.profilePictureHandle
          ? { profile_picture_handle: args.profilePictureHandle }
          : {}),
        // `websites` goes out as a JSON-ENCODED STRING (`"[\n \"https://…\"\n]"`),
        // and Graph also accepts a real array — BOTH work, so this is a style
        // choice, not a correctness one.
        //
        // Do not "fix" it in either direction on the strength of one doc page.
        // Checked 2026-07-30: TWO current Meta pages document this same endpoint
        // with the same `application/json` content-type and DISAGREE —
        // .../whatsapp/business-profiles (updated Jun 24 2026) shows the encoded
        // string, while .../whatsapp/business-phone-numbers/business-profiles
        // (updated Nov 4 2025) shows a real array and a parameter table reading
        // "websites array of strings … maximum of 2 websites". Two equally-current
        // pages presented as working means Graph coerces. Meta's official Business
        // SDKs cannot arbitrate either: the Cloud API business-profile endpoint is
        // not in their codegen surface at all (their `WhatsAppBusinessProfile` is
        // the unrelated Marketing-API node with three read-only fields).
        //
        // The previous comment here asserted the string form was THE authority. It
        // is one of two, and staying put is simply the lower-risk half of a coin flip.
        ...(args.websites !== undefined
          ? { websites: JSON.stringify(args.websites) }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta updateBusinessProfile failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  // -------------------------------------------------------------------------
  // Username — the number's chat-native @handle. 1:1 with the phone number,
  // globally unique across WhatsApp; adopting one does NOT hide the number.
  // -------------------------------------------------------------------------

  async getUsername(config: MetaSendConfig): Promise<{ username: string | null }> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/username`;
    const res = await metaFetch(new URL(url), {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      // A number that never adopted a username can answer this GET with the
      // generic "does not support this operation" shape rather than an empty
      // object. That is "no username", not an error — throwing here would
      // break the whole settings panel for exactly the numbers most likely to
      // open it (the ones about to adopt one).
      if (res.status === 400 && isGraphShapeDisagreement(text)) {
        return { username: null };
      }
      throw new MetaSendError(
        `meta getUsername failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    // Tolerate both a flat field and Meta's single-row `data` wrapper (the
    // business-profile GET wraps exactly this way).
    const json = (await res.json()) as {
      username?: string;
      data?: Array<{ username?: string }>;
    };
    const username = json.username ?? json.data?.[0]?.username ?? null;
    return {
      username:
        typeof username === "string" && username.trim().length > 0
          ? username.trim().toLowerCase()
          : null,
    };
  },

  async setUsername(
    args: { username: string; transferAction?: "none" | "force_transfer" },
    config: MetaSendConfig,
  ): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/username`;
    const res = await metaFetch(new URL(url), {
      // No retry: adopting a username is a write, and with `force_transfer`
      // it takes the handle away from a sibling number — never auto-repeat.
      method: "POST",
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        username: args.username,
        // `none` is Meta's documented default — omit it rather than asserting
        // it, so the request stays minimal.
        ...(args.transferAction && args.transferAction !== "none"
          ? { transfer_action: args.transferAction }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      // 147005 "Username transfer required" rides through in the body — the
      // service detects it there and turns it into an actionable 409.
      throw new MetaSendError(
        `meta setUsername failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  async deleteUsername(config: MetaSendConfig): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/username`;
    const res = await metaFetch(new URL(url), {
      method: "DELETE",
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta deleteUsername failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  async getUsernameSuggestions(config: MetaSendConfig): Promise<string[]> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/username_suggestions`;
    const res = await metaFetch(new URL(url), {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta getUsernameSuggestions failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    // Documented response shape:
    //   { "data": [ { "username_suggestions": ["<name>", …] } ] }
    // — the suggestions array is NESTED inside a data row. Rows are also
    // tolerated as bare strings or `{ username }` objects, and the array is
    // accepted at any of the plausible top-level keys — an unreadable row is
    // skipped, never a throw.
    const json = (await res.json()) as {
      data?: unknown;
      username_suggestions?: unknown;
      suggestions?: unknown;
    };
    const rows = [json.data, json.username_suggestions, json.suggestions].find(
      Array.isArray,
    ) as unknown[] | undefined;
    if (!rows) return [];
    const out: string[] = [];
    const push = (value: unknown) => {
      const normalized =
        typeof value === "string" ? value.trim().toLowerCase() : undefined;
      if (normalized && !out.includes(normalized)) out.push(normalized);
    };
    for (const row of rows) {
      if (typeof row === "string") {
        push(row);
        continue;
      }
      const obj = row as { username?: unknown; username_suggestions?: unknown };
      // The documented nesting: a data row wrapping the suggestions array.
      if (Array.isArray(obj?.username_suggestions)) {
        for (const nested of obj.username_suggestions) push(nested);
      }
      push(obj?.username);
    }
    return out;
  },

  /**
   * The number's Official Business Account status, and the WABA's own record.
   *
   * Two GETs because they live on different nodes, folded into one call so the
   * settings panel makes one request. Both are read-only here — WABA fields
   * aren't ours to write, and the OBA APPLICATION flow is deliberately not
   * built. The OBA guide now DOES publish a request wire shape
   * (`POST /{phoneNumberId}/official_business_account`), so an in-app "apply
   * for the blue tick" form is buildable when wanted (roadmap); until then the
   * UI links out to WhatsApp Manager.
   */
  async getAccountStatus(config: MetaSendConfig): Promise<ProviderAccountStatus> {
    const numberUrl =
      `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}` +
      `?fields=official_business_account`;
    const numberRes = await metaFetch(new URL(numberUrl), {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!numberRes.ok) {
      const text = await safeMetaText(numberRes);
      throw new MetaSendError(
        `meta getAccountStatus failed: ${numberRes.status} ${text}`,
        numberRes.status,
        text,
      );
    }
    const numberJson = (await numberRes.json()) as {
      official_business_account?: { oba_status?: string };
    };

    // The WABA record is best-effort: a token without
    // `whatsapp_business_management` can read the number but not the account,
    // and that must degrade to "unknown" rather than failing the whole panel.
    let waba: ProviderAccountStatus["waba"];
    if (config.wabaId) {
      try {
        const wabaUrl =
          `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId)}` +
          `?fields=name,status,currency,country,business_verification_status`;
        const wabaRes = await metaFetch(new URL(wabaUrl), {
          method: "GET",
          retry: true,
          appSecret: config.appSecret,
          headers: { authorization: `Bearer ${config.accessToken}` },
        });
        if (wabaRes.ok) {
          const row = (await wabaRes.json()) as {
            name?: string;
            status?: string;
            currency?: string;
            country?: string;
            business_verification_status?: string;
          };
          waba = {
            ...(row.name ? { name: row.name } : {}),
            ...(row.status ? { status: row.status } : {}),
            ...(row.currency ? { currency: row.currency } : {}),
            ...(row.country ? { country: row.country } : {}),
            ...(row.business_verification_status
              ? { businessVerificationStatus: row.business_verification_status }
              : {}),
          };
        }
      } catch {
        // Leave `waba` undefined — see above.
      }
    }

    return {
      // Passed through verbatim. Meta documents only `NOT_STARTED` in the
      // status reference, so mapping the others would be guessing at an enum.
      ...(numberJson.official_business_account?.oba_status
        ? { obaStatus: numberJson.official_business_account.oba_status }
        : {}),
      ...(waba ? { waba } : {}),
    };
  },

  // -------------------------------------------------------------------------
  // QR codes & short links
  //
  // `/{phone-number-id}/message_qrdls`. A code IS the short link's slug, so
  // deleting one breaks any signage already printed with it — Meta shows the
  // customer "this QR code has expired".
  //
  // Note the asymmetry the wire has and the docs don't call out: CREATE and
  // UPDATE return a bare object, LIST and GET wrap rows in `data`. Reading the
  // create response as `data[0]` yields undefined and looks like a failed
  // create that actually succeeded — the caller then retries and burns another
  // of the 2,000-per-number allowance.
  // -------------------------------------------------------------------------

  async listQrCodes(config: MetaSendConfig): Promise<ProviderQrCode[]> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/message_qrdls`;
    const res = await metaFetch(new URL(url), {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta listQrCodes failed: ${res.status} ${text}`, res.status, text);
    }
    const json = (await res.json()) as { data?: MetaQrRow[] };
    return (json.data ?? []).map(normalizeQrRow);
  },

  async createQrCode(
    args: { prefilledMessage: string; imageFormat: "SVG" | "PNG" },
    config: MetaSendConfig,
  ): Promise<ProviderQrCode> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/message_qrdls`;
    const res = await metaFetch(new URL(url), {
      method: "POST",
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        prefilled_message: args.prefilledMessage,
        generate_qr_image: args.imageFormat,
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta createQrCode failed: ${res.status} ${text}`, res.status, text);
    }
    // Bare object, NOT wrapped in `data` — see the block comment above.
    return normalizeQrRow((await res.json()) as MetaQrRow);
  },

  async updateQrCode(
    args: { code: string; prefilledMessage: string },
    config: MetaSendConfig,
  ): Promise<ProviderQrCode> {
    // Same POST edge as create; the presence of `code` is what makes it an edit.
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/message_qrdls`;
    const res = await metaFetch(new URL(url), {
      method: "POST",
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        code: args.code,
        prefilled_message: args.prefilledMessage,
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta updateQrCode failed: ${res.status} ${text}`, res.status, text);
    }
    return normalizeQrRow((await res.json()) as MetaQrRow);
  },

  async deleteQrCode(code: string, config: MetaSendConfig): Promise<void> {
    const url =
      `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}` +
      `/message_qrdls/${encodeURIComponent(code)}`;
    const res = await metaFetch(new URL(url), {
      method: "DELETE",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    // Already gone is success — a repeat delete of a code someone removed in
    // Business Manager must not error.
    if (res.status === 404) return;
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(`meta deleteQrCode failed: ${res.status} ${text}`, res.status, text);
    }
  },

  // -------------------------------------------------------------------------
  // WhatsApp Business Calling
  //
  // Every method shares the `metaFetch` helper (timeout + transient-5xx retry)
  // and the same `Bearer ${accessToken}` pattern as the messaging sends.
  //
  // Two shapes live here, and conflating them was the original sin of this
  // file. CALL SIGNALING is `POST /{phoneNumberId}/calls` with an `action`
  // discriminator (connect / pre_accept / accept / reject / terminate).
  // PERMISSION is not a calling endpoint at all — requesting it is an ordinary
  // interactive MESSAGE, and reading it is `GET /{phoneNumberId}/call_permissions`.
  // There is no `/call_permission_requests` edge; an earlier version invented
  // one, so no permission request ever reached a customer.
  //
  // Send only documented body fields. Graph rejects unknown parameters with
  // `(#100) Invalid parameter`, which turns a stray field into a total request
  // failure rather than a harmless no-op.
  // -------------------------------------------------------------------------

  /**
   * Ask the customer for permission to call them.
   *
   * This is a `type: "interactive"` message on the normal messages endpoint,
   * NOT a calling endpoint — it is billed like any other message and its
   * delivery is reported by the ordinary message-status webhook. Meta renders
   * the Allow/Deny prompt itself; only `body.text` is ours to write.
   *
   * The returned id is the request MESSAGE's wamid, which the customer's
   * `call_permission_reply` webhook echoes back in `context.id`. Persisting it
   * is what lets a grant be matched to the exact request that produced it.
   */
  async sendCallPermissionRequest(
    args: { to?: string; recipient?: string; bodyText?: string },
    config: MetaSendConfig,
  ): Promise<{ permissionRequestId: string; expiresAt: Date }> {
    if (!args.to && !args.recipient) {
      throw new Error(
        "meta sendCallPermissionRequest needs a phone number or a BSUID",
      );
    }
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/messages`;
    const res = await postWhatsappMessages(url, config, {
        messaging_product: "whatsapp",
        ...messagingAccountField(config),
        recipient_type: "individual",
        // `to` takes precedence when both are present (Meta's rule); we send
        // whichever identity the contact actually has. A cold caller Meta
        // hasn't seen in 30 days has only a BSUID.
        ...(args.to ? { to: args.to } : {}),
        ...(args.recipient ? { recipient: args.recipient } : {}),
        type: "interactive",
        interactive: {
          type: "call_permission_request",
          action: { name: "call_permission_request" },
          // Body is optional per Meta, but a bare permission prompt with no
          // context reads as a scam to the customer. Callers always pass one.
          ...(args.bodyText ? { body: { text: args.bodyText } } : {}),
        },
      });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta sendCallPermissionRequest failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    // Message-send response shape: the id lives at messages[0].id.
    const json = (await res.json()) as {
      messages?: Array<{ id?: string }>;
    };
    const permissionRequestId = json.messages?.[0]?.id;
    if (!permissionRequestId) {
      throw new Error(
        `meta sendCallPermissionRequest missing message id: ${JSON.stringify(json)}`,
      );
    }
    // The REQUEST lapses 7 days after delivery if the customer never responds.
    // This is not a grant and must never be treated as one — the grant's own
    // expiry arrives on the reply webhook. (It also expires immediately if we
    // send a newer request, which the caller handles by only ever reading the
    // most recent row.)
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    return { permissionRequestId, expiresAt };
  },

  /**
   * Read the customer's authoritative permission state + live quota.
   *
   * Meta returns `permission.status` plus a per-action `limits[]` breakdown
   * with `can_perform_action` already computed across every window. Trusting
   * that verdict is what keeps us correct when Meta changes a cap — the
   * business-initiated call limit has moved 5 → 10 → 100 in a year, and any
   * number hardcoded here would be wrong again by the next changelog entry.
   */
  async getCallPermission(
    args: { to?: string; recipient?: string },
    config: MetaSendConfig,
  ): Promise<CallPermissionState> {
    if (!args.to && !args.recipient) {
      throw new Error("meta getCallPermission needs a phone number or a BSUID");
    }
    const query = args.to
      ? `user_wa_id=${encodeURIComponent(args.to)}`
      : `recipient=${encodeURIComponent(args.recipient!)}`;
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/call_permissions?${query}`;
    const res = await metaFetch(url, {
      method: "GET",
      // Idempotent read — safe to replay on a transient 5xx, unlike the
      // non-idempotent call/send POSTs.
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta getCallPermission failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as {
      // Meta's own page self-contradicts on the expiry field name: the
      // response SAMPLE spells it `expiration_time`, the response-parameters
      // table spells it `expiration`. Read both, sample spelling first.
      permission?: { status?: string; expiration_time?: number; expiration?: number };
      actions?: Array<{
        action_name?: string;
        can_perform_action?: boolean;
        limits?: Array<{ limit_expiration_time?: number }>;
      }>;
    };
    const rawStatus = json.permission?.status;
    const status: CallPermissionState["status"] =
      rawStatus === "temporary" || rawStatus === "permanent"
        ? rawStatus
        : "no_permission";
    const action = (name: string) =>
      json.actions?.find((a) => a.action_name === name);
    const startCall = action("start_call");
    // Only present when the quota is actually exhausted, which is exactly when
    // we want to tell the agent how long to wait.
    const resetAt = startCall?.limits?.find((l) => l.limit_expiration_time)
      ?.limit_expiration_time;
    return {
      status,
      hasPermission: status !== "no_permission",
      // Absent action ⇒ Meta didn't say no. Fall back to the permission status
      // rather than hard-blocking on a response shape we didn't anticipate.
      canStartCall: startCall?.can_perform_action ?? status !== "no_permission",
      canRequestPermission:
        action("send_call_permission_request")?.can_perform_action ?? true,
      // Permanent permissions carry no expiration at all. Both documented
      // spellings tolerated (see the response type above).
      expiresAt: (() => {
        const expiry =
          json.permission?.expiration_time ?? json.permission?.expiration;
        return status === "temporary" && expiry ? new Date(expiry * 1000) : null;
      })(),
      startCallResetAt: resetAt ? new Date(resetAt * 1000) : null,
    };
  },

  async placeCall(
    args: {
      to?: string;
      recipient?: string;
      sdpOffer: string;
      correlationId?: string;
      recording?: CallRecordingOptions;
      transcription?: CallTranscriptionOptions;
    },
    config: MetaSendConfig,
  ): Promise<{ externalCallId: string }> {
    if (!args.to && !args.recipient) {
      throw new Error("meta placeCall needs a phone number or a BSUID");
    }
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/calls`;
    const res = await metaFetch(url, {
      method: "POST",
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      // Meta's outbound-call shape requires `session.sdp_type=offer` +
      // `session.sdp=<browser RTCPeerConnection.createOffer SDP>`. Without
      // session.* the API returns 131009 "Missing session parameter".
      //
      // These are the ONLY documented fields. A `from` field used to be sent
      // here; it is not part of the contract (Meta always uses the number
      // behind phoneNumberId) and an unknown parameter can fail the request
      // outright.
      body: JSON.stringify({
        messaging_product: "whatsapp",
        // Changelog 2026-06-16: `messaging_account_id` is the preferred Cloud API
        // parameter on messaging **AND CALLING** endpoints. Returns {} when the
        // account carries no id, so the wire stays byte-identical until a tenant
        // is on a multi-Messaging-Account setup.
        ...messagingAccountField(config),
        ...(args.to ? { to: args.to } : {}),
        ...(args.recipient ? { recipient: args.recipient } : {}),
        action: "connect",
        session: { sdp_type: "offer", sdp: args.sdpOffer },
        // Echoed back on every status + terminate webhook for this call, so
        // ingest can match a webhook to our row directly instead of racing the
        // returned call id. Meta caps it at 512 chars; our ids are far shorter.
        ...(args.correlationId
          ? { biz_opaque_callback_data: args.correlationId }
          : {}),
        // Per-call recording opt-in. Omitted entirely when off (the doc's own
        // no-recording form) — `purpose` + `announcement_language` are both
        // REQUIRED when ENABLED, and the consent announcement plays to both
        // parties before recording starts.
        ...(args.recording?.enabled
          ? {
              recording: {
                status: "ENABLED",
                purpose: args.recording.purpose,
                announcement_language: args.recording.announcementLanguage,
              },
            }
          : {}),
        // Independent of recording (own webhook, own artifact). When BOTH are
        // enabled the provider plays one combined announcement using the
        // RECORDING object's language + purpose and ignores this object's.
        ...(args.transcription?.enabled
          ? {
              transcription: {
                status: "ENABLED",
                purpose: args.transcription.purpose,
                announcement_language: args.transcription.announcementLanguage,
              },
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta placeCall failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as {
      calls?: Array<{ id?: string }>;
      // Some Meta variants return id at top level. Belt + suspenders.
      id?: string;
    };
    const externalCallId = json.calls?.[0]?.id ?? json.id;
    if (!externalCallId) {
      throw new Error(`meta placeCall missing call id: ${JSON.stringify(json)}`);
    }
    return { externalCallId };
  },

  async preAcceptCall(
    args: { externalCallId: string; sdpAnswer: string },
    config: MetaSendConfig,
  ): Promise<void> {
    // Meta requires `session.sdp_type=answer + session.sdp=<answer SDP>`
    // on pre_accept just like on accept — verified by Meta error 131009
    // "Missing session parameter" when the body omits session. The two
    // hops (pre_accept → accept) exist for media timing; both carry the
    // same SDP answer. Without this Meta rejects pre_accept with 400 and
    // the call never connects on the answering side.
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/calls`;
    // Idempotent: a fixed (call_id, action) re-issued is a no-op on Meta's side.
    // Keep the transient-blip retry (this is NOT the non-idempotent placeCall).
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        // Changelog 2026-06-16: `messaging_account_id` is the preferred Cloud API
        // parameter on messaging **AND CALLING** endpoints. Returns {} when the
        // account carries no id, so the wire stays byte-identical until a tenant
        // is on a multi-Messaging-Account setup.
        ...messagingAccountField(config),
        call_id: args.externalCallId,
        action: "pre_accept",
        session: { sdp_type: "answer", sdp: args.sdpAnswer },
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta preAcceptCall failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  async acceptCall(
    args: {
      externalCallId: string;
      sdpAnswer: string;
      correlationId?: string;
      recording?: CallRecordingOptions;
      transcription?: CallTranscriptionOptions;
    },
    config: MetaSendConfig,
  ): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/calls`;
    // Idempotent (fixed call_id + action); keep the transient-blip retry.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        // Changelog 2026-06-16: `messaging_account_id` is the preferred Cloud API
        // parameter on messaging **AND CALLING** endpoints. Returns {} when the
        // account carries no id, so the wire stays byte-identical until a tenant
        // is on a multi-Messaging-Account setup.
        ...messagingAccountField(config),
        call_id: args.externalCallId,
        action: "accept",
        session: { sdp_type: "answer", sdp: args.sdpAnswer },
        // Accept is the only inbound action documented to carry this; the
        // terminate webhook echoes it back. Same rule as placeCall: an opaque
        // cuid only — Meta hands the string to every app subscribed to the
        // WABA's calls field, so it must never carry PII.
        ...(args.correlationId
          ? { biz_opaque_callback_data: args.correlationId }
          : {}),
        // Recording rides ACCEPT for inbound calls (not pre_accept). Omitted
        // when off; purpose + announcement_language required when on.
        ...(args.recording?.enabled
          ? {
              recording: {
                status: "ENABLED",
                purpose: args.recording.purpose,
                announcement_language: args.recording.announcementLanguage,
              },
            }
          : {}),
        ...(args.transcription?.enabled
          ? {
              transcription: {
                status: "ENABLED",
                purpose: args.transcription.purpose,
                announcement_language: args.transcription.announcementLanguage,
              },
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta acceptCall failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  async rejectCall(
    args: { externalCallId: string },
    config: MetaSendConfig,
  ): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/calls`;
    // Idempotent (fixed call_id + action); keep the transient-blip retry.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      // call_id + action only. A `reject_reason` used to be appended here; it
      // is not in Meta's contract, and an unknown parameter can fail the whole
      // request — which would leave the customer's phone ringing after the
      // agent declined. Any reason is recorded locally instead.
      body: JSON.stringify({
        messaging_product: "whatsapp",
        // Changelog 2026-06-16: `messaging_account_id` is the preferred Cloud API
        // parameter on messaging **AND CALLING** endpoints. Returns {} when the
        // account carries no id, so the wire stays byte-identical until a tenant
        // is on a multi-Messaging-Account setup.
        ...messagingAccountField(config),
        call_id: args.externalCallId,
        action: "reject",
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta rejectCall failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  async endCall(
    args: { externalCallId: string },
    config: MetaSendConfig,
  ): Promise<void> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/calls`;
    // Idempotent terminate — a repeat on an already-ended call is treated as
    // success below, so the transient-blip retry is safe to keep.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        // Changelog 2026-06-16: `messaging_account_id` is the preferred Cloud API
        // parameter on messaging **AND CALLING** endpoints. Returns {} when the
        // account carries no id, so the wire stays byte-identical until a tenant
        // is on a multi-Messaging-Account setup.
        ...messagingAccountField(config),
        call_id: args.externalCallId,
        action: "terminate",
      }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      // 4xx on an already-terminated call: idempotent treat-as-success so
      // a duplicate hangup from the browser doesn't bubble a confusing
      // error. The Call row's terminal-state CAS already prevents the
      // local mutation; this just keeps the API response clean.
      if (res.status === 404 || /already.*(terminated|ended)/i.test(text)) return;
      throw new MetaSendError(
        `meta endCall failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
  },

  /**
   * Admin helper: enable WhatsApp Cloud API Calling on the phone number.
   *
   * Phone-number-level setting that's REQUIRED before placeCall works
   * (else Meta returns 138000 "Calling API not enabled"). Distinct from
   * the "Display call buttons" toggle in WhatsApp Manager (UI-only).
   *
   * Called once per number per team via POST /api/calls/admin/enable.
   * Safe to re-run — Meta returns success even when already enabled.
   */
  /**
   * Read the current settings on the phone number — used for diagnosing
   * which calling fields are set, what call_hours look like, whether
   * inbound is actually enabled, etc. Phase-1 admin helper.
   */
  async getPhoneNumberSettings(
    config: MetaSendConfig,
  ): Promise<{ raw: unknown }> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/settings`;
    // GET — idempotent diagnostic read, keep the retry.
    const res = await metaFetch(url, {
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    const text = await safeMetaText(res);
    if (!res.ok) {
      throw new MetaSendError(
        `meta getPhoneNumberSettings failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // ignore
    }
    return { raw };
  },

  /**
   * Admin one-shot: turn calling on with defaults that make the number usable
   * immediately — reachable around the clock, call icon shown, and callback
   * permission on (a customer who calls us thereby lets us call them back,
   * which is the cheapest legitimate source of calling permission there is).
   *
   * An admin can narrow any of it afterwards via `updateCallSettings`.
   */
  async enableCalling(config: MetaSendConfig): Promise<{ ok: true; raw: unknown }> {
    const state = await metaProvider.updateCallSettings!(
      {
        enabled: true,
        callIconVisible: true,
        callbackPermissionEnabled: true,
        // No windows ⇒ call hours DISABLED ⇒ open 24/7.
        hours: { timezoneId: "UTC", windows: [] },
      },
      config,
    );
    return { ok: true, raw: state.raw };
  },

  /**
   * Write calling configuration. Only the fields present in `settings` are
   * sent, so this serves both the one-time enable and targeted changes later.
   */
  async updateCallSettings(
    settings: CallSettings,
    config: MetaSendConfig,
  ): Promise<CallSettingsState> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/settings`;
    const calling: Record<string, unknown> = {};
    if (settings.enabled !== undefined) {
      calling.status = settings.enabled ? "ENABLED" : "DISABLED";
    }
    if (settings.callIconVisible !== undefined) {
      calling.call_icon_visibility = settings.callIconVisible
        ? "DEFAULT"
        : "DISABLE_ALL";
    }
    if (settings.callbackPermissionEnabled !== undefined) {
      calling.callback_permission_status = settings.callbackPermissionEnabled
        ? "ENABLED"
        : "DISABLED";
    }
    if (settings.callIconCountries !== undefined) {
      // Empty array is meaningful — Meta's documented way to CLEAR the
      // restriction ("no restriction: []"), so pass it through, don't skip it.
      calling.call_icons = {
        restrict_to_user_countries: settings.callIconCountries,
      };
    }
    if (settings.voicemail !== undefined) {
      calling.voicemail = settings.voicemail.enabled
        ? {
            status: "ENABLED",
            triggers: settings.voicemail.triggers ?? [],
            audio: {
              default: {
                // Kept as the string the media upload returned — the ids sit
                // near the 2^53 boundary, so a Number round-trip could
                // silently corrupt one.
                announcement_media_id: settings.voicemail.announcementMediaId,
                ...(settings.voicemail.timeoutSeconds !== undefined
                  ? { timeout_seconds: settings.voicemail.timeoutSeconds }
                  : {}),
              },
            },
          }
        : { status: "DISABLED" };
    }
    if (settings.hours !== undefined) {
      // No windows ⇒ reachable around the clock, which Meta expresses as call
      // hours DISABLED ("if call hours are disabled, your business is
      // considered open all 24 hours of the day, 7 days a week"). Do NOT model
      // 24/7 as a 0000-2359 window: times are minute-granular, so that leaves
      // calls refused for the last minute of every day, and no widening closes
      // the gap.
      if (settings.hours.windows.length) {
        const callHours: Record<string, unknown> = {
          status: "ENABLED",
          timezone_id: settings.hours.timezoneId,
          weekly_operating_hours: settings.hours.windows.map((w) => ({
            day_of_week: w.dayOfWeek,
            open_time: w.openTime,
            close_time: w.closeTime,
          })),
        };
        // A call_hours POST is a REPLACE, not a merge — Meta deletes any
        // stored holiday_schedule the request doesn't carry. We don't author
        // holidays, so read the current ones and echo them back verbatim, or
        // an hours edit here silently wipes a schedule the admin configured
        // in WhatsApp Manager. A failed read aborts the write (loud) rather
        // than proceeding to a silent wipe. Past dates are dropped from the
        // echo: they're inert, and Meta rejects "a past date" on POST — one
        // stale entry would otherwise brick every future hours update.
        const current = await metaProvider.getCallSettings!(config);
        const holidays = (current.raw as { calling?: MetaCallingSettings } | null)
          ?.calling?.call_hours?.holiday_schedule;
        if (holidays?.length) {
          // "Today" in the business's own call-hours timezone, not UTC — a
          // zone behind UTC would otherwise lose the final hours of an
          // in-progress holiday override.
          let today: string;
          try {
            today = new Intl.DateTimeFormat("en-CA", {
              timeZone: settings.hours.timezoneId,
            }).format(new Date());
          } catch {
            today = new Date().toISOString().slice(0, 10);
          }
          const upcoming = holidays.filter((h) => !h.date || h.date >= today);
          if (upcoming.length) callHours.holiday_schedule = upcoming;
        }
        calling.call_hours = callHours;
      } else {
        calling.call_hours = { status: "DISABLED" };
      }
    }
    // Idempotent settings write — Meta returns success even when the value is
    // already set, so the transient-blip retry is safe.
    const res = await metaFetch(url, {
      method: "POST",
      retry: true,
      appSecret: config.appSecret,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify({ calling }),
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      throw new MetaSendError(
        `meta updateCallSettings failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    // Read back rather than echoing our own input: Meta normalizes some values,
    // and the response is where restrictions live.
    return metaProvider.getCallSettings!(config);
  },

  async getCallSettings(config: MetaSendConfig): Promise<CallSettingsState> {
    const url = `${GRAPH_BASE}/${config.graphVersion}/${config.phoneNumberId}/settings`;
    const res = await metaFetch(url, {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    const text = await safeMetaText(res);
    if (!res.ok) {
      throw new MetaSendError(
        `meta getCallSettings failed: ${res.status} ${text}`,
        res.status,
        text,
      );
    }
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // Keep the string — the caller surfaces it verbatim for diagnosis.
    }
    const calling = (raw as { calling?: MetaCallingSettings } | null)?.calling;
    const hours = calling?.call_hours;
    return {
      enabled: calling?.status === "ENABLED",
      // Absent ⇒ Meta's default, which is to show the icon. HIDE_IN_CHAT is a
      // third value the consumer-client FAQ reveals (icon hidden in the chat
      // bar) — read it as hidden too, or a number configured that way in
      // WhatsApp Manager renders as "visible" in our settings UI.
      callIconVisible:
        calling?.call_icon_visibility !== "DISABLE_ALL" &&
        calling?.call_icon_visibility !== "HIDE_IN_CHAT",
      callbackPermissionEnabled:
        calling?.callback_permission_status === "ENABLED",
      // Call hours DISABLED means "open 24/7", which we model as no windows.
      hours:
        hours?.status === "ENABLED"
          ? {
              timezoneId: hours.timezone_id ?? "UTC",
              windows: (hours.weekly_operating_hours ?? []).flatMap((w) =>
                w.day_of_week && w.open_time && w.close_time
                  ? [
                      {
                        dayOfWeek: w.day_of_week as CallHoursWindow["dayOfWeek"],
                        openTime: w.open_time,
                        closeTime: w.close_time,
                      },
                    ]
                  : [],
              ),
            }
          : null,
      callIconCountries:
        calling?.call_icons?.restrict_to_user_countries?.filter(
          (c): c is string => typeof c === "string",
        ) ?? [],
      sipEnabled: calling?.sip?.status === "ENABLED",
      srtpKeyExchangeProtocol: calling?.srtp_key_exchange_protocol ?? null,
      voicemail: calling?.voicemail
        ? {
            enabled: calling.voicemail.status === "ENABLED",
            triggers: (calling.voicemail.triggers ?? []).filter(
              (t): t is string => typeof t === "string",
            ),
            announcementMediaId:
              calling.voicemail.audio?.default?.announcement_media_id != null
                ? String(calling.voicemail.audio.default.announcement_media_id)
                : null,
            timeoutSeconds:
              calling.voicemail.audio?.default?.timeout_seconds ?? null,
          }
        : null,
      // A restricted number rejects every call attempt. Without surfacing this,
      // a paused tenant sees only a string of unexplained failures.
      restrictions: (calling?.restrictions?.restrictions_list ?? []).flatMap(
        (r) =>
          r.type
            ? [
                {
                  type: r.type,
                  reason: r.reason ?? "",
                  expiresAt: r.expiration ? new Date(r.expiration * 1000) : null,
                },
              ]
            : [],
      ),
      raw,
    };
  },

};

// Send-error classification moved to `meta-send-error.ts` (shared with the
// social providers). Re-exported here so every existing `@/lib/providers/meta`
// import keeps working. Imported at the top for meta.ts's own `throw`s.
export {
  MetaSendError,
  normalizeMetaSendError,
  isProvablyNotSent,
  isPairRateLimitBody,
  isPairRateLimitError,
};
export type { MetaErrorCode, NormalizedSendError } from "./meta-send-error";

/**
 * minor#3: thrown by `fetchMedia` when the response Content-Length already
 * exceeds the caller's cap, BEFORE the binary is buffered into heap. Distinct
 * type so the caller maps it to a NON-retriable drop (re-downloading yields the
 * same over-cap bytes) instead of parking it for the sweeper to retry forever.
 */
export class MediaTooLargeError extends Error {
  readonly declaredBytes: number;
  readonly maxBytes: number;
  constructor(declaredBytes: number, maxBytes: number) {
    super(`inbound media over cap before download: ${declaredBytes} > ${maxBytes}`);
    this.name = "MediaTooLargeError";
    this.declaredBytes = declaredBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Thrown by fetchTemplates when the team hasn't pasted a WABA id yet. The
 * templates route catches this and returns a 409 + actionable message
 * pointing the admin at /settings/whatsapp.
 */
export class MissingWabaIdError extends Error {
  constructor() {
    super("WhatsApp Business Account id is not configured for this team");
    this.name = "MissingWabaIdError";
  }
}

/**
 * Thrown by `uploadHeaderMedia` when the team hasn't pasted a Meta App ID
 * yet. The /templates create route catches this and asks the admin to add it
 * in /settings/whatsapp — same pattern as MissingWabaIdError.
 */
export class MissingAppIdError extends Error {
  constructor() {
    super("Meta App ID is not configured for this team");
    this.name = "MissingAppIdError";
  }
}

/** One `message_qrdls` row as Meta returns it. */
interface MetaQrRow {
  code?: string;
  prefilled_message?: string;
  deep_link_url?: string;
  qr_image_url?: string;
}

function normalizeQrRow(row: MetaQrRow): ProviderQrCode {
  return {
    code: row.code ?? "",
    prefilledMessage: row.prefilled_message ?? "",
    // Meta returns this on every shape, but deriving it from `code` as a
    // fallback keeps the UI's copy button working if it ever stops.
    deepLinkUrl: row.deep_link_url ?? `https://wa.me/message/${row.code ?? ""}`,
    ...(row.qr_image_url ? { qrImageUrl: row.qr_image_url } : {}),
  };
}

export {
  countTemplatePlaceholders,
  renderTemplateBody,
} from "@ccp/shared/template-render";

/**
 * Fallback wire shape for template analytics: the nested field expansion on
 * the WABA node. Used only when the `/template_analytics` edge 400s with an
 * unknown-path error (older Graph versions / partial rollouts). No pagination
 * here — the field form buries its cursor — which is exactly why the edge
 * form is primary.
 */
/**
 * Fallback wire shape for template analytics: the nested field expansion on
 * the WABA node. Used only when the `/template_analytics` edge 400s with an
 * unknown-path error (older Graph versions / partial rollouts). No pagination
 * here — the field form buries its cursor — which is exactly why the edge
 * form is primary.
 */
async function fetchTemplateAnalyticsViaFieldExpansion(
  args: { ids: string[]; startSec: number; endSec: number },
  config: MetaSendConfig,
): Promise<ProviderTemplateAnalyticsRow[]> {
  const field =
    `template_analytics.start(${args.startSec}).end(${args.endSec}).granularity(DAILY)` +
    `.metric_types(["SENT","DELIVERED","READ","CLICKED","COST"])` +
    `.template_ids([${args.ids.map((id) => JSON.stringify(id)).join(",")}])`;
  const url = new URL(
    `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId!)}`,
  );
  url.searchParams.set("fields", field);
  const res = await metaFetch(url, {
    method: "GET",
    retry: true,
    appSecret: config.appSecret,
    headers: { authorization: `Bearer ${config.accessToken}` },
  });
  if (!res.ok) {
    const text = await safeMetaText(res);
    throw new MetaSendError(
      `meta fetchTemplateAnalytics failed: ${res.status} ${text}`,
      res.status,
      text,
    );
  }
  const json = (await res.json()) as { template_analytics?: unknown };
  return parseTemplateAnalytics(json);
}
async function fetchWabaAnalyticsField(
  field: string,
  spec: string,
  config: MetaSendConfig,
): Promise<Array<Record<string, unknown>>> {
  const url = new URL(
    `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId!)}`,
  );
  url.searchParams.set("fields", spec);
  // Idempotent read — the transient-blip retry is safe.
  const res = await metaFetch(url, {
    method: "GET",
    retry: true,
    appSecret: config.appSecret,
    headers: { authorization: `Bearer ${config.accessToken}` },
  });
  if (!res.ok) {
    const text = await safeMetaText(res);
    throw new MetaSendError(`meta ${field} failed: ${res.status} ${text}`, res.status, text);
  }
  return analyticsDataPoints(await res.json(), field);
}

/**
 * Read one analytics EDGE, following pagination, falling back to the field form.
 *
 * The edge is primary for the same reason it is for `template_analytics`: only
 * the edge response carries a top-level `paging` object, and a year of DAILY
 * data broken out by country and category runs to thousands of points — whatever
 * falls past an unfollowed cursor silently vanishes and reads as "we didn't send
 * that month" forever.
 *
 * The fallback is not defensive padding. Meta documents these three surfaces in
 * its GUIDE using only the field-expansion form while the Graph REFERENCE
 * documents them as edges, and `template_analytics` has been observed rejecting
 * the edge path on some accounts with an unknown-path 400. One shape
 * disagreement must not cost the account its cost reporting.
 */
async function fetchWabaAnalyticsEdge(
  field: string,
  params: Record<string, string>,
  fieldSpec: string,
  config: MetaSendConfig,
): Promise<Array<Record<string, unknown>>> {
  const first = new URL(
    `${GRAPH_BASE}/${config.graphVersion}/${encodeURIComponent(config.wabaId!)}/${field}`,
  );
  for (const [k, v] of Object.entries(params)) first.searchParams.set(k, v);

  const points: Array<Record<string, unknown>> = [];
  let url: URL | null = first;
  // Bounded like the template-analytics loop: a malformed `next` must not fetch
  // forever.
  //
  // The ceiling was 50, with the comment "far past any real window" — which the
  // same module's own request refutes. These surfaces are asked for FIVE dimensions
  // (pricing category x type x country x tier x phone) per time bucket, so a
  // business messaging 20 countries over 90 days at daily granularity multiplies
  // into tens of thousands of points. At Graph's small default page size, 50 pages
  // silently kept the first slice and `messagingCost` was summed over it — a cost
  // total short by an order of magnitude, rendered as "Total cost" with no hint that
  // anything was missing. Raised far enough that truncation is unreachable for a
  // real window, and it now WARNS if it ever is, because a wrong money figure
  // presented confidently is the worst outcome here.
  const MAX_PAGES = 400;
  let page = 0;
  for (; url && page < MAX_PAGES; page++) {
    const res = await metaFetch(url, {
      method: "GET",
      retry: true,
      appSecret: config.appSecret,
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      const text = await safeMetaText(res);
      if (
        page === 0 &&
        res.status === 400 &&
        isGraphShapeDisagreement(text)
      ) {
        return fetchWabaAnalyticsField(field, fieldSpec, config);
      }
      throw new MetaSendError(`meta ${field} failed: ${res.status} ${text}`, res.status, text);
    }
    const json = (await res.json()) as { paging?: { next?: unknown } };
    points.push(...analyticsDataPoints(json, field));
    const next = typeof json.paging?.next === "string" ? json.paging.next : null;
    // Follow only cursors that stay on Graph — a response-supplied URL never
    // gets to point this token anywhere else.
    url = next && next.startsWith(`${GRAPH_BASE}/`) ? new URL(next) : null;
  }
  if (url) {
    // Still more pages at the ceiling. Every total derived from these points is now
    // an UNDER-count, and cost is one of them — say so loudly rather than let a
    // short number render as authoritative spend.
    console.warn(
      JSON.stringify({
        event: "meta.analytics_truncated",
        severity: "warning",
        field,
        pages: page,
        points: points.length,
        note: "hit the page ceiling — totals derived from this response UNDER-report",
      }),
    );
  }
  return points;
}

// Stage 2 re-exports: webhook parsing lives in meta-webhook-parse.ts.
export { parseBlockUsersResponse, scanWhatsappEnvelope } from "./meta-webhook-parse";

// Stage 1 of the meta.ts split: template parse/build helpers live in
// meta-template-parse.ts; re-exported here so no import site changes.
export {
  analyticsDataPoints,
  buildTemplateSendComponents,
  lowercaseComponentForCreate,
  parseTemplateAnalytics,
  parseTemplateComparison,
  parseTierBounds,
} from "./meta-template-parse";
import {
  HISTORY_DECLINED_CODE,
  digitsOnly,
  mapHistoryStatus,
  mapMetaStatus,
  parseChannelHealthUpdate,
  parseMetaCall,
  parseMetaCallPermissionReply,
  parseMetaCallStatus,
  parseTemplateCategoryUpdate,
  parseTemplateQualityUpdate,
  parseTemplateStatusUpdate,
  tsFromMeta,
  MetaContact,
  MetaChangeValue,
  MetaMessage,
  MetaContactsPayload,
  MetaMediaPayload,
} from "./meta-webhook-parse";
import {
  buildTemplateSendComponents,
  unixSeconds,
  str,
  parseTierBounds,
  numOrZero,
  num,
  graphListArg,
  graphJsonParam,
  analyticsDataPoints,
  isObject,
  isHeldForQualityAssessment,
  lowercaseComponentForCreate,
  mapTemplateCategory,
  mapTemplateStatus,
  normalizeLibraryTemplate,
  normalizeMetaTemplate,
  parseTemplateAnalytics,
  parseTemplateComparison,
  type MetaTemplateRow,
} from "./meta-template-parse";
