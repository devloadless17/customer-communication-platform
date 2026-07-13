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
  NormalizedStatusUpdate,
  ContactShareField,
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
  graphGetJson,
  graphPostForm,
  graphPostJson,
} from "@/lib/providers/meta-graph";
import { kindFromMime } from "@/lib/media-storage";

/** Shared identity of the Meta account addressing a send (Page id / IG id). */
export interface SocialSendTarget {
  accountId: string;
  accessToken: string;
  graphVersion: string;
  /** Provider name for error messages ("messenger" / "instagram"). */
  label: string;
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
interface SocialEntry {
  id?: string;
  time?: number;
  messaging?: MessagingEvent[];
  // Messenger Calling lifecycle events (connect / call_status / media_update /
  // terminate) ride their own array on the entry — see docs/messenger-calling.md.
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
interface MessagingEvent {
  sender?: { id?: string };
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
    attachments?: {
      type?: string;
      title?: string;
      payload?: { url?: string; coordinates?: { lat?: number; long?: number } };
    }[];
    quick_reply?: { payload?: string };
    // Set when the customer quoted a message — the mid they replied to.
    // A quoted reply to a message (`mid`) OR — Instagram only — a reply to one of
    // OUR stories, which arrives as a normal text message with `reply_to.story`
    // (no mid). We surface the latter as a story-reply card so the agent sees the
    // context, not a bare text bubble.
    reply_to?: { mid?: string; story?: { url?: string; id?: string } };
  };
  // The customer EDITED a message (`message_edits` field). MESSENGER ONLY —
  // Instagram ships no edit webhook, so an IG message's text is immutable once
  // received. Carries the new text for an existing `mid`.
  message_edit?: { mid?: string; text?: string; num_edit?: number };
  delivery?: { mids?: string[]; watermark?: number };
  // Messenger sends a `watermark` (all outbound up to it are read); Instagram
  // sends a per-message `mid` (the specific message the customer read).
  read?: { watermark?: number; mid?: string };
  reaction?: { mid?: string; action?: string; emoji?: string; reaction?: string };
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
  ads_context_data?: Record<string, unknown>;
}

/**
 * Map a Messenger `referral` to the channel-agnostic `MessageAttribution` (the
 * same shape WhatsApp Click-to-WhatsApp fills), so the "from your ad" chip works
 * identically across channels. `ad_id` ⇒ a paid ad; otherwise the `ref` deep-link
 * payload (m.me/checkbox plugin). `ads_context_data` sometimes carries the ad
 * creative's title/photo — surface the title as the headline when present.
 */
function attributionFromSocialReferral(r: SocialReferral): MessageAttribution {
  const ctx = (r.ads_context_data ?? {}) as { ad_title?: unknown };
  const headline =
    typeof ctx.ad_title === "string" && ctx.ad_title.trim() ? ctx.ad_title.trim() : undefined;
  const source: MessageAttribution["source"] = r.ad_id ? "ad" : r.ref ? "ref" : "unknown";
  return {
    source,
    ...(headline ? { headline } : {}),
    ...(r.ad_id?.trim() ? { clickId: r.ad_id.trim() } : {}),
    ...(r.ref?.trim() ? { ref: r.ref.trim() } : {}),
  };
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
  atts:
    | {
        type?: string;
        title?: string;
        payload?: { url?: string; coordinates?: { lat?: number; long?: number } };
      }[]
    | undefined,
): MessageStructured | undefined {
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
 * `externalCallId`. Full shape reference: docs/messenger-calling.md.
 */
function mapSocialCall(c: SocialCallWire): NormalizedCallEvent | null {
  const externalCallId = c.id;
  if (!externalCallId || !c.event) return null;
  const timestamp = new Date((c.timestamp ?? Date.now()) * (c.timestamp ? 1000 : 1));
  const base = { kind: "call" as const, externalCallId, contactName: null, timestamp, rawPayload: c as unknown as Record<string, unknown> };

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

export function parseSocialMessaging(
  payload: unknown,
  expectedObject: string,
): NormalizedEvent[] {
  if (!isObject(payload)) return [];
  const env = payload as SocialEnvelope;
  if (env.object !== expectedObject || !Array.isArray(env.entry)) return [];

  const events: NormalizedEvent[] = [];
  for (const entry of env.entry) {
    // Call lifecycle events (Messenger Calling) ride entry.calls[], separate
    // from messaging. An entry carries one or the other.
    if (Array.isArray(entry.calls)) {
      for (const c of entry.calls) {
        const call = mapSocialCall(c);
        if (call) events.push(call);
      }
    }
    // Business-initiated call permission opt-in reply (entry-level).
    if (entry.call_permission_reply?.response && entry.sender?.id) {
      const approved = entry.call_permission_reply.response === "approve";
      events.push({
        kind: "call",
        externalCallId: `perm:${entry.sender.id}:${entry.timestamp ?? ""}`,
        externalContactId: entry.sender.id,
        contactName: null,
        direction: "out",
        phase: approved ? "permission_granted" : "permission_revoked",
        timestamp: new Date((entry.timestamp ?? Math.floor(Date.now() / 1000)) * 1000),
        rawPayload: entry as unknown as Record<string, unknown>,
      });
    }
    if (!Array.isArray(entry.messaging)) continue;
    for (const m of entry.messaging) {
      // Unsend: the customer deleted a message. References an existing mid;
      // tombstone the stored row (no new content). Checked before the echo/
      // message branches since a deleted message carries `message.mid`.
      if (m.message?.is_deleted && m.message.mid) {
        events.push({
          kind: "message_correction",
          action: "delete",
          targetExternalId: m.message.mid,
          timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
          rawPayload: m as unknown as Record<string, unknown>,
        });
        continue;
      }
      // Edit (Messenger `message_edits`; Instagram has no equivalent webhook).
      // Rewrites an existing row's body, exactly as the WhatsApp `type:"edit"`
      // branch does — without this, the Page is subscribed to `message_edits`
      // and the notification is parsed into nothing, leaving the agent looking
      // at text the customer has already corrected.
      if (m.message_edit?.mid && typeof m.message_edit.text === "string") {
        events.push({
          kind: "message_correction",
          action: "edit",
          targetExternalId: m.message_edit.mid,
          newBody: m.message_edit.text,
          timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
          rawPayload: m as unknown as Record<string, unknown>,
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
          events.push({
            kind: "echo",
            externalId: mid,
            externalContactId: customerId,
            body: text && text.length > 0 ? text : "",
            ...(media ? { media } : {}),
            timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
            rawPayload: m as unknown as Record<string, unknown>,
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
            events.push({
              kind: "echo",
              externalId: `${mid}:att:${i + 1}`,
              externalContactId: customerId,
              body: "",
              media: extra,
              timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
              rawPayload: m as unknown as Record<string, unknown>,
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
                : m.message.is_unsupported
                  ? "⚠️ Unsupported message"
                  : "";
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
          // Click-to-Messenger ad / m.me-ref attribution → "from your ad" chip.
          ...(m.referral
            ? { attribution: attributionFromSocialReferral(m.referral) }
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
          rawPayload: m as unknown as Record<string, unknown>,
        };
        events.push(msg);
        // Sibling rows for the additional media in a multi-attachment message.
        // Stable derived externalId (`${mid}:att:${i}`) keeps dedup idempotent
        // across Meta's at-least-once redelivery — mirrors how WhatsApp yields
        // one row per media, so the inbox renders all N attachments.
        extraMedia.forEach((extra, i) => {
          events.push({
            kind: "message",
            externalId: `${mid}:att:${i + 1}`,
            externalContactId: senderId,
            contactName: null,
            body: "",
            media: extra,
            timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
            rawPayload: m as unknown as Record<string, unknown>,
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
            rawPayload: m as unknown as Record<string, unknown>,
          };
          events.push(msg);
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
          const label = attribution.headline
            ? `Started a conversation from your ad · ${attribution.headline}`
            : "Started a conversation from your ad";
          events.push({
            kind: "message",
            externalId,
            externalContactId: senderId,
            contactName: null,
            body: label,
            attribution,
            timestamp: new Date(m.timestamp ?? entry.time ?? Date.now()),
            rawPayload: m as unknown as Record<string, unknown>,
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
          rawPayload: m as unknown as Record<string, unknown>,
        };
        events.push(reaction);
        continue;
      }
      // Delivery receipts carry the mids Meta delivered.
      if (m.delivery && Array.isArray(m.delivery.mids)) {
        const ts = new Date(m.delivery.watermark ?? m.timestamp ?? Date.now());
        for (const mid of m.delivery.mids) {
          if (!mid) continue;
          const status: NormalizedStatusUpdate = {
            kind: "status",
            externalId: mid,
            status: "delivered",
            timestamp: ts,
            rawPayload: m as unknown as Record<string, unknown>,
          };
          events.push(status);
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
            rawPayload: m as unknown as Record<string, unknown>,
          };
          events.push(status);
        } else if (typeof m.read.watermark === "number") {
          const from = m.sender?.id;
          if (from) {
            events.push({
              kind: "read_watermark",
              externalContactId: from,
              watermark: new Date(m.read.watermark),
              rawPayload: m as unknown as Record<string, unknown>,
            });
          }
        }
      }
      // Observability: a messaging event we don't handle yet (optin,
      // account_linking, game_plays, …). Logged — not dropped silently — so a
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
 */
function replyToFragment(replyToExternalId?: string): { reply_to: { mid: string } } | object {
  return replyToExternalId ? { reply_to: { mid: replyToExternalId } } : {};
}

/**
 * The messaging-type fields for a social send. Within the 24h window Meta wants
 * `RESPONSE` (no tag, and it needs no special feature); only outside 24h (in the
 * 24h–7d support band) do we attach the Human Agent tag. The caller passes
 * `useHumanAgentTag` from the window band; when it's undefined we keep the tag
 * (safe default — the tag is valid across the whole 7-day window).
 */
function messagingTypeFields(useHumanAgentTag?: boolean): object {
  return useHumanAgentTag === false
    ? { messaging_type: "RESPONSE" }
    : { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" };
}

/**
 * Send a text message on a Meta social channel. `accountId` is the Page id
 * (Messenger / Instagram both send via the Page); `accessToken` is the Page
 * token. Human Agent tag = valid for the 7-day support window. Quoted replies
 * are supported via `reply_to.mid`.
 */
export async function sendSocialText(
  args: SendTextArgs,
  opts: SocialSendTarget,
): Promise<SendTextResult> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messages`;
  const res = await graphPostJson(url, opts.accessToken, {
    recipient: { id: args.to },
    ...messagingTypeFields(args.useHumanAgentTag),
    ...replyToFragment(args.replyToExternalId),
    message: { text: args.body },
  });
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
 * Send an interactive question with tappable options on a social channel, as
 * Meta QUICK REPLIES (up to 13; title ≤20 chars; the option id rides in the
 * `payload` and comes back on the tapped reply). Both "buttons" and "list"
 * kinds collapse to quick replies — the social platforms have no native list
 * sheet, and quick replies are the closest tap-to-choose UX. Human Agent tag.
 *
 * `args.contactShare` appends Meta's auto-fill consent chips. Those carry ONLY
 * a `content_type` — sending `title`/`payload` alongside makes Meta reject the
 * whole message ("message[quick_replies][0][content_type] is required"), because
 * the platform supplies both from the customer's profile. They're appended last
 * so a full option set can't push them out of the 13-chip budget silently: the
 * text options are trimmed instead.
 */
export async function sendSocialInteractive(
  args: SendInteractiveArgs,
  opts: SocialSendTarget,
): Promise<SendTextResult> {
  const shares = args.contactShare ?? [];
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
    ...replyToFragment(args.replyToExternalId),
    message: { text: args.bodyText, quick_replies },
  });
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
  form.append(
    "message",
    JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }),
  );
  // Meta reads the bytes from the `filedata` part. Blob carries the mime type;
  // the filename helps Meta render document names on the recipient side.
  form.append(
    "filedata",
    new Blob([args.bytes], { type: args.mimeType }),
    args.filename,
  );
  const res = await graphPostForm(url, opts.accessToken, form);
  const attachmentId = typeof res.attachment_id === "string" ? res.attachment_id : "";
  if (!attachmentId) {
    throw new Error(`${opts.label} uploadMedia: response missing attachment_id`);
  }
  return { mediaId: attachmentId };
}

/**
 * Send a previously-uploaded media attachment on a social channel. Meta social
 * messages can't carry BOTH an attachment and text in one call, so a caption is
 * delivered as a best-effort follow-up text message (the media row still stores
 * the caption for the agent's view). Returns the ATTACHMENT message's id — the
 * one the app persists. Human Agent tag, same as text.
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
    ...replyToFragment(args.replyToExternalId),
    message: { attachment: { type, payload } },
  });
  const messageId = typeof res.message_id === "string" ? res.message_id : "";
  if (!messageId) {
    throw new Error(`${opts.label} sendMedia: response missing message_id`);
  }
  // Caption → follow-up text. Best-effort: a failed caption must not fail the
  // media send (which already went out and bills nothing extra to retry). But a
  // silent swallow means a caption can vanish with no trace — so retry once, and
  // if it still fails, LOG (don't swallow blind) so the drop is diagnosable.
  if (args.caption && args.caption.trim().length > 0) {
    const sendCaption = () =>
      sendSocialText(
        { to: args.to, body: args.caption!, useHumanAgentTag: args.useHumanAgentTag },
        opts,
      );
    try {
      await sendCaption();
    } catch (first) {
      try {
        await sendCaption();
      } catch (second) {
        console.warn(
          JSON.stringify({
            event: "social.caption_dropped",
            severity: "warning",
            channel: opts.label,
            mediaMessageId: messageId,
            error: second instanceof Error ? second.message : String(second),
            firstError: first instanceof Error ? first.message : String(first),
          }),
        );
      }
    }
  }
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
  });
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
  await graphPostJson(url, opts.accessToken, {
    recipient: { id: args.to },
    sender_action: remove ? "unreact" : "react",
    payload: remove
      ? { message_id: args.messageExternalId }
      : { message_id: args.messageExternalId, reaction: args.emoji },
  });
  // Reactions mutate the target message, not a new row — return a synthetic id.
  return { externalId: `reaction:${args.messageExternalId}`, timestamp: new Date() };
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
    return graphGetJson(url, opts.accessToken, { retry: true });
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
// Full wire reference: docs/messenger-calling.md. Meta uses ONE endpoint with
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
  const res = await graphPostJson(url, opts.accessToken, body);
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
  const res = await graphGetJson(url, opts.accessToken, { retry: true });
  const permission = (res.permission ?? {}) as { status?: string; expiration_time?: number };
  const actions = Array.isArray(res.actions) ? (res.actions as Array<{ action_name?: string; can_perform?: boolean }>) : [];
  const can = (name: string) => actions.find((a) => a.action_name === name)?.can_perform === true;
  return {
    hasPermission: permission.status === "has_permission",
    canStartCall: can("start_call"),
    canRequestPermission: can("send_call_permission_request"),
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
  });
  return { messageId: typeof res.message_id === "string" ? res.message_id : "" };
}

/** True when the Page has the Messenger Calling feature enabled. */
export async function socialCallFeatureEnabled(opts: SocialSendTarget): Promise<boolean> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/business_messaging_feature_status`;
  const res = await graphPostJson(url, opts.accessToken, {
    features: [{ feature: "messenger_api_calling" }],
  });
  const data = Array.isArray(res.data) ? (res.data as Array<{ feature?: string; status?: string }>) : [];
  return data.some((d) => d.feature === "messenger_api_calling" && String(d.status).toLowerCase() === "enabled");
}

/**
 * Route consumer-initiated calls to third-party apps (`PARTNERS`) — i.e. THIS
 * inbox — vs Meta's own surfaces (`META`). The Page MUST be on `PARTNERS` (and
 * subscribed to the `calls` webhook) to receive inbound calls here; without it
 * inbound calls only ring Meta Business Inbox. Business-initiated calls work
 * regardless. Idempotent. See docs/messenger-calling.md.
 */
export async function setSocialCallRouting(
  ringTarget: "META" | "PARTNERS",
  opts: SocialSendTarget,
): Promise<void> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messenger_call_settings`;
  await graphPostJson(url, opts.accessToken, { call_routing: { ring_target: ringTarget } });
}

/** Read the Page's current inbound-call routing target. */
export async function getSocialCallRouting(
  opts: SocialSendTarget,
): Promise<"META" | "PARTNERS" | null> {
  const url = `${GRAPH_BASE}/${opts.graphVersion}/${opts.accountId}/messenger_call_settings?fields=call_routing`;
  const res = await graphGetJson(url, opts.accessToken, { retry: true });
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
  });
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
