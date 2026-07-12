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
 * OUTBOUND document allowlist — Meta's documented supported document types.
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
const INSTAGRAM_AUDIO_MIME: ReadonlySet<string> = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
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
  /** Outbound audio mime allow-list. */
  audioMime: ReadonlySet<string>;
  /** Outbound document mime allow-list. */
  documentMime: ReadonlySet<string>;
}

// Size caps come from the SHARED `mediaSizeCaps` map so the client composer
// guard and this server policy can never disagree per channel.
const WHATSAPP_MEDIA_POLICY: ChannelMediaPolicy = {
  label: "WhatsApp",
  caps: mediaSizeCaps("whatsapp"),
  audioMime: WHATSAPP_AUDIO_MIME,
  documentMime: META_DOCUMENT_MIME_ALLOWED,
};

const MESSENGER_MEDIA_POLICY: ChannelMediaPolicy = {
  label: "Messenger",
  caps: mediaSizeCaps("messenger"),
  audioMime: MESSENGER_AUDIO_MIME,
  documentMime: META_DOCUMENT_MIME_ALLOWED,
};

const INSTAGRAM_MEDIA_POLICY: ChannelMediaPolicy = {
  label: "Instagram",
  caps: mediaSizeCaps("instagram"),
  audioMime: INSTAGRAM_AUDIO_MIME,
  documentMime: META_DOCUMENT_MIME_ALLOWED,
};

const CHANNEL_MEDIA_POLICY: Partial<Record<Channel, ChannelMediaPolicy>> = {
  whatsapp: WHATSAPP_MEDIA_POLICY,
  messenger: MESSENGER_MEDIA_POLICY,
  instagram: INSTAGRAM_MEDIA_POLICY,
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

/** Best-effort kind from a mime type. Falls back to "document". */
export function kindFromMime(mime: string): MediaKind {
  const lower = mime.toLowerCase();
  for (const [prefix, kind] of MEDIA_KIND_BY_MIME_PREFIX) {
    if (lower === prefix || lower.startsWith(prefix)) return kind;
  }
  return "document";
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
