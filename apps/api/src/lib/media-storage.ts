import type { Channel, MediaKind } from "@ccp/shared/types";
import { mediaSizeCaps } from "@ccp/shared/providers/media-caps";

/**
 * Mime-type helpers + per-kind size caps. The actual byte storage lives behind
 * `lib/blob-storage/` (Cloudflare R2 today, swappable later). This module
 * intentionally has no filesystem access.
 *
 * Caps mirror Meta's documented per-type limits. Outbound uploads hit these
 * BEFORE we touch Meta so a 100MB payload doesn't waste a round trip.
 * Inbound is trusted but we cap defensively too — anything over the cap is
 * dropped at the webhook before being sent to the blob provider.
 *
 * The bare `MEDIA_SIZE_CAPS` below are WhatsApp's (the historical default kept
 * for channel-agnostic callers — team-chat attachments, the inbound-media
 * sweeper). Anything on a Meta customer channel should read the per-channel
 * `mediaPolicyForChannel(channel)` instead: Messenger and Instagram accept
 * larger files (and a different audio set) than WhatsApp, so reusing WhatsApp's
 * caps wrongly rejects valid social media with a "WhatsApp doesn't accept…"
 * error on a non-WhatsApp thread.
 */

// The historical WhatsApp default, kept as a named export for existing callers.
// Sourced from the shared per-channel map so there is one source of truth.
export const MEDIA_SIZE_CAPS: Record<MediaKind, number> = mediaSizeCaps("whatsapp");

/**
 * OUTBOUND document allowlist.
 *
 * Meta's documented set is: pdf, doc, docx, xls, xlsx, ppt, pptx, txt. `text/csv`
 * is ours on top of that — it is not in Meta's table, but CSV is common in
 * business messaging and Meta's list has not proven exhaustive in practice. If a
 * CSV send ever starts failing with a media-type error, this is the line that
 * explains why it was ever attempted.
 * `kindFromMime` falls back to "document" for ANY unrecognized mime, so without
 * this gate an agent could upload an arbitrary file (executable, html) and have
 * it stored in shared blob storage before Meta's send-side rejection. Enforced
 * only on the outbound send path; inbound (trusted Meta source) keeps the
 * forgiving fallback. Image/video/audio/sticker have their own per-kind checks.
 */
export const META_DOCUMENT_MIME_ALLOWED: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
]);

/**
 * Per-channel outbound audio allow-list. WhatsApp requires OGG/Opus to *deliver*
 * voice notes and rejects `audio/webm`; Instagram is the inverse — it rejects
 * OGG (`#100 attachment format is not supported`) and wants AAC/M4A. Messenger
 * is the most permissive. Voice-recorder transcoding (messages.service) targets
 * the right container per channel from `mediaSendByUrl`; this set is the final
 * accept gate.
 */
const WHATSAPP_AUDIO_MIME: ReadonlySet<string> = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/amr",
  "audio/ogg",
]);
const MESSENGER_AUDIO_MIME: ReadonlySet<string> = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/amr",
  "audio/ogg",
  "audio/wav",
]);
// Instagram's documented set is EXACTLY aac / m4a / wav / mp4 — NO mp3
// (`audio/mpeg`). An mp3 sent by URL is rejected by Meta with an opaque
// `(#100) attachment format is not supported` (subcode 2534080), so gate it out
// here with an actionable error instead. `audio/x-m4a` is the alt mime some
// browsers/OSes attach to a `.m4a` pick.
const INSTAGRAM_AUDIO_MIME: ReadonlySet<string> = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
]);

/**
 * Per-channel outbound media policy — the single source of truth for size caps
 * and mime allow-lists. Meta enforces different limits per surface, so callers
 * on a Meta customer channel pass the conversation's channel here instead of
 * reading the bare WhatsApp `MEDIA_SIZE_CAPS`.
 *
 * Sizes: WhatsApp per its Cloud-API media docs (5 MB image / 16 MB video·audio /
 * 100 MB document); Messenger a flat 25 MB attachment ceiling; Instagram 8 MB
 * image / 25 MB video·audio·document.
 */
export interface ChannelMediaPolicy {
  /** Human-facing channel name for error copy. */
  label: string;
  caps: Record<MediaKind, number>;
  /** Outbound image mime allow-list. Instagram accepts ONLY png/jpeg; a gif or
   *  webp image reaches Meta and is rejected with an opaque #100 without this. */
  imageMime: ReadonlySet<string>;
  /** Outbound audio mime allow-list. */
  audioMime: ReadonlySet<string>;
  /** Outbound video mime allow-list. Instagram restricts video containers to
   *  mp4/ogg/avi/mov/webm; an out-of-spec container reaches Meta and fails with
   *  an opaque #100 without this gate. */
  videoMime: ReadonlySet<string>;
  /** Outbound document mime allow-list. */
  documentMime: ReadonlySet<string>;
  /**
   * Classify `image/webp` as a plain `image` instead of a `sticker`.
   *
   * The global mapping routes webp → sticker because on the META channels that is
   * what a webp USUALLY is (WhatsApp stickers are webp, and WhatsApp image messages
   * accept only JPEG/PNG). But webp is also Chrome's default "Save image as" format,
   * so on a channel with no sticker concept that mapping misfires on ordinary
   * photos: the kind gate rejects the send outright, and an inbound one renders as
   * a file row instead of a picture.
   *
   * Set this ONLY for first-party channels where we own the renderer and a webp is
   * just an image (browsers display it natively). Do NOT set it for Messenger —
   * that exclusion is deliberate (an outbound Meta sticker needs a catalog
   * `sticker_id`, so failing loudly beats silently sending a still frame).
   */
  classifyWebpAsImage?: boolean;
}

// Messenger accepts the common web image set; Instagram + WhatsApp are png/jpeg
// only (WhatsApp image messages support ONLY JPEG/PNG per the doc — a webp is
// routed to the sticker kind, and a gif-as-image would be rejected by Meta).
const PERMISSIVE_IMAGE_MIME: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const INSTAGRAM_IMAGE_MIME: ReadonlySet<string> = new Set(["image/jpeg", "image/png"]);
const WHATSAPP_IMAGE_MIME: ReadonlySet<string> = new Set(["image/jpeg", "image/png"]);

// Video containers. Messenger takes the common web set; Instagram's documented
// formats are mp4/ogg/avi/mov/webm; WhatsApp accepts ONLY mp4 + 3gpp (a common
// iPhone `.mov`/`video/quicktime` is rejected by Meta, so gate it up front with
// an actionable error instead of an opaque #100 late in the send).
const PERMISSIVE_VIDEO_MIME: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/ogg",
  "video/3gpp",
]);
const INSTAGRAM_VIDEO_MIME: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/ogg",
  "video/x-msvideo",
  "video/quicktime",
  "video/webm",
]);
const WHATSAPP_VIDEO_MIME: ReadonlySet<string> = new Set(["video/mp4", "video/3gpp"]);

// Size caps come from the SHARED `mediaSizeCaps` map so the client composer
// guard and this server policy can never disagree per channel.
const WHATSAPP_MEDIA_POLICY: ChannelMediaPolicy = {
  label: "WhatsApp",
  caps: mediaSizeCaps("whatsapp"),
  imageMime: WHATSAPP_IMAGE_MIME,
  audioMime: WHATSAPP_AUDIO_MIME,
  videoMime: WHATSAPP_VIDEO_MIME,
  documentMime: META_DOCUMENT_MIME_ALLOWED,
};

const MESSENGER_MEDIA_POLICY: ChannelMediaPolicy = {
  label: "Messenger",
  caps: mediaSizeCaps("messenger"),
  imageMime: PERMISSIVE_IMAGE_MIME,
  audioMime: MESSENGER_AUDIO_MIME,
  videoMime: PERMISSIVE_VIDEO_MIME,
  documentMime: META_DOCUMENT_MIME_ALLOWED,
};

// Instagram's ONLY documented File format is PDF (25 MB); every other document
// mime is rejected by Meta with an opaque #100, so gate IG documents to PDF.
const INSTAGRAM_DOCUMENT_MIME: ReadonlySet<string> = new Set(["application/pdf"]);

const INSTAGRAM_MEDIA_POLICY: ChannelMediaPolicy = {
  label: "Instagram",
  caps: mediaSizeCaps("instagram"),
  imageMime: INSTAGRAM_IMAGE_MIME,
  audioMime: INSTAGRAM_AUDIO_MIME,
  videoMime: INSTAGRAM_VIDEO_MIME,
  documentMime: INSTAGRAM_DOCUMENT_MIME,
};

// Website widget: first-party, both ends are ours, so it's permissive — the
// browser renders any common web format. Caps come from the shared 25 MB
// webchatwidget entry (media-caps.ts), NOT WhatsApp's 5 MB. Without this a media
// reply to a widget visitor would fall back to WHATSAPP_MEDIA_POLICY and reject
// a valid webp/gif/mov or a 20 MB video with a misleading "WhatsApp" error.
const WEBCHATWIDGET_AUDIO_MIME: ReadonlySet<string> = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/aac",
  "audio/x-m4a",
]);
const WEBCHATWIDGET_MEDIA_POLICY: ChannelMediaPolicy = {
  label: "Website widget",
  caps: mediaSizeCaps("webchatwidget"),
  imageMime: PERMISSIVE_IMAGE_MIME,
  audioMime: WEBCHATWIDGET_AUDIO_MIME,
  videoMime: PERMISSIVE_VIDEO_MIME,
  documentMime: META_DOCUMENT_MIME_ALLOWED,
  // First-party channel: we render it ourselves and every browser paints webp, so
  // a .webp here is an ordinary photo, not a sticker. Without this an agent
  // attaching one got "Website widget doesn't support sending stickers" (the kind
  // set at media-caps.ts has no `sticker`), and a visitor's webp rendered as a 📄.
  classifyWebpAsImage: true,
};

const CHANNEL_MEDIA_POLICY: Partial<Record<Channel, ChannelMediaPolicy>> = {
  whatsapp: WHATSAPP_MEDIA_POLICY,
  messenger: MESSENGER_MEDIA_POLICY,
  instagram: INSTAGRAM_MEDIA_POLICY,
  webchatwidget: WEBCHATWIDGET_MEDIA_POLICY,
};

/**
 * Outbound/inbound media policy for a channel. Falls back to the WhatsApp
 * policy for channels without a specific one (keeps designed-for channels safe
 * by using the strictest caps until they ship their own).
 */
export function mediaPolicyForChannel(channel: Channel): ChannelMediaPolicy {
  return CHANNEL_MEDIA_POLICY[channel] ?? WHATSAPP_MEDIA_POLICY;
}

export const MEDIA_KIND_BY_MIME_PREFIX: Array<[string, MediaKind]> = [
  ["image/webp", "sticker"], // before image/* so .webp routes to sticker
  ["image/", "image"],
  ["video/", "video"],
  ["audio/", "audio"],
];

/**
 * Best-effort kind from a mime type. Falls back to "document".
 *
 * `channel` is OPTIONAL and only changes one thing: on a channel whose policy sets
 * `classifyWebpAsImage`, `image/webp` resolves to `image` rather than `sticker`
 * (see that flag for why). Omit it — as the channel-agnostic callers do
 * (`reconcileInboundMediaMime`, team chat) — to get the global mapping unchanged.
 */
export function kindFromMime(mime: string, channel?: Channel): MediaKind {
  const lower = mime.toLowerCase();
  if (
    lower === "image/webp" &&
    channel &&
    mediaPolicyForChannel(channel).classifyWebpAsImage
  ) {
    return "image";
  }
  for (const [prefix, kind] of MEDIA_KIND_BY_MIME_PREFIX) {
    if (lower === prefix || lower.startsWith(prefix)) return kind;
  }
  return "document";
}

/**
 * Is this webp ANIMATED? Header sniff only — no decoder. WhatsApp's sticker
 * size cap is split by kind (animated 500 KB, static 100 KB — sticker-messages
 * doc), and the mime can't tell them apart, so the send path reads the answer
 * off the container: a RIFF/WEBP whose first chunk is `VP8X` carries a flags
 * byte at offset 20 where bit 1 (0x02) is the Animation flag. Plain `VP8 ` /
 * `VP8L` first chunks (simple lossy/lossless) are static by definition.
 * Non-webp / truncated input returns false — the caller's static cap is the
 * conservative outcome, and a non-webp "sticker" was already rejected by the
 * mime gate anyway.
 */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 21) return false;
  const ascii = (off: number, len: number) =>
    String.fromCharCode(...bytes.subarray(off, off + len));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return false;
  if (ascii(12, 4) !== "VP8X") return false;
  return (bytes[20]! & 0x02) !== 0;
}

/**
 * The single canonical mime normalizer: strip codec/charset params
 * (`audio/ogg;codecs=opus` → `audio/ogg`), trim, lowercase, and fall back to
 * `application/octet-stream` for empty/blank input. Every site that used to
 * hand-roll `split(";")[0].trim().toLowerCase()` (the Meta send path,
 * `mime-guard`, `avatar`, and `extFromMime` below) routes through here so the
 * parse can't drift between the security gates and the storage layer.
 */
export function normalizeMimeType(raw?: string): string {
  return (
    (raw || "application/octet-stream").split(";")[0]?.trim().toLowerCase() ||
    "application/octet-stream"
  );
}

/** Pick a reasonable extension from a mime type. */
export function extFromMime(mime: string): string {
  const m = normalizeMimeType(mime);
  switch (m) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    case "video/3gpp":
      return "3gp";
    case "audio/aac":
      return "aac";
    case "audio/mp4":
      return "m4a";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/amr":
      return "amr";
    case "audio/ogg":
      return "ogg";
    case "audio/opus":
      return "opus";
    case "audio/wav":
      return "wav";
    case "application/pdf":
      return "pdf";
    case "application/msword":
      return "doc";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
    case "application/vnd.ms-excel":
      return "xls";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return "xlsx";
    case "text/plain":
      return "txt";
    default: {
      const slash = m.indexOf("/");
      if (slash > -1 && slash < m.length - 1) return m.slice(slash + 1).slice(0, 8);
      return "bin";
    }
  }
}
