/**
 * Shared inbound-parse + outbound-send for the Meta SOCIAL channels (Facebook
 * Messenger, Instagram DM). Both are the same wire shape — the only real
 * differences are the webhook `object` discriminator and which business-account
 * id addresses the send — so the logic lives here once and each provider is a
 * thin wrapper (`messenger.ts`, `instagram.ts`). Two live channels make this a
 * real seam, not speculative abstraction.
 *
 *   - Inbound: `{ object, entry[].messaging[] }`. Identity = the opaque sender
 *     id (Messenger PSID / Instagram IGSID), NEVER a phone (never digit-stripped).
 *   - Outbound: `POST /{ACCOUNT_ID}/messages` with `recipient:{id}` and the
 *     Human Agent tag (valid across the 7-day support window; every send in an
 *     agent-operated shared inbox is a human agent reply).
 *
 * Scope (current): inbound and outbound TEXT + MEDIA (image / video / audio /
 * document / sticker; reels ingest as video), delivery + read receipts,
 * reactions, quoted replies, unsend, Messenger message edits, native-inbox
 * echoes, postbacks, ad/deep-link referral attribution, interactive quick
 * replies with phone/email consent chips, and Messenger Calling. Attachments
 * with no downloadable binary (location, shared post, appointment booking,
 * fallback) still render as a labelled placeholder body.
 */

import type {
  CallActionArgs,
  CallActionResult,
  NormalizedCallEvent,
  NormalizedEvent,
  NormalizedInboundMessage,
  NormalizedMediaRef,
  NormalizedReaction,
  NormalizedMessageFeedback,
  NormalizedStatusUpdate,
  ChannelEntryPoints,
  ChannelIceBreaker,
  ChannelMenuItem,
  ContactShareField,
  GenericTemplateCard,
  SendInteractiveArgs,
  SendMediaArgs,
  SendReactionArgs,
  SendTextArgs,
  SendTextResult,
  SocialCallPermission,
  UploadMediaArgs,
  UploadMediaResult,
} from "@ccp/shared/providers/types";
import type { MediaKind, MessageAttribution, MessageStructured, SocialProfile } from "@ccp/shared/types";
import {
  GRAPH_BASE,
  graphDeleteJson,
  graphGetJson,
  graphPostForm,
  graphPostJson,
} from "@/lib/providers/meta-graph";
import { kindFromMime } from "@/lib/media-storage";
import {
  blocksMessaging,
  messagingRestrictionExpiry,
  parsePageIntegrity,
} from "@/lib/providers/messenger-integrity";

/** Shared identity of the Meta account addressing a send (Page id / IG id). */
export interface SocialSendTarget {
  accountId: string;
  accessToken: string;
  graphVersion: string;
  /** Provider name for error messages ("messenger" / "instagram"). */
  label: string;
  /** This channel's app secret, for appsecret_proof on Graph calls (optional —
   *  proof is skipped when absent). Must be the secret of the app that issued
   *  `accessToken` (the channel's OWN stored secret; IG may be a different app). */
  appSecret?: string;
}

/**
 * Widen a parsed wire object to `NormalizedEvent.rawPayload`.
 *
 * `rawPayload` is `Record<string, unknown>` (we keep the original body verbatim —
 * CLAUDE.md §7), while the wire shapes above are INTERFACES, which TypeScript
 * denies an implicit index signature. Every one of the ~16 `rawPayload:` sites
 * therefore reached for `as unknown as Record<string, unknown>` — a double
 * assertion repeated until it read as house style, and each one silently
 * accepted a non-object too.
 *
 * Constraining to `T extends object` makes ONE ordinary assertion sufficient, so
 * the widening is stated once, in a named place, and the call sites carry no
 * casts at all. Zero-copy on purpose: this is the inbound hot path and the value
 * is only ever serialised to JSONB.
 */
function rawPayloadOf<T extends object>(value: T): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * Map our channel-agnostic MediaKind (and, for uploads, a mime type) to Meta's
 * social attachment `type`. Meta uses `file` for documents and folds stickers
 * into `image`. Both the upload and the send must agree on the type, so both
 * derive it deterministically.
 */
function attachmentTypeFromKind(kind: MediaKind): "image" | "video" | "audio" | "file" {
  switch (kind) {
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "document":
      return "file";
    case "image":
    case "sticker":
    default:
      return "image";
  }
}

interface SocialEnvelope {
  object?: string;
  entry?: SocialEntry[];
}
interface SocialEntry extends Pick<PageIntegrityWire, "restrictions"> {
  id?: string;
  time?: number;
  messaging?: MessagingEvent[];
  // Messenger Calling lifecycle events (connect / call_status / media_update /
  // terminate) ride their own array on the entry.
  calls?: SocialCallWire[];
  // Business-initiated call permission opt-in reply lands at the entry level.
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  call_permission_reply?: { response?: string; expiration_timestamp?: number | string };
}
/** One item of `entry.calls[]` — union of the four call lifecycle events. */
interface SocialCallWire {
  id?: string;
  event?: string; // connect | call_status | media_update | terminate
  to?: string;
  from?: string;
  recipient_id?: string;
  call_direction?: string; // business_initiated | user_initiated
  call_status?: string; // ringing | accepted
  status?: string; // Completed | Failed (terminate)
  start_time?: number;
  end_time?: number;
  duration?: number;
  timestamp?: number;
  session?: {
    version?: number;
    sdp_renegotiation?: { sdp_type?: string; sdp?: string };
  };
}
/**
 * One entry of `message.attachments[]`. Deliberately a NAMED type rather than an
 * inline shape: the inbound branch, the echo branch and every structured helper
 * below all read it, and they must agree on which fields exist — the appointment
 * fields were being dropped precisely because only some readers knew about them.
 */
interface SocialAttachment {
  type?: string;
  title?: string;
  payload?: {
    url?: string;
    coordinates?: { lat?: number; long?: number };
    /** post / ig_post — the shared post's id. */
    id?: string;
    /** appointment_booking (2026-03-03). */
    booking_id?: string;
    status?: string;
    start_time?: number;
    end_time?: number;
    timezone?: string;
  };
}

/**
 * Page INTEGRITY fields, which ride `entry[].messaging[]` alongside real messages
 * despite being about the Page rather than a conversation. Declared on the wire
 * type rather than cast at the read site: they are documented fields of this
 * exact envelope (Page Integrity API & Webhook), so the interface is where they
 * belong, and a cast would hide them from anyone reading the shape.
 */
interface PageIntegrityWire {
  /** ok | warning | restricted | suspended. */
  status?: string;
  violations?: unknown[];
  restrictions?: unknown[];
  action_events?: unknown[];
  actions_events?: unknown[];
}

/**
 * Handover Protocol fields (`messaging_handovers`). Four sub-events about WHO
 * MAY REPLY, none of which carries a message.
 */
interface HandoverWire {
  pass_thread_control?: {
    previous_owner_app_id?: string | number | null;
    new_owner_app_id?: string | number | null;
    metadata?: string;
  };
  take_thread_control?: {
    previous_owner_app_id?: string | number | null;
    new_owner_app_id?: string | number | null;
    metadata?: string;
  };
  request_thread_control?: { requested_owner_app_id?: string | number; metadata?: string };
  app_roles?: Record<string, unknown>;
}

interface MessagingEvent extends PageIntegrityWire, HandoverWire {
  sender?: { id?: string };
  /**
   * `messaging_policy_enforcement` — Meta warning/blocking/unblocking the Page
   * from messaging. `reason` explains a warning or a block and is absent on an
   * unblock.
   */
  policy_enforcement?: { action?: string; reason?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    // The customer UNSENT this message (Messenger/Instagram). References an
    // existing `mid`; carries no new content — we tombstone the stored row.
    is_deleted?: boolean;
    // The customer sent media/content the Instagram Messaging API can't
    // represent (`is_unsupported`). Carries no text/attachment we can render, so
    // without a label it would commit an EMPTY inbound bubble ("Attachment
    // unavailable"); we surface a clear placeholder instead.
    is_unsupported?: boolean;
    // `title` + `payload.coordinates` ride on a `type:"location"` share (a
    // customer tapping "Send Location"); every other attachment uses
    // `payload.url`. Widened here so the location branch can lift coordinates
    // into a structured map card (see socialStructuredFromAttachments).
    //
    // Per the CURRENT `messages` webhook reference (re-verified 2026-07-30), the
    // payload fields are scoped per attachment type:
    //   url            → audio, file, image, video, fallback, reel, ig_reel,
    //                    post, ig_post (and sticker)
    //   title          → fallback, reel, ig_reel, post, ig_post
    //   sticker_id     → sticker (and, until 2026-08-30, image)
    //   booking_id / status / start_time / end_time / timezone
    //                  → appointment_booking
    attachments?: SocialAttachment[];
    quick_reply?: { payload?: string };
    // Set when the customer quoted a message — the mid they replied to.
    // A quoted reply to a message (`mid`) OR — Instagram only — a reply to one of
    // OUR stories, which arrives as a normal text message with `reply_to.story`
    // (no mid). We surface the latter as a story-reply card so the agent sees the
    // context, not a bare text bubble.
    reply_to?: { mid?: string; story?: { url?: string; id?: string } };
    // Instagram nests ad/deep-link attribution INSIDE the first message
    // (`message.referral`) — a Click-to-Instagram-Direct ad or an Instagram-Shop
    // product referral — whereas Messenger delivers it as a sibling `referral`
    // messaging event. Read both so IG's "from your ad" attribution isn't lost.
    referral?: SocialReferral;
  };
  // The customer EDITED a message. Carries the new text for an existing `mid`.
  //
  // BOTH channels ship this, under DIFFERENT field names — corrected 2026-07-30
  // against `devtools_webhook_list{list_topics}`: the `page` topic carries
  // `message_edits` (plural) and the `instagram` topic carries `message_edit`
  // (singular), and our dev app subscribes both. The note here previously said
  // "MESSENGER ONLY — Instagram ships no edit webhook, so an IG message's text is
  // immutable once received", which would have led the next reader to delete the
  // IG path. The branch itself is object-agnostic, so IG edits already parse fine.
  //
  // The singular/plural split is a general trap on these two topics: `page` also
  // has `messaging_handovers`/`messaging_referrals` where `instagram` has
  // `messaging_handover`/`messaging_referral`.
  message_edit?: { mid?: string; text?: string; num_edit?: number };
  /**
   * `messaging_optins`. `ref` is the pass-through payload from an m.me link or the
   * checkbox plugin; `user_ref` identifies a checkbox-plugin user who has NO PSID
   * yet; `one_time_notif_token` is a single-use send permission. Typed for wire
   * completeness — see the explicit not-ingested branch in the parser.
   */
  optin?: { ref?: string; user_ref?: string; one_time_notif_token?: string };
  delivery?: { mids?: string[]; watermark?: number };
  // Messenger sends a `watermark` (all outbound up to it are read); Instagram
  // sends a per-message `mid` (the specific message the customer read).
  read?: { watermark?: number; mid?: string };
  reaction?: { mid?: string; action?: string; emoji?: string; reaction?: string };
  // Messenger's 👍/👎 "message feedback" on a BUSINESS message. Customers can't
  // emoji-react to a message the Page sent — Meta shows the thumbs instead — so
  // this IS their reaction to our outbound. `feedback` is "Good response" /
  // "Bad response"; `mid` is the message they rated.
  response_feedback?: { feedback?: string; mid?: string };
  // A postback: the customer tapped a Get-Started button, a persistent-menu
  // item, or a structured-message button whose `payload` we authored. Parallel
  // to `quick_reply` on a message, but a top-level messaging event. `mid` is
  // present for button postbacks; Get-Started has none, so we synthesize a
  // dedup id from sender+timestamp.
  postback?: { mid?: string; title?: string; payload?: string; referral?: SocialReferral };
  // Ad / deep-link attribution at the messaging-event level (sibling to
  // `message`) — Click-to-Messenger ad or an m.me `ref` link. Drives the "from
  // your ad" chip; attached to the inbound message it rides in on.
  referral?: SocialReferral;
}

/**
 * Ad / deep-link attribution attached to an inbound. Messenger delivers it as a
 * top-level `referral` messaging event (m.me links, Click-to-Messenger ads,
 * checkbox plugin) or nested under the first message / a Get-Started postback.
 * Captured so an ad-sourced conversation shows its source. Wired into ingest in
 * Phase 3 (receive enhancements).
 */
interface SocialReferral {
  ref?: string;
  source?: string;
  type?: string;
  ad_id?: string;
  /**
   * "The URI of the site where the message was sent" (`messaging_referrals`
   * reference). For an m.me link this is the page the customer clicked FROM —
   * the only signal that says which of your landing pages actually converts.
   */
  referer_uri?: string;
  ads_context_data?: Record<string, unknown>;
  /**
   * INSTAGRAM ONLY — the Shop product the customer opened the thread from. Meta's
   * `messages` webhook reference documents it verbatim as
   * `"referral": { "product": { "id": "PRODUCT-ID" } }`, with the comment
   * "Included when a customer clicks an Instagram Shop product". It is a referral
   * with neither `ad_id` nor `ref`, so it was previously read as an attribution
   * with source `unknown` and no data at all.
   */
  product?: { id?: string };
  /**
   * The Welcome Message flow the referral came through. Added to the referral
   * webhooks 2025-02-24 ("`messaging_referrals` webhook now contains `flow_id`
   * for ad referrals from Welcome Message flows").
   */
  flow_id?: string;
}

/**
 * Map a Messenger `referral` to the channel-agnostic `MessageAttribution` (the
 * same shape WhatsApp Click-to-WhatsApp fills), so the "from your ad" chip works
 * identically across channels. `ad_id` ⇒ a paid ad; otherwise the `ref` deep-link
 * payload (m.me/checkbox plugin). `ads_context_data` sometimes carries the ad
 * creative's title/photo — surface the title as the headline when present.
 */
function attributionFromSocialReferral(r: SocialReferral): MessageAttribution {
  const ctx = (r.ads_context_data ?? {}) as {
    ad_title?: unknown;
    // Documented on `ads_context_data` and previously all discarded. Each answers
    // a question a campaign report is actually asked: WHICH post drove this, and
    // WHICH product was the customer looking at when they wrote in.
    post_id?: unknown;
    product_id?: unknown;
    // Meta's other spelling of the same creative: `photo_url` here vs WhatsApp's
    // `image_url`. Unified onto one field so a report does not have to know
    // which channel a customer arrived on.
    photo_url?: unknown;
    video_url?: unknown;
  };
  const headline =
    typeof ctx.ad_title === "string" && ctx.ad_title.trim() ? ctx.ad_title.trim() : undefined;
  const productId = r.product?.id?.trim();
  // An Instagram Shop product referral is ORGANIC — the customer tapped a product
  // in the shop, not an ad — so it maps to `post`, the source the UI already
  // labels "Started from a post". Calling it `unknown` sent it down the chip's
  // else-branch, which says "From your ad" about a shopper who clicked no ad.
  const source: MessageAttribution["source"] = r.ad_id
    ? "ad"
    : productId
      ? "post"
      : r.ref
        ? "ref"
        : "unknown";
  return {
    source,
    ...(headline ? { headline } : {}),
    // Messenger's `ad_id` is an AD id, so it belongs in `adId`. It used to be
    // written to `clickId`, which meant "group by ad" silently compared a
    // Messenger ad id against a WhatsApp per-click id and matched nothing.
    ...(r.ad_id?.trim() ? { adId: r.ad_id.trim() } : {}),
    ...(r.ref?.trim() ? { ref: r.ref.trim() } : {}),
    // The ad's product beats the Instagram-Shop one only as a fallback: they are
    // different referral shapes and only one is ever present.
    ...(productId ?? str(ctx.product_id)
      ? { productId: (productId ?? str(ctx.product_id))! }
      : {}),
    ...(str(ctx.post_id) ? { postId: str(ctx.post_id)! } : {}),
    ...(str(ctx.photo_url) ? { imageUrl: str(ctx.photo_url)!, mediaType: "image" as const } : {}),
    ...(str(ctx.video_url) ? { videoUrl: str(ctx.video_url)!, mediaType: "video" as const } : {}),
    // Where they came FROM. `referer_uri` for an m.me link; for an ad Meta gives
    // no landing URL, so this stays absent rather than being invented.
    ...(str(r.referer_uri) ? { sourceUrl: str(r.referer_uri)! } : {}),
    ...(r.flow_id?.trim() ? { flowId: r.flow_id.trim() } : {}),
  };
}

/** Trimmed string, or null — for the referral fields Meta types loosely. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Resolve a Messenger/Instagram reaction webhook into the emoji to STORE, or
 * `null` to CLEAR it.
 *
 * The ONLY reliable "add" signal is a real emoji GLYPH (a non-ASCII char). Meta
 * sends the glyph on every genuine react — standard AND custom/"other". A remove
 * drops the glyph. Crucially, Instagram reports a REMOVE by keeping the stale
 * reaction TYPE name ("love"/"other") while dropping the glyph and often WITHOUT
 * `action:"unreact"` — so trusting the type name (the old behavior) both rendered
 * the literal word "other" AND resurrected a reaction the customer had removed
 * (the "IG unreact never clears" bug). Therefore: a real glyph → add that glyph;
 * ANYTHING ELSE (explicit unreact, empty/missing glyph, a bare type name) →
 * `null` = clear. An explicit unreact action short-circuits first for clarity.
 */
function socialReactionEmoji(
  action: string | undefined,
  emoji: string | undefined,
  _type: string | undefined,
): string | null {
  const a = (action ?? "").trim().toLowerCase();
  if (a === "unreact" || a === "remove" || a === "delete") return null;
  if (emoji && [...emoji].some((c) => (c.codePointAt(0) ?? 0) > 127)) return emoji;
  // No real glyph — a removal (or an un-renderable type-only payload). Clear it.
  return null;
}

/** Map a Meta social attachment `type` to our channel-agnostic MediaKind. */
function attachmentKind(type: string | undefined): MediaKind | null {
  switch (type) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "file":
      return "document";
    case "sticker":
      return "sticker";
    // A reel share is a video Meta hands us as a plain CDN url.
    case "reel":
    case "ig_reel":
      return "video";
    // "location" | "template" | "fallback" | "post" | "ig_post" |
    // "appointment_booking" carry no downloadable binary — they render as a
    // labelled placeholder via socialAttachmentLabel().
    default:
      return null;
  }
}

/**
 * Pick the attachment we render as this message's media.
 *
 * Until 2026-08-30 Meta sends a sticker message as BOTH a `sticker` attachment
 * (carrying `payload.sticker_id`) and an `image` attachment; after that date only
 * `sticker` is sent. Preferring `sticker` makes the cutover a no-op — before and
 * after, a sticker ingests as kind `sticker` — instead of silently degrading to
 * an untyped image today and to a bare text label after the transition ends.
 */
function pickMediaAttachment<T extends { type?: string; payload?: { url?: string } }>(
  atts: T[],
): T | undefined {
  const downloadable = atts.filter((a) => attachmentKind(a.type) && a.payload?.url);
  return downloadable.find((a) => a.type === "sticker") ?? downloadable[0];
}

/** Provisional mime type before the download reads the real Content-Type. */
function provisionalMime(kind: MediaKind): string {
  switch (kind) {
    case "image":
      return "image/jpeg";
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/mpeg";
    // Stickers are webp everywhere on Meta, and the mime-guard only accepts
    // image/webp for kind `sticker` — an octet-stream provisional would be
    // rejected at download time.
    case "sticker":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/**
 * Build a NormalizedMediaRef for the first downloadable attachment on a message,
 * or null if there is none (text-only, or a non-binary attachment). Social
 * channels deliver a direct CDN URL (`payload.url`), so we set `sourceUrl` and
 * leave `externalMediaId` empty — the inbound-media path fetches the URL.
 */
function attachmentMedia(
  atts: { type?: string; payload?: { url?: string } }[] | undefined,
): NormalizedMediaRef | null {
  const att = atts ? pickMediaAttachment(atts) : undefined;
  if (!att) return null;
  const kind = attachmentKind(att.type)!;
  return {
    kind,
    externalMediaId: "",
    sourceUrl: att.payload!.url!,
    mimeType: provisionalMime(kind),
  };
}

/**
 * EVERY downloadable attachment on a message, in delivery order. Meta can pack
 * several media into ONE Messenger/Instagram messaging event (a customer sends
 * 3 photos at once → one `mid`, a 3-element `attachments[]`), whereas the
 * WhatsApp Cloud API delivers each media as its own wamid. Without this the
 * social parser kept only `pickMediaAttachment`'s single pick and the rest
 * vanished with no row and no placeholder. Ingest emits the first as the primary
 * message row and the rest as sibling rows (see the inbound branch).
 */
function allAttachmentMedia(
  atts: { type?: string; payload?: { url?: string } }[] | undefined,
): NormalizedMediaRef[] {
  if (!atts) return [];
  const out: NormalizedMediaRef[] = [];
  for (const att of atts) {
    const kind = attachmentKind(att.type);
    if (!kind || !att.payload?.url) continue;
    out.push({ kind, externalMediaId: "", sourceUrl: att.payload.url, mimeType: provisionalMime(kind) });
  }
  return out;
}

/**
 * A human label for a non-downloadable social attachment (no `payload.url` we
 * can store) so the row isn't blank. Meta withholds the content of ephemeral /
 * vanish-mode messages, so those get a clear "disappearing message" note.
 */
function socialAttachmentLabel(type: string): string {
  switch (type) {
    case "ephemeral":
      return "🕓 Disappearing message";
    case "story_mention":
      return "📖 Mentioned you in their story";
    case "story_reply":
      return "📖 Replied to your story";
    case "share":
      return "🔗 Shared a post";
    case "post":
    case "ig_post":
      return "🔗 Shared a post";
    case "location":
      return "📍 Location";
    case "appointment_booking":
      return "📅 Appointment";
    // A sticker normally carries `payload.url` and never reaches here. It is
    // labelled anyway because after the 2026-08-30 transition the `image`
    // twin stops being sent, so a url-less sticker payload would otherwise
    // render as the raw `[sticker]` default.
    case "sticker":
      return "🙂 Sticker";
    // Meta's generic fallbacks for content the Send/webhook shape can't model
    // (a shared link, a structured template) — a clean label beats the raw
    // "[fallback]" / "[template]" the default used to emit.
    case "fallback":
      return "🔗 Shared content";
    case "template":
      return "💬 Message";
    default:
      return `[${type}]`;
  }
}

/**
 * Structured content for an Instagram story interaction (mention / reply / share)
 * so the bubble renders a story card instead of a bare label. `url` is the story
 * media when Meta includes it (a preview the agent can open). Returns undefined
 * for non-story attachments (handled elsewhere).
 */
function socialStructuredFromAttachments(
  atts: SocialAttachment[] | undefined,
): MessageStructured | undefined {
  // Appointment booking (Messenger). Meta ships the booking's own state on the
  // `messages` webhook when the customer requests one and on `message_echoes`
  // when the business confirms/declines it — the whole point of the 2026-03-03
  // change was that partners stop having to open Business Suite to read it. We
  // used to keep only the "📅 Appointment" label, which threw away the status
  // and the time the entire message is about. Checked FIRST because an
  // appointment carries no url and would otherwise fall through to the
  // share-card branch's `fallback` arm on some payloads.
  const appt = atts?.find((a) => a.type === "appointment_booking");
  if (appt) {
    const p = appt.payload ?? {};
    // Meta sends Unix SECONDS; normalize at the seam so nothing downstream has
    // to know that (and a 1970 date can't reach the UI).
    const iso = (t: number | undefined): string | undefined =>
      typeof t === "number" && t > 0 ? new Date(t * 1000).toISOString() : undefined;
    const start = iso(p.start_time);
    const end = iso(p.end_time);
    return {
      kind: "appointment",
      ...(p.booking_id ? { bookingId: String(p.booking_id) } : {}),
      ...(p.status?.trim() ? { status: p.status.trim() } : {}),
      ...(start ? { startTime: start } : {}),
      ...(end ? { endTime: end } : {}),
      ...(p.timezone?.trim() ? { timezone: p.timezone.trim() } : {}),
    };
  }
  // A shared location renders a map pin — the social equivalent of WhatsApp's
  // structuredForMessage location card — instead of a bare "📍 Location" label
  // that hides where the customer actually is. Coordinates ride on
  // `payload.coordinates`; the bare label stays the body for search/preview.
  const loc = atts?.find((a) => a.type === "location");
  const coords = loc?.payload?.coordinates;
  if (loc && coords?.lat != null && coords.long != null) {
    return {
      kind: "location",
      latitude: coords.lat,
      longitude: coords.long,
      ...(loc.title?.trim() ? { name: loc.title.trim() } : {}),
    };
  }
  // Story interactions + shared posts/links all render as an openable card.
  // `share`/`post`/`ig_post` (and a `fallback` that carries a url — Meta's
  // generic shared-link envelope) collapse to the "share" style so the URL is
  // clickable instead of thrown away behind a bare label.
  const att = atts?.find(
    (a) =>
      a.type === "story_mention" ||
      a.type === "story_reply" ||
      a.type === "share" ||
      a.type === "post" ||
      a.type === "ig_post" ||
      (a.type === "fallback" && !!a.payload?.url),
  );
  if (!att) return undefined;
  const storyType: "mention" | "reply" | "share" =
    att.type === "story_reply" ? "reply" : att.type === "story_mention" ? "mention" : "share";
  return {
    kind: "story",
    storyType,
    ...(att.payload?.url ? { url: att.payload.url } : {}),
    // `title` is documented on fallback / reel / ig_reel / post / ig_post, and
    // Meta added it to Messenger post+reel shares on 2026-03-26. Without it the
    // card says "Shared a post" and the agent has to open the link to find out
    // WHICH post the customer is asking about.
    ...(att.title?.trim() ? { title: att.title.trim() } : {}),
  };
}

/**
 * Parse a Messenger/Instagram webhook into normalized events. `expectedObject`
 * gates the envelope (`"page"` for Messenger, `"instagram"` for Instagram) so a
 * misrouted product silently yields `[]` rather than mis-ingesting.
 */
/**
 * Map one `entry.calls[]` item to a NormalizedCallEvent. Messenger's call
 * webhooks carry the caller PSID only on `connect` (`from`) and `call_status`
 * (`recipient_id`); `media_update` / `terminate` reference an existing call by
 * id, so `externalContactId` is left undefined and ingest resolves the row by
 * `externalCallId`. The wire shapes are defined below.
 */
function mapSocialCall(c: SocialCallWire): NormalizedCallEvent | null {
  const externalCallId = c.id;
  if (!externalCallId || !c.event) return null;
  const timestamp = new Date((c.timestamp ?? Date.now()) * (c.timestamp ? 1000 : 1));
  const base = { kind: "call" as const, externalCallId, contactName: null, timestamp, rawPayload: rawPayloadOf(c) };

  switch (c.event) {
    case "connect": {
      const outbound = c.call_direction === "business_initiated";
      return {
        ...base,
        direction: outbound ? "out" : "in",
        phase: outbound ? "ringing_out" : "incoming",
        ...(c.from ? { externalContactId: c.from } : {}),
      };
    }
    case "call_status": {
      // Outbound progress (ringing / accepted). Row stays ringing; the real
      // pickup time is taken from the terminate's start_time (connectedAt).
      return {
        ...base,
        direction: "out",
        phase: "ringing_out",
        ...(c.recipient_id ? { externalContactId: c.recipient_id } : {}),
      };
    }
    case "media_update": {
      // Carries Meta's SDP offer to answer (outbound media negotiation).
      const sdp = c.session?.sdp_renegotiation?.sdp;
      return {
        ...base,
        direction: "out",
        phase: "connecting",
        ...(sdp ? { sdp: { type: "offer" as const, sdp } } : {}),
      };
    }
    case "terminate": {
      // `duration` is present only when the business actually connected; Meta
      // still sends `start_time` for a rang-but-unanswered call, so gate
      // connectedAt on the duration — otherwise ingest's "answered but no
      // duration" correction would flip a genuine miss into a completed call.
      const connected = typeof c.duration === "number" && c.duration > 0;
      const phase = c.status === "Failed" ? "failed" : connected ? "completed" : "missed";
      return {
        ...base,
        // Terminate carries no caller id; ingest updates by externalCallId.
        direction: "in",
        phase,
        ...(connected && c.start_time ? { connectedAt: new Date(c.start_time * 1000) } : {}),
        ...(typeof c.duration === "number" ? { durationSeconds: c.duration } : {}),
      };
    }
    default:
      return null;
  }
}

/** One item of `entry[].changes[]` — the non-messaging Instagram topics. */
interface SocialChange {
  field?: string;
  value?: {
    from?: { id?: string; username?: string };
    /** Facebook-Login comment payloads carry the id here. */
    comment_id?: string;
    /** Business-Login payloads spell it `id`; accept both. */
    id?: string;
    text?: string;
    media?: {
      id?: string;
      media_product_type?: string;
      /** Present when the comment was made on an AD post. */
      ad_id?: string;
      ad_title?: string;
      original_media_id?: string;
    };
    /** Present on a reply to another comment. */
    parent_id?: string;
  };
}

/**
 * An Instagram COMMENT (`comments` / `live_comments`) as an inbound message.
 *
 * Why a comment becomes a Message at all: answering comments is half of what an
 * Instagram team does, and the only legal way to answer one PRIVATELY is a
 * `comment_id`-addressed private reply — which an agent can only send from
 * somewhere they can see the comment. Modelling it as a message on the
 * commenter's own conversation reuses contact resolution, realtime, workflows and
 * tickets wholesale, with no new entity.
 *
 * That is only safe because of one documented fact, and it is the fact the whole
 * design rests on: the comment webhook's `from.id` is "an Instagram-scoped ID
 * suitable for the Send API" — the SAME id space as a DM sender. A different id
 * space would have forked every commenter into a duplicate contact.
 *
 * `opensMessagingWindow: false` is the other load-bearing bit. A comment does NOT
 * start a 24-hour conversation; it buys ONE private reply within 7 days. Letting
 * it bump `lastInboundAt` would tell the composer, the send guards and the
 * broadcast runner that the thread is open, and each would then hand Meta a send
 * it is certain to reject.
 *
 * Returns null for any other `changes[]` field (mentions, story_insights), which
 * the caller then reports as unhandled.
 */
function commentEvent(
  change: SocialChange | undefined,
  entryTime: number | undefined,
): NormalizedInboundMessage | null {
  const field = change?.field;
  if (field !== "comments" && field !== "live_comments") return null;
  const value = change?.value;
  const commentId = value?.comment_id ?? value?.id;
  const authorId = value?.from?.id;
  // No id to dedupe on, or no author to attribute to, is not a comment we can
  // file — dropping beats inventing an identity.
  if (!commentId || !authorId) return null;

  const isLive = field === "live_comments";
  const text = typeof value?.text === "string" ? value.text : "";
  const username = value?.from?.username?.trim();
  return {
    kind: "message",
    // Namespaced so a comment id can never collide with a message `mid` in the
    // `(workspaceId, channel, externalId)` dedupe key.
    externalId: `comment:${commentId}`,
    externalContactId: authorId,
    // Left null like every other social inbound, so the Graph enrichment pass
    // still fills the real display name rather than wedging on the @handle.
    contactName: null,
    // A comment with no text (an image-only reply) still needs a body so the
    // row and the list preview aren't blank.
    body: text || (isLive ? "💬 Commented on your live" : "💬 Commented on your post"),
    structured: {
      kind: "comment",
      commentId,
      ...(username ? { username } : {}),
      ...(value?.media?.id ? { mediaId: value.media.id } : {}),
      ...(value?.media?.media_product_type
        ? { mediaProductType: value.media.media_product_type }
        : {}),
      ...(isLive ? { isLive: true } : {}),
    },
    // See the docblock — the one inbound that does not open the window.
    opensMessagingWindow: false,
    // A comment on an AD's post carries the ad id; same "from your ad" chip.
    // `adId`, not `clickId` — for the reason given on `attributionFromSocialReferral`:
    // `clickId` is a per-CLICK id (WhatsApp's `ctwa_clid`), so putting an ad id
    // there makes "group by ad" compare two different id spaces and match nothing.
    // The comments webhook also carries `media.ad_title`, which is the same
    // headline the ad chip shows.
    ...(value?.media?.ad_id
      ? {
          attribution: {
            source: "ad" as const,
            adId: value.media.ad_id,
            ...(value.media.ad_title?.trim()
              ? { headline: value.media.ad_title.trim() }
              : {}),
          },
        }
      : {}),
    timestamp: new Date(entryTime ?? Date.now()),
    rawPayload: rawPayloadOf(change ?? {}),
  };
}

export function parseSocialMessaging(
  payload: unknown,
  expectedObject: string,
): NormalizedEvent[] {
  if (!isObject(payload)) return [];
  const env = payload as SocialEnvelope;
  if (env.object !== expectedObject || !Array.isArray(env.entry)) return [];

  const events: NormalizedEvent[] = [];
  for (const entry of env.entry) {
    // `entry.id` is the Page (Messenger) or Instagram professional account that
    // received everything in THIS entry. One POST can batch entries for several
    // of a workspace's accounts — Meta's own contract is that "multiple changes
    // from different objects that are of the same type may be batched together" —
    // so the account is stamped per entry, never resolved once for the body.
    // Resolving per body bound a second Page's threads to the first Page, and the
    // reply then went out from an account the customer never messaged.
    const receivingAccountId =
      typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
    const emit = <E extends NormalizedEvent>(evt: E): void => {
      events.push(
        receivingAccountId ? ({ ...evt, externalAccountId: receivingAccountId } as E) : evt,
      );
    };
    // Call lifecycle events (Messenger Calling) ride entry.calls[], separate
    // from messaging. An entry carries one or the other.
    if (Array.isArray(entry.calls)) {
      for (const c of entry.calls) {
        const call = mapSocialCall(c);
        if (call) emit(call);
      }
    }
    // Business-initiated call permission opt-in reply (entry-level).
    if (entry.call_permission_reply?.response && entry.sender?.id) {
      const approved = entry.call_permission_reply.response === "approve";
      emit({
        kind: "call",
        externalCallId: `perm:${entry.sender.id}:${entry.timestamp ?? ""}`,
        externalContactId: entry.sender.id,
        contactName: null,
        direction: "out",
        phase: approved ? "permission_granted" : "permission_revoked",
        timestamp: new Date((entry.timestamp ?? Math.floor(Date.now() / 1000)) * 1000),
        rawPayload: rawPayloadOf(entry),
      });
    }
    // Defensive: `entry.standby[]` means ANOTHER app currently holds thread
    // control under Conversation Routing and we're only receiving passive copies
    // (we can't reply until control is passed to us). We onboard as the sole
    // Customer-Care app and never enable routing, so this normally never fires —
    // but if a customer connects a routing-enabled bot that claims the default
    // app, our REAL inbound would arrive only here. Log loudly so it's
    // diagnosable instead of a silent drop; full Handover-Protocol support is a
    // separate build.
    const standby = (entry as { standby?: unknown[] }).standby;
    if (Array.isArray(standby) && standby.length > 0) {
      // Now that `standby` is actually SUBSCRIBED (it was added to
      // PAGE_OPTIONAL_FIELDS alongside `messaging_handovers`), this branch is
      // reachable for the first time — Meta only delivers standby traffic to
      // apps that asked for it, so the warning below could never previously fire
      // in the situation it was written for.
      //
      // Still not ingested, deliberately. A standby message is a copy of a
      // conversation we may not answer: filing it in the inbox would put a thread
      // in front of an agent whose every reply is guaranteed to fail with 2018300.
      // The honest surface is a loud, diagnosable log naming the customer, so an
      // operator can take thread control (see messenger-handover.ts) and the
      // NEXT inbound arrives normally.
      //
      // Escalated to `critical`: for a Page that has been routed away from us,
      // this is what "our inbox stopped receiving messages" looks like from the
      // inside, and it is silent everywhere else.
      const psids = standby.flatMap((s) => {
        const sender = (s as { sender?: { id?: unknown } } | null)?.sender?.id;
        return typeof sender === "string" ? [sender] : [];
      });
      console.warn(
        JSON.stringify({
          event: "social.standby_received",
          severity: "critical",
          channel: expectedObject,
          entryId: (entry as { id?: string }).id ?? null,
          count: standby.length,
          psids: [...new Set(psids)],
          note: "another app holds thread control; these customers' messages are NOT in the inbox and replies would fail with 2018300 — take thread control to recover",
        }),
      );
    }
    // Some subscribed topics arrive as `entry[].changes[]`, not
    // `entry[].messaging[]` — on Instagram that is `comments`, `live_comments`,
    // `mentions` and `story_insights`.
    //
    // COMMENTS are ingested (see `commentEvent`); the rest are warned about, so
    // "subscribed but unhandled" stays visible instead of being
    // indistinguishable from "never sent". Handled BEFORE the `messaging` guard
    // rather than inside its else-branch: Meta's contract permits an entry to
    // carry both arrays, and hanging comment parsing off "there was no messaging
    // array" would drop them silently in exactly that case.
    const changes = (entry as { changes?: SocialChange[] }).changes;
    if (Array.isArray(changes) && changes.length > 0) {
      const unhandled: string[] = [];
      for (const change of changes) {
        const comment = commentEvent(change, entry.time);
        if (comment) emit(comment);
        else if (typeof change?.field === "string") unhandled.push(change.field);
      }
      if (unhandled.length > 0) {
        console.warn(
          JSON.stringify({
            event: "social.unhandled_changes_entry",
            severity: "warning",
            channel: expectedObject,
            entryId: (entry as { id?: string }).id ?? null,
            fields: unhandled,
            note: "topic delivers entry[].changes[], not entry[].messaging[] — subscribed but not ingested",
          }),
        );
      }
    }
    if (!Array.isArray(entry.messaging)) {
      continue;
    }
    for (const m of entry.messaging) {
      // Unsend: the customer deleted a message. References an existing mid;
      // tombstone the stored row (no new content). Checked before the echo/
      // message branches since a deleted message carries `message.mid`.
      if (m.message?.is_deleted && m.message.mid) {
        emit({
          kind: "message_correction",
          action: "delete",
          targetExternalId: m.message.mid,
          timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
          rawPayload: rawPayloadOf(m),
        });
        continue;
      }
      // Edit — Messenger `message_edits`, Instagram `message_edit` (singular;
      // Meta shipped it for Instagram on 2025-09-10). This comment used to say
      // "Instagram has no equivalent webhook", contradicting the corrected note on
      // the `message_edit` field above and inviting the next reader to delete a
      // live path. The branch itself is object-agnostic, so both parse here.
      // Rewrites an existing row's body, exactly as the WhatsApp `type:"edit"`
      // branch does — without this the account is subscribed to the edit field
      // and the notification is parsed into nothing, leaving the agent looking
      // at text the customer has already corrected.
      if (m.message_edit?.mid && typeof m.message_edit.text === "string") {
        emit({
          kind: "message_correction",
          action: "edit",
          targetExternalId: m.message_edit.mid,
          newBody: m.message_edit.text,
          timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
          rawPayload: rawPayloadOf(m),
        });
        continue;
      }
      // Native-inbox echo: a message the BUSINESS sent from Meta's own Page /
      // Instagram inbox (not our API), mirrored back with `is_echo`. Ingest it
      // as an OUTBOUND echo so the shared inbox stays in sync with replies typed
      // outside our app — the social equivalent of WhatsApp Coexistence. `sender`
      // is the business (page/IG id), `recipient` is the CUSTOMER whose thread
      // this belongs in. Dedupe on the mid makes an echo of our OWN API send a
      // safe no-op (idempotent-create returns the existing row).
      if (m.message?.is_echo) {
        const customerId = m.recipient?.id;
        const mid = m.message.mid;
        if (customerId && mid) {
          const media = attachmentMedia(m.message.attachments);
          const text = m.message.text;
          // Fallback label when a native-inbox reply is a NON-downloadable
          // attachment (template/product/fallback echo has no `payload.url`, so
          // `media` is null and there's no text). Without this the echo mirrors
          // back as a blank outbound bubble — mirror the inbound label path.
          const echoAtt = m.message.attachments?.[0]?.type;
          const echoBody =
            text && text.length > 0
              ? text
              : !media && echoAtt
                ? socialAttachmentLabel(echoAtt)
                : "";
          // Structured content on an ECHO. A business reply typed in Meta's own
          // inbox can BE the structured message: confirming or declining an
          // appointment ships the UPDATED booking on `message_echoes`
          // (2026-03-03), and a shared post/reel echoes back with its title and
          // url. The inbound branch has read this for a while; the echo branch
          // dropped it, so the agent saw "📅 Appointment" for the confirmation
          // their own colleague had just sent from Business Suite.
          const echoStructured = socialStructuredFromAttachments(m.message.attachments);
          emit({
            kind: "echo",
            externalId: mid,
            externalContactId: customerId,
            body: echoBody,
            ...(media ? { media } : {}),
            ...(echoStructured ? { structured: echoStructured } : {}),
            timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
            rawPayload: rawPayloadOf(m),
          });
          // A business can send a multi-photo album from Meta's native inbox;
          // Meta mirrors it back as ONE echo mid with N attachments. Mirror the
          // inbound multi-attachment handling so photos 2..N aren't dropped (the
          // CDN urls expire and are never re-fetched). Same sticker-skip + stable
          // `${mid}:att:{i}` dedup id the inbound branch uses below.
          const hasSticker =
            m.message.attachments?.some((a) => a.type === "sticker") ?? false;
          const extraEchoMedia =
            media && !hasSticker
              ? allAttachmentMedia(m.message.attachments).filter(
                  (x) => x.sourceUrl !== media.sourceUrl,
                )
              : [];
          extraEchoMedia.forEach((extra, i) => {
            emit({
              kind: "echo",
              externalId: `${mid}:att:${i + 1}`,
              externalContactId: customerId,
              body: "",
              media: extra,
              timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
              rawPayload: rawPayloadOf(m),
            });
          });
        }
        continue;
      }
      // Inbound customer message.
      if (m.message && !m.message.is_echo) {
        const senderId = m.sender?.id;
        const mid = m.message.mid;
        if (!senderId || !mid) continue;
        const media = attachmentMedia(m.message.attachments);
        // Meta can pack several media into ONE social message (3 photos at once
        // → one mid). The primary row carries the first pick + any caption; the
        // rest become sibling rows below so nothing is silently dropped. Skip
        // this when a sticker is present: sticker+image is the ONE transition
        // sticker (pickMediaAttachment already prefers the sticker), not two
        // media. Sibling urls are de-duped against the primary's.
        const hasSticker = m.message.attachments?.some((a) => a.type === "sticker") ?? false;
        const extraMedia =
          media && !hasSticker
            ? allAttachmentMedia(m.message.attachments).filter((x) => x.sourceUrl !== media.sourceUrl)
            : [];
        const text = m.message.text;
        // Body is the text (media caption if any); empty for media-only. When a
        // message has neither text nor a downloadable attachment, fall back to a
        // short label so the row isn't blank (e.g. a location/sticker/fallback).
        const body =
          text && text.length > 0
            ? text
            : media
              ? ""
              : m.message.attachments?.[0]?.type
                ? socialAttachmentLabel(m.message.attachments[0].type)
                : // No text, no downloadable media, no typed attachment. Either
                  // Meta flagged it `is_unsupported`, OR it's a bare `{ mid }`
                  // envelope: Messenger/Instagram WITHHOLD the content of message
                  // types their API can't deliver — a shared LOCATION (verified
                  // 2026-07-13: the webhook carries only a mid, no coordinates),
                  // and other unsupported shares. Give the agent a clear cue to
                  // open the native app rather than a blank bubble that renders as
                  // "Attachment unavailable" (which specifically means a FAILED
                  // media download — a different case with real media at parse).
                  "⚠️ Unsupported message — open the app to view";
        const msg: NormalizedInboundMessage = {
          kind: "message",
          externalId: mid,
          externalContactId: senderId,
          // No display name in the messaging event; ingest falls back to the id
          // (a later Graph name-enrichment pass fills it in).
          contactName: null,
          body,
          // Quoted-reply context: the mid the customer replied to. Ingest links
          // it to the local message (same path as WhatsApp `context.id`).
          ...(m.message.reply_to?.mid
            ? { replyToExternalId: m.message.reply_to.mid }
            : {}),
          ...(media ? { media } : {}),
          // A tapped quick-reply carries its stable payload (the outbound
          // option's id) + the title as `text` — surface it for workflow
          // routing (ask_question), same as WhatsApp button replies.
          ...(m.message.quick_reply?.payload
            ? {
                interactiveReply: {
                  kind: "button_reply" as const,
                  id: m.message.quick_reply.payload,
                  title: text ?? "",
                },
              }
            : {}),
          // Ad / deep-link attribution → "from your ad" chip. Messenger puts it
          // at the messaging-event level (`m.referral`); Instagram nests it in
          // the message (`m.message.referral`) for a Click-to-IG-Direct ad or a
          // Shop product referral. Read both (sibling first, then nested).
          ...((m.referral ?? m.message.referral)
            ? { attribution: attributionFromSocialReferral((m.referral ?? m.message.referral)!) }
            : {}),
          // Instagram story interaction (mention / reply / share) → story card.
          // A story REPLY arrives as a normal text message carrying
          // `reply_to.story` (no attachment), so fall back to that when the
          // attachments yield nothing — the customer's reply text stays the body.
          ...(() => {
            const structured =
              socialStructuredFromAttachments(m.message?.attachments) ??
              (m.message?.reply_to?.story
                ? {
                    kind: "story" as const,
                    storyType: "reply" as const,
                    ...(m.message.reply_to.story.url
                      ? { url: m.message.reply_to.story.url }
                      : {}),
                  }
                : undefined);
            return structured ? { structured } : {};
          })(),
          timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
          rawPayload: rawPayloadOf(m),
        };
        emit(msg);
        // Sibling rows for the additional media in a multi-attachment message.
        // Stable derived externalId (`${mid}:att:${i}`) keeps dedup idempotent
        // across Meta's at-least-once redelivery — mirrors how WhatsApp yields
        // one row per media, so the inbox renders all N attachments.
        extraMedia.forEach((extra, i) => {
          emit({
            kind: "message",
            externalId: `${mid}:att:${i + 1}`,
            externalContactId: senderId,
            contactName: null,
            body: "",
            media: extra,
            timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
            rawPayload: rawPayloadOf(m),
          } satisfies NormalizedInboundMessage);
        });
        continue;
      }
      // Postback: Get-Started / persistent-menu / structured-button tap. Surface
      // the author-assigned `payload` as an interactiveReply so ask_question +
      // workflow routing recognise it — parity with a message's quick_reply.
      if (m.postback && !m.message) {
        const senderId = m.sender?.id;
        const payload = m.postback.payload;
        if (senderId && payload) {
          const title = m.postback.title ?? "";
          const externalId =
            m.postback.mid ?? `${senderId}:${m.timestamp ?? entry.time ?? 0}:postback`;
          // A Get-Started tapped from an ad carries the referral on the postback.
          const referral = m.postback.referral ?? m.referral;
          const msg: NormalizedInboundMessage = {
            kind: "message",
            externalId,
            externalContactId: senderId,
            contactName: null,
            body: title,
            interactiveReply: { kind: "button_reply", id: payload, title },
            ...(referral ? { attribution: attributionFromSocialReferral(referral) } : {}),
            timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
            rawPayload: rawPayloadOf(m),
          };
          emit(msg);
        }
        continue;
      }
      // Standalone referral: a RETURNING customer clicked a Click-to-Messenger ad
      // or an m.me?ref= deep link WITHOUT sending a message, so Meta delivers a
      // bare `referral` messaging event (no message, no postback). Surface it as a
      // synthesized inbound touch carrying the "from your ad" attribution — the
      // same convention the postback branch uses for a non-text user action — so
      // the ad re-engagement isn't silently dropped into the unhandled-log below
      // (the team pays to subscribe to messaging_referrals). No mid on a bare
      // referral, so the dedup id is sender+timestamp-derived, idempotent across
      // Meta's at-least-once redelivery.
      if (m.referral && !m.message && !m.postback) {
        const senderId = m.sender?.id;
        if (senderId) {
          const attribution = attributionFromSocialReferral(m.referral);
          const externalId = `${senderId}:${m.timestamp ?? entry.time ?? 0}:referral`;
          // A PAID ad carries `ad_id` (source "ad"); a bare ig.me/m.me link is an
          // organic click (`source:"SHORTLINK"`, `type:"OPEN_THREAD"`, no ad_id →
          // source "ref"). Don't call an organic link click "your ad".
          const base =
            attribution.source === "ad"
              ? "Started a conversation from your ad"
              : attribution.productId
                ? "Started a conversation from a shop product"
                : "Started a conversation from a link";
          const label = attribution.headline ? `${base} · ${attribution.headline}` : base;
          emit({
            kind: "message",
            externalId,
            externalContactId: senderId,
            contactName: null,
            body: label,
            attribution,
            timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
            rawPayload: rawPayloadOf(m),
          } satisfies NormalizedInboundMessage);
        }
        continue;
      }
      // Reaction to one of our messages (Messenger/IG `reaction`). `action`
      // is "react" | "unreact"; on unreact the emoji is cleared. Ingest matches
      // the target message by mid and sets its reaction column.
      if (m.reaction && m.reaction.mid) {
        // Resolver decides add-vs-remove from action/glyph/type (IG unreacts
        // omit both the "unreact" action AND the glyph — see socialReactionEmoji).
        const emoji = socialReactionEmoji(
          m.reaction.action,
          m.reaction.emoji,
          m.reaction.reaction,
        );
        const reaction: NormalizedReaction = {
          kind: "reaction",
          externalId: `${m.reaction.mid}:reaction`,
          targetExternalId: m.reaction.mid,
          emoji,
          timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
          rawPayload: rawPayloadOf(m),
        };
        emit(reaction);
        continue;
      }
      // Messenger 👍/👎 "message feedback" (`response_feedback`) is Meta's
      // built-in business-message feedback — the customer rating a message the
      // Page sent. It is NOT a reaction (real emoji reactions arrive via the
      // `reaction` field, handled above), so we surface it as a DISTINCT feedback
      // chip: emit `message_feedback` → ingest patches `Message.feedback` and the
      // bubble renders a separate "Helpful / Not helpful" chip. Meta delivers
      // this on the `response_feedback` webhook field, which the Page must be
      // SUBSCRIBED to — see PAGE_OPTIONAL_FIELDS. Subscribing is also what puts the
      // 👍/👎 buttons in the customer's thread in the first place, so an
      // unsubscribed Page produces neither the buttons nor this event.
      if (m.response_feedback?.mid) {
        const fb: NormalizedMessageFeedback = {
          kind: "message_feedback",
          targetExternalId: m.response_feedback.mid,
          feedback:
            m.response_feedback.feedback === "Bad response" ? "negative" : "positive",
          timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
          rawPayload: rawPayloadOf(m),
        };
        emit(fb);
        continue;
      }
      // Delivery receipt (Messenger). `message_deliveries` ALWAYS carries a
      // `watermark` and only SOMETIMES a `mids[]` (omitted for older clients), so
      // key on the watermark — mark every outbound to the customer at/before it
      // as delivered, exactly like the read path below. A watermark-only delivery
      // is no longer silently dropped (the old `mids`-array guard missed it).
      // Instagram sends no delivery webhook, so this never fires for IG.
      if (m.delivery && typeof m.delivery.watermark === "number") {
        const from = m.sender?.id;
        if (from) {
          emit({
            kind: "delivered_watermark",
            externalContactId: from,
            watermark: new Date(m.delivery.watermark),
            rawPayload: rawPayloadOf(m),
          });
        }
      }
      // Read receipt ("Seen"). Instagram sends a per-message `mid` — mark THAT
      // outbound message read (same per-mid path WhatsApp uses). Messenger sends
      // a `watermark` — mark every outbound to the sender at/before it read.
      if (m.read) {
        if (typeof m.read.mid === "string" && m.read.mid) {
          const status: NormalizedStatusUpdate = {
            kind: "status",
            externalId: m.read.mid,
            status: "read",
            timestamp: new Date(m.timestamp ?? Date.now()),
            rawPayload: rawPayloadOf(m),
          };
          emit(status);
        } else if (typeof m.read.watermark === "number") {
          const from = m.sender?.id;
          if (from) {
            emit({
              kind: "read_watermark",
              externalContactId: from,
              watermark: new Date(m.read.watermark),
              rawPayload: rawPayloadOf(m),
            });
          }
        }
      }
      // ── Handover protocol (`messaging_handovers`) ─────────────────────────
      //
      // Four sub-events on one field, all about WHO MAY REPLY rather than about
      // any message. None creates a row; each is logged with the app ids so an
      // operator can tell "the inbox went quiet" from "another app took the
      // thread", which are indistinguishable from the outside.
      //
      // `previous_owner_app_id` is null when the thread was in IDLE mode (nobody
      // held it), which is not the same as an unknown app and is reported as such.
      const controlChange = m.pass_thread_control ?? m.take_thread_control;
      if (controlChange || m.request_thread_control || m.app_roles) {
        const appId = (v: unknown): string | null =>
          typeof v === "string" || typeof v === "number" ? String(v) : null;
        console.warn(
          JSON.stringify({
            event: "meta.thread_control_changed",
            severity: "warning",
            channel: expectedObject,
            accountId: receivingAccountId ?? null,
            psid: m.sender?.id ?? null,
            action: m.pass_thread_control
              ? "passed"
              : m.take_thread_control
                ? "taken"
                : m.request_thread_control
                  ? "requested"
                  : "app_roles_changed",
            previousOwnerAppId: controlChange ? appId(controlChange.previous_owner_app_id) : null,
            newOwnerAppId: controlChange ? appId(controlChange.new_owner_app_id) : null,
            requestedByAppId: appId(m.request_thread_control?.requested_owner_app_id),
            ...(m.app_roles ? { appRoles: m.app_roles } : {}),
            note: "thread ownership changed — only the owning app may reply; see messenger-handover.ts",
          }),
        );
        continue;
      }
      // ── Page health: integrity + messaging-policy enforcement ─────────────
      //
      // Both of these ride `entry[].messaging[]` — the SAME array customer
      // messages arrive on — despite being about the PAGE, not a conversation.
      // They carry no `sender`, no `message` and no `mid`, so without a branch
      // here they fall into the catch-all below at `severity: "info"`, the one
      // severity nobody alerts on. Subscribing to a field and then discarding it
      // invisibly is strictly worse than not subscribing.
      //
      // Logged at `critical` when the Page can no longer message and `warning`
      // otherwise, because this is the earliest possible notice of the condition
      // that `normalizeMetaSendError` can only report AFTER a send has already
      // failed with `10 – 1893063`. The settings panel reads the full picture
      // live from `GET /{page-id}/page_status` (see messenger-integrity.ts);
      // this is the push half that makes it timely.
      if (
        typeof m.status === "string" &&
        (Array.isArray(m.violations) ||
          Array.isArray(m.restrictions) ||
          Array.isArray(m.action_events))
      ) {
        // `restrictions` sits inside the messaging item in one of Meta's
        // examples and as a SIBLING of `messaging` in another — pass the entry
        // so both positions are read.
        const integrity = parsePageIntegrity(m, entry);
        const blocked = blocksMessaging(integrity);
        console.warn(
          JSON.stringify({
            event: "meta.page_integrity",
            severity: blocked ? "critical" : "warning",
            channel: expectedObject,
            accountId: receivingAccountId ?? null,
            status: integrity.status,
            blocksMessaging: blocked,
            restrictedUntil: messagingRestrictionExpiry(integrity),
            violations: integrity.violations.map((v) => v.type),
            restrictions: integrity.restrictions.map((r) => `${r.feature}:${r.status ?? "RESTRICTED"}`),
            appeals: integrity.appeals.map((a) => `${a.type}:${a.status}`),
            note: blocked
              ? "this Page cannot send messages right now — sends will fail with 10/1893063"
              : "Page integrity changed",
          }),
        );
        continue;
      }
      // `messaging_policy_enforcement`: the older, narrower notice.
      // `action` is "warning" | "block" | "unblock"; `reason` explains the first
      // two and is absent on an unblock.
      const enforcement = m.policy_enforcement;
      if (enforcement?.action) {
        const action = enforcement.action.toLowerCase();
        console.warn(
          JSON.stringify({
            event: "meta.messaging_policy_enforcement",
            severity: action === "block" ? "critical" : action === "unblock" ? "info" : "warning",
            channel: expectedObject,
            accountId: receivingAccountId ?? null,
            action,
            reason: enforcement.reason ?? null,
            note:
              action === "block"
                ? "Meta has blocked this Page from messaging"
                : action === "unblock"
                  ? "Meta has lifted this Page's messaging block"
                  : "Meta has warned this Page about a messaging-policy violation",
          }),
        );
        continue;
      }
      // `messaging_optins` — an EXPLICIT, reviewed drop rather than a generic
      // unknown.
      //
      // It sits in PAGE_MESSAGING_FIELDS, i.e. we actively ASK Meta for it, and it
      // then fell into the catch-all below at `severity: "info"` — the one severity
      // nobody alerts on. That combination is the worst of both: we pay for the
      // subscription and discard the result invisibly.
      //
      // Not ingested, deliberately: an opt-in is a CONSENT record (checkbox plugin,
      // an m.me link's `ref`, or a one-time-notification token), and this platform
      // models no consent entity and does not implement one-time notifications —
      // there is nothing to write it to. Logged at `warning` with the payload keys
      // so it is visible and countable, because two things about it are live
      // questions rather than settled ones: whether an opt-in opens a messaging
      // window we should honour in the composer, and whether `optin.user_ref`
      // (checkbox plugin, which arrives BEFORE a PSID exists) needs an identity
      // path. Both are product decisions, not parse bugs — recorded here so the
      // next person sees a decision instead of a silence.
      if (m.optin) {
        console.warn(
          JSON.stringify({
            event: "meta.webhook.optin_not_ingested",
            severity: "warning",
            object: expectedObject,
            hasRef: Boolean(m.optin.ref),
            hasUserRef: Boolean(m.optin.user_ref),
            hasOneTimeToken: Boolean(m.optin.one_time_notif_token),
            note: "subscribed field with no consent model to store it — see comment",
          }),
        );
        continue;
      }
      // Observability: a messaging event we don't handle yet (account_linking,
      // game_plays, …). Logged — not dropped silently — so a
      // new Meta event type surfaces in ops instead of vanishing. Fail-soft
      // (still a 200). Echoes, unsends and edits are all handled above.
      if (
        !m.message &&
        !m.message_edit &&
        !m.postback &&
        !m.reaction &&
        !m.delivery &&
        !m.read
      ) {
        console.warn(
          JSON.stringify({
            event: "meta.webhook.unhandled_messaging",
            severity: "info",
            object: expectedObject,
            keys: Object.keys(m),
          }),
        );
      }
    }
  }
  return events;
}

/**
 * A quoted-reply fragment for the send body — Meta social supports replying to a
 * specific message via a top-level `reply_to: { mid }`. Empty when not a reply.
 *
 * Dropped entirely OUTSIDE the 24h window, because Meta's Send API reference
 * puts a precondition on this field that the messaging window itself does not
 * have: *"The page should have received a message from the user within the last
 * 24 hours."* The Human Agent tag buys 7 days to SEND — it does not extend
 * `reply_to`.
 *
 * So the two are not independent, and getting it wrong costs the whole message:
 * an agent quoting a specific message on a two-day-old thread — precisely the
 * case the 24h–7d support band exists for — would have the entire send rejected
 * instead of arriving unquoted. Losing the quote is cosmetic; losing the reply
 * is the agent's answer never reaching the customer.
 *
 * `undefined` is treated as possibly-outside and drops the quote, matching how
 * `messagingTypeFields` resolves the same unknown conservatively.
 */
function replyToFragment(
  replyToExternalId?: string,
  useHumanAgentTag?: boolean,
): { reply_to: { mid: string } } | object {
  if (!replyToExternalId || useHumanAgentTag !== false) return {};
  return { reply_to: { mid: replyToExternalId } };
}

/**
 * The messaging-type fields for a social send. Within the 24h window Meta wants
 * `RESPONSE` (no tag, and it needs no special feature); only outside 24h (in the
 * 24h–7d support band) do we attach the Human Agent tag. The caller passes
 * `useHumanAgentTag` from the window band; when it's undefined we keep the tag
 * (safe default — the tag is valid across the whole 7-day window).
 */
/**
 * The persona fragment for a send body.
 *
 * Its own helper for one reason: `persona_id` belongs at the TOP LEVEL, and the
 * single most likely mistake is nesting it in `message`, where Meta accepts the
 * send, returns a message id, and delivers it as the Page. A named fragment
 * spliced next to `messaging_type` makes the placement obvious at every call site.
 */
function personaFragment(personaId?: string): object {
  return personaId ? { persona_id: personaId } : {};
}

export function messagingTypeFields(useHumanAgentTag?: boolean): object {
  return useHumanAgentTag === false
    ? { messaging_type: "RESPONSE" }
    : { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" };
}

/**
 * Send a text message on a Meta social channel. `accountId` is the Page id
 * (Messenger / Instagram both send via the Page); `accessToken` is the Page
 * token. Human Agent tag = valid for the 7-day support window. Quoted replies
 * ride on `reply_to.mid`, but only inside 24h — see `replyToFragment`.
 */
export async function sendSocialText(
  args: SendTextArgs,
  opts: SocialSendTarget,
): Promise<SendTextResult> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  // PRIVATE REPLY to a comment. The comment IS the address (`recipient:
  // {comment_id}`), and every window-related field is deliberately absent:
  // there is no messaging window yet — that is the whole reason this send shape
  // exists — so a `messaging_type`/tag or a `reply_to` would be describing a
  // conversation that has not started. Meta allows exactly one of these per
  // comment, within 7 days.
  const body = args.privateReplyToCommentId
    ? {
        recipient: { comment_id: args.privateReplyToCommentId },
        message: { text: args.body },
      }
    : {
        recipient: { id: args.to },
        ...messagingTypeFields(args.useHumanAgentTag),
        ...replyToFragment(args.replyToExternalId, args.useHumanAgentTag),
        // TOP LEVEL, beside `message` — see SendTextArgs.personaId. Deliberately
        // NOT on the private-reply branch above: a persona is a voice inside a
        // conversation, and a private reply is the message that starts one.
        ...personaFragment(args.personaId),
        message: { text: args.body },
      };
  const res = await graphPostJson(url, opts.accessToken, body, opts.appSecret);
  const messageId = typeof res.message_id === "string" ? res.message_id : "";
  if (!messageId) {
    throw new Error(`${opts.label} sendText: response missing message_id`);
  }
  return { externalId: messageId, timestamp: new Date() };
}

/** Meta's cap on quick replies per message (Messenger and Instagram alike). */
const MAX_QUICK_REPLIES = 13;

/** `ContactShareField` → Meta's auto-fill quick-reply `content_type`. */
const CONTACT_SHARE_CONTENT_TYPE: Record<ContactShareField, string> = {
  phone: "user_phone_number",
  email: "user_email",
};

/**
 * Send an interactive message on a social channel.
 *
 * TWO wire shapes, chosen by `kind`:
 *
 *   - `cta_url` → Meta's BUTTON TEMPLATE with one `web_url` button (see
 *     `ctaUrlTemplatePayload`). Quick replies cannot carry a destination, so this
 *     kind cannot be collapsed into them.
 *   - everything else → QUICK REPLIES (up to 13; title ≤20 chars; the option id
 *     rides in the `payload` and comes back on the tapped reply). Both "buttons"
 *     and "list" collapse here — the social platforms have no native list sheet,
 *     and quick replies are the closest tap-to-choose UX, with a 13-option
 *     ceiling that beats the button template's 3.
 *
 * Human Agent tag in both cases.
 *
 * `args.contactShare` appends Meta's auto-fill consent chips. Those carry ONLY
 * a `content_type` — sending `title`/`payload` alongside makes Meta reject the
 * whole message ("message[quick_replies][0][content_type] is required"), because
 * the platform supplies both from the customer's profile. They're appended last
 * so a full option set can't push them out of the 13-chip budget silently: the
 * text options are trimmed instead.
 */
/**
 * The BUTTON TEMPLATE body for a `cta_url` send — the Instagram equivalent of
 * WhatsApp's `interactive.type:"cta_url"`.
 *
 * Doc-exact (Instagram Messaging → Button Template): an attachment of
 * `type:"template"` whose payload is `{ template_type:"button", text, buttons }`,
 * with "1-3 buttons" and text "up to 640 characters". Only `web_url` and
 * `postback` buttons are supported, so the single URL button is a `web_url`.
 *
 * The template has ONE text field, so an optional header/footer are folded into
 * it rather than dropped — `send-interactive-internal` measures the same joined
 * string against `templateTextMaxChars`, so what is validated is what is sent.
 */
function ctaUrlTemplatePayload(args: SendInteractiveArgs): object | null {
  const cta = args.ctaUrl;
  if (!cta) return null;
  const text = [cta.headerText, args.bodyText, cta.footerText]
    .filter((part): part is string => !!part && part.length > 0)
    .join("\n\n");
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text,
        buttons: [{ type: "web_url", url: cta.url, title: cta.displayText }],
      },
    },
  };
}

/**
 * The interactive kinds that go out as a Meta TEMPLATE attachment rather than as
 * quick replies. Named once so the send below can tell "this kind needs a
 * template payload" from "this kind is a quick-reply message".
 */
const TEMPLATE_KINDS: ReadonlySet<string> = new Set(["cta_url", "generic", "product"]);

/**
 * Meta's GENERIC TEMPLATE payload — 1-10 cards, a carousel beyond one.
 *
 * Doc-exact (Instagram Messaging → Generic Template): `template_type:"generic"`
 * with an `elements` array; per element `title` (80 chars) is required,
 * `subtitle` (80), `image_url`, `default_action` and up to 3 buttons are
 * optional, and "Only `postback` and `web_url` buttons are supported".
 *
 * `default_action` is a `web_url` action with no title — Meta's shape for
 * "tapping the card itself opens this" — which is why it is not just another
 * button.
 */
function genericTemplatePayload(cards: readonly GenericTemplateCard[]): object {
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "generic",
        elements: cards.map((card) => ({
          title: card.title,
          ...(card.subtitle ? { subtitle: card.subtitle } : {}),
          ...(card.imageUrl ? { image_url: card.imageUrl } : {}),
          ...(card.defaultActionUrl
            ? { default_action: { type: "web_url", url: card.defaultActionUrl } }
            : {}),
          ...(card.buttons?.length
            ? {
                buttons: card.buttons.map((b) =>
                  b.type === "web_url"
                    ? { type: "web_url", url: b.url, title: b.title }
                    : { type: "postback", title: b.title, payload: b.payload },
                ),
              }
            : {}),
        })),
      },
    },
  };
}

/**
 * Meta's PRODUCT TEMPLATE payload — up to 10 catalog products.
 *
 * Doc-exact: `template_type:"product"` with `elements: [{ id }]`. There is no
 * other content to send; Meta draws each card from the catalog entry, which is
 * also why an id that isn't in the connected catalog fails at Meta rather than
 * here.
 */
function productTemplatePayload(productIds: readonly string[]): object {
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "product",
        elements: productIds.map((id) => ({ id })),
      },
    },
  };
}

export async function sendSocialInteractive(
  args: SendInteractiveArgs,
  opts: SocialSendTarget,
): Promise<SendTextResult> {
  // A URL button is a TEMPLATE on the social channels, not a quick reply — quick
  // replies carry no destination, so collapsing `cta_url` into them would have
  // sent the body text with the link silently missing.
  //
  // The three TEMPLATE kinds share one send shape (an `attachment` of type
  // `template`) and differ only in the payload, so they are built here and sent
  // through one call rather than three near-identical blocks.
  const templateMessage =
    args.kind === "cta_url"
      ? ctaUrlTemplatePayload(args)
      : args.kind === "generic" && args.genericCards?.length
        ? genericTemplatePayload(args.genericCards)
        : args.kind === "product" && args.productIds?.length
          ? productTemplatePayload(args.productIds)
          : null;
  // A TEMPLATE kind whose payload is missing must FAIL, not fall through.
  //
  // Below this point is the quick-reply path, so falling through would send the
  // body text as a plain message with an empty `quick_replies` — a silently
  // different message than the caller asked for, reported as a success. The
  // request schemas already refuse the combination, but the provider is reachable
  // from workflows and future internal callers, and "the layer above validates"
  // is exactly the assumption that makes this kind of degradation survive.
  if (TEMPLATE_KINDS.has(args.kind) && !templateMessage) {
    throw new Error(
      `${opts.label} sendInteractive: kind "${args.kind}" needs its template payload ` +
        "(ctaUrl / genericCards / productIds) and none was supplied",
    );
  }
  if (templateMessage) {
    const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
    const res = await graphPostJson(
      url,
      opts.accessToken,
      {
        recipient: { id: args.to },
        ...messagingTypeFields(args.useHumanAgentTag),
        ...replyToFragment(args.replyToExternalId, args.useHumanAgentTag),
        message: templateMessage,
      },
      opts.appSecret,
    );
    const templateMessageId = typeof res.message_id === "string" ? res.message_id : "";
    if (!templateMessageId) {
      throw new Error(`${opts.label} sendInteractive: response missing message_id`);
    }
    return { externalId: templateMessageId, timestamp: new Date() };
  }
  // Instagram's auto-fill quick replies document ONLY `user_phone_number` — a
  // `user_email` chip is a Messenger-only content_type and makes Meta reject the
  // whole IG message. Drop the email chip on Instagram (phone still offered).
  const shares = (args.contactShare ?? []).filter(
    (field) => !(field === "email" && opts.label === "instagram"),
  );
  const textBudget = Math.max(0, MAX_QUICK_REPLIES - shares.length);
  const quick_replies: Array<Record<string, string>> = args.options
    .slice(0, textBudget)
    .map((o) => ({
      content_type: "text",
      title: o.title.slice(0, 20),
      payload: o.id,
    }));
  for (const field of shares) {
    quick_replies.push({ content_type: CONTACT_SHARE_CONTENT_TYPE[field] });
  }
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  const res = await graphPostJson(url, opts.accessToken, {
    recipient: { id: args.to },
    ...messagingTypeFields(args.useHumanAgentTag),
    ...replyToFragment(args.replyToExternalId, args.useHumanAgentTag),
    message: { text: args.bodyText, quick_replies },
  }, opts.appSecret);
  const messageId = typeof res.message_id === "string" ? res.message_id : "";
  if (!messageId) {
    throw new Error(`${opts.label} sendInteractive: response missing message_id`);
  }
  return { externalId: messageId, timestamp: new Date() };
}

/**
 * Upload a media binary to the social Attachment Upload API
 * (`/{accountId}/message_attachments`) and return a reusable attachment id.
 * Works for image / video / audio / file on BOTH Messenger and Instagram. The
 * attachment `type` is derived from the mime type and must match the `type` the
 * later send uses (both derive it deterministically). Mirrors WhatsApp's
 * `uploadMedia` (bytes → provider id), so the generic send path is unchanged.
 */
export async function uploadSocialMedia(
  args: UploadMediaArgs,
  opts: SocialSendTarget,
): Promise<UploadMediaResult> {
  const type = attachmentTypeFromKind(kindFromMime(args.mimeType));
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/message_attachments`;
  const form = new FormData();
  // `platform` is Instagram-only and REQUIRED there — confirmed verbatim against
  // the Instagram Attachment Upload doc, whose every sample body carries
  // `"platform":"instagram"`. The endpoint is hosted on the same Page node for
  // both channels, so Meta needs telling which surface the attachment is for.
  // Messenger's own reference has no such field, hence the label check rather
  // than an unconditional add.
  //
  // NOTE: Instagram does not reach this function today — `mediaSendByUrl` routes
  // it down the URL branch in `send-media-internal`. This is kept correct so the
  // upload path is not the thing that breaks if that ever changes; see the
  // capability's comment for the OTHER half that would need changing (Instagram
  // sends a stored attachment as `MEDIA_SHARE`, not as its media kind).
  if (opts.label === "instagram") form.append("platform", "instagram");
  form.append(
    "message",
    JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }),
  );
  // Meta reads the bytes from the `filedata` part. Blob carries the mime type;
  // the filename helps Meta render document names on the recipient side.
  // The assertion narrows Uint8Array<ArrayBufferLike> → <ArrayBuffer> for the
  // DOM lib's BlobPart: these bytes come from Node fetch/R2 reads, which never
  // wrap a SharedArrayBuffer.
  form.append(
    "filedata",
    new Blob([args.bytes as Uint8Array<ArrayBuffer>], { type: args.mimeType }),
    args.filename,
  );
  const res = await graphPostForm(url, opts.accessToken, form, opts.appSecret);
  const attachmentId = typeof res.attachment_id === "string" ? res.attachment_id : "";
  if (!attachmentId) {
    throw new Error(`${opts.label} uploadMedia: response missing attachment_id`);
  }
  return { mediaId: attachmentId };
}

/**
 * Send a previously-uploaded media attachment on a social channel. Meta social
 * messages can't carry BOTH an attachment and text in one call, so media is sent
 * ON ITS OWN — no caption ride-along and no follow-up text (a separate follow-up
 * echoed back as a corrupt "via app" duplicate). The composer sends such a file
 * alone; any caption reaching here is ignored. Returns the ATTACHMENT message's
 * id — the one the app persists. Human Agent tag, same as text.
 */
export async function sendSocialMedia(
  args: SendMediaArgs,
  opts: SocialSendTarget,
): Promise<SendTextResult> {
  const type = attachmentTypeFromKind(args.kind);
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  // Instagram sends media by public URL; Messenger by reusable attachment_id.
  const payload = args.mediaUrl
    ? { url: args.mediaUrl, is_reusable: false }
    : { attachment_id: args.mediaId };
  const res = await graphPostJson(url, opts.accessToken, {
    recipient: { id: args.to },
    ...messagingTypeFields(args.useHumanAgentTag),
    ...replyToFragment(args.replyToExternalId, args.useHumanAgentTag),
    message: { attachment: { type, payload } },
  }, opts.appSecret);
  const messageId = typeof res.message_id === "string" ? res.message_id : "";
  if (!messageId) {
    throw new Error(`${opts.label} sendMedia: response missing message_id`);
  }
  // No caption follow-up: social media sends on its own (see the doc comment).
  return { externalId: messageId, timestamp: new Date() };
}

/**
 * Send a `sender_action` (mark_seen / typing_on / typing_off) to a recipient on
 * a Meta social channel. Read receipts + typing are by-THREAD (keyed on the
 * recipient's PSID / IGSID), not by-message. Best-effort — the caller swallows
 * errors, but we throw here so a caller that wants to log can.
 */
export async function sendSocialSenderAction(
  action: "mark_seen" | "typing_on" | "typing_off",
  recipientId: string,
  opts: SocialSendTarget,
): Promise<void> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  await graphPostJson(url, opts.accessToken, {
    recipient: { id: recipientId },
    sender_action: action,
  }, opts.appSecret);
}

/**
 * Send (or remove) a business reaction to a customer message on a Meta SOCIAL
 * channel (Messenger / Instagram). Both use the unified messaging endpoint with
 * `sender_action: "react" | "unreact"` and a `payload.message_id` (+ `reaction`
 * emoji for react). Empty emoji ⇒ unreact. Mirrors the WhatsApp reaction on the
 * WhatsApp provider — same `SendReactionArgs` shape.
 */
export async function sendSocialReaction(
  args: SendReactionArgs,
  opts: SocialSendTarget,
): Promise<SendTextResult> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  const remove = args.emoji.trim() === "";
  // Instagram supports exactly ONE outbound (business) reaction: the literal
  // `reaction:"love"` (a heart). Any other value is rejected by Meta (#100).
  // Customers can react INBOUND with any emoji, but an agent can only send the
  // heart — so coerce IG to "love" (the composer also offers heart-only on IG).
  // Messenger accepts the emoji glyph, so pass it through there.
  const reaction = opts.label === "instagram" ? "love" : args.emoji;
  await graphPostJson(url, opts.accessToken, {
    recipient: { id: args.to },
    sender_action: remove ? "unreact" : "react",
    payload: remove
      ? { message_id: args.messageExternalId }
      : { message_id: args.messageExternalId, reaction },
  }, opts.appSecret);
  // Reactions mutate the target message, not a new row — return a synthetic id.
  return { externalId: `reaction:${args.messageExternalId}`, timestamp: new Date() };
}

// ─── Conversation entry points (`/{page-id}/messenger_profile`) ─────────────
//
// Ice breakers and the persistent menu are the two things a customer can see
// BEFORE they type anything — the closest Instagram has to a self-serve front
// door. Both live on the same `messenger_profile` node, both are per-locale, and
// on Instagram both REQUIRE `platform=instagram` (the node is hosted on the
// linked Page, which also serves Messenger, so the platform is what disambiguates
// which surface is being configured).
//
// Meta's own limits, enforced by the request schema rather than discovered at
// send time: at most 4 ice breakers, and "limit to 5" persistent-menu items. Both
// documents make the `default` locale mandatory — an entry-point set with no
// default locale simply never renders, with no error.

/** Meta's documented caps. Exported so the request schema can't drift from them. */
export const MAX_ICE_BREAKERS = 4;
export const MAX_PERSISTENT_MENU_ITEMS = 5;

function entryPointsUrl(opts: SocialSendTarget, query = ""): string {
  const base = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messenger_profile`;
  const platform = opts.label === "instagram" ? "platform=instagram" : "";
  const qs = [platform, query].filter(Boolean).join("&");
  return qs ? `${base}?${qs}` : base;
}

/**
 * Read the account's current entry points. Returns empty arrays when nothing is
 * configured — Meta answers `{ data: [] }`, not a 404, so "unset" and "empty" are
 * the same state and there is nothing to distinguish.
 */
export async function getChannelEntryPoints(
  opts: SocialSendTarget,
): Promise<ChannelEntryPoints> {
  const res = await graphGetJson(
    entryPointsUrl(opts, "fields=ice_breakers,persistent_menu"),
    opts.accessToken,
    { retry: true },
    opts.appSecret,
  );
  // `data` is an array of profile objects, one per configured field.
  const data = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
  const iceBreakers: ChannelIceBreaker[] = [];
  const menuItems: ChannelMenuItem[] = [];
  for (const entry of data) {
    // Both fields are per-LOCALE arrays. We configure the `default` locale only
    // (the one Meta requires), so read that one back and ignore any others a
    // previous tool may have set rather than merging locales into one flat list.
    const ib = Array.isArray(entry.ice_breakers) ? entry.ice_breakers : [];
    for (const locale of ib as Array<Record<string, unknown>>) {
      if (locale.locale !== undefined && locale.locale !== "default") continue;
      const calls = Array.isArray(locale.call_to_actions) ? locale.call_to_actions : [];
      for (const c of calls as Array<Record<string, unknown>>) {
        if (typeof c.question === "string" && typeof c.payload === "string") {
          iceBreakers.push({ question: c.question, payload: c.payload });
        }
      }
    }
    const pm = Array.isArray(entry.persistent_menu) ? entry.persistent_menu : [];
    for (const locale of pm as Array<Record<string, unknown>>) {
      if (locale.locale !== undefined && locale.locale !== "default") continue;
      const calls = Array.isArray(locale.call_to_actions) ? locale.call_to_actions : [];
      for (const c of calls as Array<Record<string, unknown>>) {
        if (c.type === "web_url" && typeof c.title === "string" && typeof c.url === "string") {
          menuItems.push({ type: "web_url", title: c.title, url: c.url });
        } else if (
          c.type === "postback" &&
          typeof c.title === "string" &&
          typeof c.payload === "string"
        ) {
          menuItems.push({ type: "postback", title: c.title, payload: c.payload });
        }
      }
    }
  }
  return { iceBreakers, menuItems };
}

/**
 * Write the account's entry points.
 *
 * An EMPTY list DELETES that field rather than posting an empty array: Meta's
 * delete is its own `DELETE … {fields:[…]}` call, and posting `call_to_actions:
 * []` is not documented to clear anything — it would leave the previous set live
 * while our UI showed none. The two fields are cleared independently so removing
 * every ice breaker can't also wipe a persistent menu the operator still wants.
 */
export async function setChannelEntryPoints(
  entryPoints: ChannelEntryPoints,
  opts: SocialSendTarget,
): Promise<void> {
  const profile: Record<string, unknown> = {};
  const clear: string[] = [];

  if (entryPoints.iceBreakers.length > 0) {
    profile.ice_breakers = [
      { locale: "default", call_to_actions: entryPoints.iceBreakers },
    ];
  } else {
    clear.push("ice_breakers");
  }

  if (entryPoints.menuItems.length > 0) {
    profile.persistent_menu = [
      {
        locale: "default",
        call_to_actions: entryPoints.menuItems,
      },
    ];
  } else {
    clear.push("persistent_menu");
  }

  if (Object.keys(profile).length > 0) {
    await graphPostJson(entryPointsUrl(opts), opts.accessToken, profile, opts.appSecret);
  }
  if (clear.length > 0) {
    // Meta's documented delete shape: the field list travels in the BODY.
    await graphDeleteJson(
      entryPointsUrl(opts),
      opts.accessToken,
      { fields: clear },
      opts.appSecret,
    );
  }
}

/**
 * Reply PUBLICLY to an Instagram comment — a sub-thread reply on the comment
 * itself, not a DM.
 *
 * Doc-exact: `POST /<IG_COMMENT_ID>/replies` with `{ message }`, answering with
 * `{ id }` — the new comment's id.
 *
 * This is the OTHER half of answering a comment, and it is a different promise
 * from the private reply. A private reply opens a DM with that one person, is
 * capped at one per comment within 7 days, and nobody else sees it. A public
 * reply is visible to everyone reading the post, has no such cap, and starts no
 * conversation. Teams need both: "we've DM'd you" and "for everyone else asking,
 * here's the answer".
 *
 * Addressed at the COMMENT node, so unlike every other call in this module the
 * host is the comment id rather than the Page.
 */
export async function replyToSocialComment(
  commentId: string,
  message: string,
  opts: SocialSendTarget,
): Promise<{ commentId: string }> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(commentId)}/replies`;
  const res = await graphPostJson(url, opts.accessToken, { message }, opts.appSecret);
  const id = typeof res.id === "string" ? res.id : "";
  if (!id) {
    throw new Error(`${opts.label} replyToComment: response missing id`);
  }
  return { commentId: id };
}

/**
 * Meta's cap on ids per Moderate Conversations request: "Up to 10 IDs can be
 * provided in each request".
 */
const MODERATE_CONVERSATIONS_MAX_IDS = 10;

/**
 * Block or unblock Instagram users through the Moderate Conversations API
 * (`POST /{page-id}/moderate_conversations`).
 *
 * Instagram DOES have a provider-level blocklist — this codebase asserted for a
 * while that only WhatsApp did, which was simply out of date: Meta shipped the
 * Instagram Moderate Conversations API on 2025-10-21 ("Instagram Moderate
 * Conversations API enables blocking/unblocking users and spam management").
 *
 * Doc-exact wire shape: `{ user_ids: [{ id: IGSID }], actions: ["block_user"] }`,
 * against the linked PAGE node (like every other Instagram-via-Facebook-Login
 * call). `unblock_user` is the inverse and Meta is explicit that it "cannot be
 * included in the same request as block_user" — which is why each direction is
 * its own call rather than one batched body.
 *
 * The response is `{"success": "true"}` — a STRING, not a boolean, and Meta
 * documents `"success": "false"` for a failure that still returns 2xx. So a
 * truthy-object check would report a refused block as applied, and
 * `Contact.blockedAt` would then claim a block Meta is not enforcing. Both
 * spellings are accepted and anything else is a failure.
 */
export async function moderateSocialConversations(
  action: "block_user" | "unblock_user" | "move_to_spam",
  igsids: string[],
  opts: SocialSendTarget,
): Promise<{ succeeded: string[]; failed: Array<{ id: string; error: string }> }> {
  if (igsids.length > MODERATE_CONVERSATIONS_MAX_IDS) {
    // Refuse rather than truncate: silently dropping ids past the 10th would
    // report a block that never reached Meta for everyone after it.
    throw new Error(
      `${opts.label} ${action}: ${igsids.length} ids exceeds Meta's ${MODERATE_CONVERSATIONS_MAX_IDS}/request cap`,
    );
  }
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/moderate_conversations`;
  const res = await graphPostJson(
    url,
    opts.accessToken,
    { user_ids: igsids.map((id) => ({ id })), actions: [action] },
    opts.appSecret,
  );
  const raw = res.success;
  const ok = raw === true || (typeof raw === "string" && raw.trim().toLowerCase() === "true");
  if (ok) return { succeeded: [...igsids], failed: [] };
  return {
    succeeded: [],
    failed: igsids.map((id) => ({
      id,
      // Meta returns `success:"false"` with no per-id reason, so surface what it
      // actually said rather than inventing a cause.
      error:
        typeof raw === "string" || typeof raw === "boolean"
          ? `Instagram refused the ${action.replace("_user", "")} (success=${String(raw)}).`
          : `Instagram returned an unrecognised response to ${action}.`,
    })),
  };
}

/**
 * Best-effort profile for a social contact — the messaging webhook carries no
 * name, so we read the profile node (`/{id}?fields=…`). `fields` differs per
 * channel (Messenger: `name,profile_pic`; Instagram: `name,username,
 * profile_pic`). Returns the resolved display name plus the Instagram @username
 * and profile-picture URL when present. Never throws — the caller enriches
 * opportunistically and keeps the id-as-name fallback on any failure — but a
 * profile error is LOGGED (the common ones: 2018218 "no matching user",
 * 2534014 "Instagram user not reachable") rather than swallowed blind, so a
 * misconfigured page surfaces in ops.
 */
export interface SocialContactProfile {
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  /** Meta-supplied name split (Messenger). Null when the node omits them. */
  firstName: string | null;
  lastName: string | null;
  /** Instagram-only richer signals; null on Messenger / when the node omits them. */
  socialProfile: SocialProfile | null;
}

export async function fetchSocialProfile(
  externalId: string,
  opts: {
    accessToken: string;
    graphVersion: string;
    fields: string;
    label: string;
    /**
     * The app secret that issued `accessToken`, for `appsecret_proof`.
     *
     * Not optional in spirit, only in type: with the Meta app's "Require App
     * Secret" setting on (Meta's own recommendation) a proof-less Graph call is
     * REJECTED — and this function fails soft to all-nulls, so the whole channel
     * would silently lose every contact name, @username and avatar with nothing in
     * the logs but an info line. Every other social Graph call already threads it;
     * this read was the one that didn't.
     */
    appSecret?: string;
    /**
     * Core field set to retry with when `fields` is rejected. Graph fails the
     * WHOLE node request if ANY requested field is unavailable to the app, and
     * this function fails soft to all-nulls — so one unapproved field would
     * silently erase the display name of every contact on the channel. Same
     * best-effort tiering as `PAGE_OPTIONAL_FIELDS` in meta-page-subscription.
     */
    fallbackFields?: string;
  },
): Promise<SocialContactProfile> {
  const fetchFields = async (fields: string) => {
    const url = `${GRAPH_BASE}/${opts.graphVersion}/${encodeURIComponent(externalId)}?fields=${encodeURIComponent(fields)}`;
    return graphGetJson(url, opts.accessToken, { retry: true }, opts.appSecret);
  };
  try {
    let res: Record<string, unknown>;
    try {
      res = await fetchFields(opts.fields);
    } catch (err) {
      if (!opts.fallbackFields || opts.fallbackFields === opts.fields) throw err;
      console.warn(
        JSON.stringify({
          event: "social.profile_fields_rejected",
          severity: "info",
          channel: opts.label,
          retryingWith: opts.fallbackFields,
        }),
      );
      res = await fetchFields(opts.fallbackFields);
    }
    const name = typeof res.name === "string" ? res.name.trim() : "";
    // Messenger exposes the split name directly — better than guessing where the
    // surname starts, which `splitContactName` has to do for a single string.
    const firstName = typeof res.first_name === "string" ? res.first_name.trim() : "";
    const lastName = typeof res.last_name === "string" ? res.last_name.trim() : "";
    const username = typeof res.username === "string" ? res.username.trim() : "";
    const avatarUrl = typeof res.profile_pic === "string" ? res.profile_pic.trim() : "";
    // Instagram-only richer signals — Messenger never requests them, so they're
    // simply absent. Each field is copied only when present so a partial node
    // response degrades cleanly to null.
    const social: SocialProfile = {};
    if (typeof res.follower_count === "number") social.followerCount = res.follower_count;
    if (typeof res.is_verified_user === "boolean") social.isVerified = res.is_verified_user;
    if (typeof res.is_user_follow_business === "boolean")
      social.followsBusiness = res.is_user_follow_business;
    if (typeof res.is_business_follow_user === "boolean")
      social.businessFollows = res.is_business_follow_user;
    // Messenger identity signals (behind `pages_user_*` App Review). Meta's
    // `timezone` is a GMT offset NUMBER (e.g. -7); `locale`/`gender` are strings.
    // Each copied only when present so an un-approved perm degrades to absent.
    if (typeof res.locale === "string" && res.locale.trim()) social.locale = res.locale.trim();
    if (typeof res.timezone === "number") social.timezone = res.timezone;
    if (typeof res.gender === "string" && res.gender.trim()) social.gender = res.gender.trim();
    return {
      name: name || [firstName, lastName].filter(Boolean).join(" ") || username || null,
      firstName: firstName || null,
      lastName: lastName || null,
      username: username || null,
      avatarUrl: avatarUrl || null,
      socialProfile: Object.keys(social).length > 0 ? social : null,
    };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "social.profile_fetch_failed",
        severity: "info",
        channel: opts.label,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return {
      name: null,
      firstName: null,
      lastName: null,
      username: null,
      avatarUrl: null,
      socialProfile: null,
    };
  }
}

// ─── Messenger Calling (unified POST /{page-id}/calls) ──────────────────────
// Meta uses ONE endpoint with
// an `action` discriminator and returns SDP synchronously — unlike WhatsApp's
// method-per-action + webhook-delivered answer, so these are their own funcs.

/** Perform a Messenger call action against `POST /{page-id}/calls`. */
export async function sendSocialCallAction(
  args: CallActionArgs,
  opts: SocialSendTarget,
): Promise<CallActionResult> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/calls`;
  // `platform` is the channel Meta routes the call on ("messenger"; Instagram
  // has no calling API today, so only Messenger reaches here). Derived from the
  // provider label rather than hardcoded, so it stays correct if Meta ships IG.
  const body: Record<string, unknown> = { platform: opts.label, action: args.action };
  if (args.callId) body.call_id = args.callId;
  if (args.to) body.to = args.to;
  if (args.sdp) {
    // connect/accept carry the business-generated OFFER; a media_update relays
    // our ANSWER to Meta's mid-call renegotiation offer, so its sdp_type differs.
    const sdpType = args.action === "media_update" ? "answer" : "offer";
    body.session = { sdp_type: sdpType, sdp: args.sdp };
  }
  const res = await graphPostJson(url, opts.accessToken, body, opts.appSecret);
  const session = (res.session ?? {}) as {
    sdp_response?: { sdp?: string } | string;
    sdp_renegotiation?: { sdp?: string } | string;
  };
  const readSdp = (v: { sdp?: string } | string | undefined): string | undefined =>
    typeof v === "string" ? v : v?.sdp;
  return {
    callId: typeof res.id === "string" ? res.id : undefined,
    sdpAnswer: readSdp(session.sdp_response),
    sdpRenegotiation: readSdp(session.sdp_renegotiation),
  };
}

/** Query a consumer's outbound-call permission (`GET messenger_call_permissions`). */
export async function checkSocialCallPermission(
  psid: string,
  opts: SocialSendTarget,
): Promise<SocialCallPermission> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messenger_call_permissions?psid=${encodeURIComponent(psid)}`;
  const res = await graphGetJson(url, opts.accessToken, { retry: true }, opts.appSecret);
  const permission = (res.permission ?? {}) as { status?: string; expiration_time?: number };
  // The field is `can_perform_action`, NOT `can_perform`. This read used to be the
  // short spelling, which is present on no documented response — so both flags were
  // hard-false for every consumer, permanently. `can_perform` is kept only as a
  // tolerated alias.
  //
  // The WhatsApp twin of this resolver (`getCallPermission` in meta.ts) has always
  // had the right key; the two copies of one lookup drifted. Latent today only
  // because `CHANNEL_CAPABILITIES.messenger.calling` is false — this must be
  // correct before that flag is flipped.
  const actions = Array.isArray(res.actions)
    ? (res.actions as Array<{
        action_name?: string;
        can_perform_action?: boolean;
        can_perform?: boolean;
      }>)
    : [];
  const action = (name: string) => actions.find((a) => a.action_name === name);
  // Mirror the WhatsApp side's fail-OPEN default. `=== true` made an ABSENT action
  // entry indistinguishable from an explicit denial, which is the wrong direction:
  // Meta omits the array in responses where the action is simply unconstrained, and
  // treating that as "you may not call" hides the affordance with no way to recover.
  const can = (name: string, fallback: boolean) => {
    const a = action(name);
    return a?.can_perform_action ?? a?.can_perform ?? fallback;
  };
  const status = permission.status;
  return {
    hasPermission: status === "has_permission",
    canStartCall: can("start_call", status === "has_permission"),
    canRequestPermission: can("send_call_permission_request", true),
    expiresAt: typeof permission.expiration_time === "number" ? new Date(permission.expiration_time * 1000) : null,
  };
}

/** Send a `calling_optin` permission request (≤2/thread/day, 7-day validity). */
export async function requestSocialCallPermission(
  psid: string,
  opts: SocialSendTarget,
): Promise<{ messageId: string }> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  const res = await graphPostJson(url, opts.accessToken, {
    recipient: { id: psid },
    message: { attachment: { type: "template", payload: { template_type: "calling_optin" } } },
  }, opts.appSecret);
  return { messageId: typeof res.message_id === "string" ? res.message_id : "" };
}

/** True when the Page has the Messenger Calling feature enabled. */
export async function socialCallFeatureEnabled(opts: SocialSendTarget): Promise<boolean> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/business_messaging_feature_status`;
  const res = await graphPostJson(url, opts.accessToken, {
    features: [{ feature: "messenger_api_calling" }],
  }, opts.appSecret);
  const data = Array.isArray(res.data) ? (res.data as Array<{ feature?: string; status?: string }>) : [];
  return data.some((d) => d.feature === "messenger_api_calling" && String(d.status).toLowerCase() === "enabled");
}

/**
 * Route consumer-initiated calls to third-party apps (`PARTNERS`) — i.e. THIS
 * inbox — vs Meta's own surfaces (`META`). The Page MUST be on `PARTNERS` (and
 * subscribed to the `calls` webhook) to receive inbound calls here; without it
 * inbound calls only ring Meta Business Inbox. Business-initiated calls work
 * regardless. Idempotent.
 */
export async function setSocialCallRouting(
  ringTarget: "META" | "PARTNERS",
  opts: SocialSendTarget,
): Promise<void> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messenger_call_settings`;
  await graphPostJson(url, opts.accessToken, { call_routing: { ring_target: ringTarget } }, opts.appSecret);
}

/** Read the Page's current inbound-call routing target. */
export async function getSocialCallRouting(
  opts: SocialSendTarget,
): Promise<"META" | "PARTNERS" | null> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messenger_call_settings?fields=call_routing`;
  const res = await graphGetJson(url, opts.accessToken, { retry: true }, opts.appSecret);
  const routing = (res.call_routing ?? {}) as { ring_target?: string };
  return routing.ring_target === "META" || routing.ring_target === "PARTNERS"
    ? routing.ring_target
    : null;
}

/**
 * Turn the Page's CALL SETTINGS on. `audio_enabled` + `video_enabled` are the
 * actual on-switch — WITHOUT them Meta reports "Call Settings Not Enabled"
 * (subcode 1893056) on every calling API (permission check, place-call), even
 * with the feature granted and routing set. `icon_enabled` just shows the in-
 * thread call button. Verified live 2026-07-13: setting only `icon_enabled`
 * left calling non-functional; adding audio/video is what enables it.
 */
export async function setSocialCallEnabled(
  enabled: boolean,
  opts: SocialSendTarget,
): Promise<void> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messenger_call_settings`;
  await graphPostJson(url, opts.accessToken, {
    audio_enabled: enabled,
    video_enabled: enabled,
    icon_enabled: enabled,
  }, opts.appSecret);
}

/**
 * One-shot "make this Page ready to place AND receive calls in our inbox":
 *   - ENABLE audio + video calling on the Page (the load-bearing on-switch —
 *     without it every calling API returns "Call Settings Not Enabled"),
 *   - route consumer-initiated calls to PARTNERS (us) — REQUIRED to receive
 *     inbound calls here rather than only in Meta Business Inbox, and
 *   - show the in-thread call icon.
 * Then report the feature status so ops can see whether Meta has actually
 * enabled Messenger Calling on the Page. Idempotent; mirrors WhatsApp's
 * `enableCalling`.
 */
export async function enableSocialCalling(
  opts: SocialSendTarget,
): Promise<{ ok: true; raw: unknown }> {
  // Audio/video enablement first — it's what makes calling actually work.
  await setSocialCallEnabled(true, opts);
  await setSocialCallRouting("PARTNERS", opts);
  const featureEnabled = await socialCallFeatureEnabled(opts).catch(() => false);
  return {
    ok: true,
    raw: { audio_enabled: true, video_enabled: true, icon_enabled: true, ring_target: "PARTNERS", featureEnabled },
  };
}
