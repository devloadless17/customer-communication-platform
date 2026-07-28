import type { Channel, MediaKind } from "../types";

/**
 * Per-channel outbound media size caps — the SINGLE source of truth shared by
 * the server (`mediaPolicyForChannel` in apps/api) and the web composer's
 * client-side guard (`reply-box.tsx`). Before this, the composer hardcoded the
 * WhatsApp caps and disagreed with the channel-aware server on Messenger /
 * Instagram threads in both directions (rejecting a valid 20 MB Messenger video,
 * or accepting a 20 MB Instagram image the server rejects).
 *
 * Sizes: WhatsApp per its Cloud-API media docs (5 MB image / 16 MB video·audio /
 * 100 MB document); Messenger a flat 25 MB attachment ceiling; Instagram 8 MB
 * image / 25 MB video·audio·document. Channels without a specific entry fall back
 * to the strictest (WhatsApp) caps via {@link mediaSizeCaps}, keeping a
 * designed-for channel safe until it ships its own numbers.
 */
const MB = 1024 * 1024;

const WHATSAPP_CAPS: Record<MediaKind, number> = {
  image: 5 * MB,
  video: 16 * MB,
  audio: 16 * MB,
  // The ANIMATED sticker ceiling. WhatsApp's sticker cap is split by kind —
  // animated 500 KB, static 100 KB (sticker-messages doc) — and this table is
  // one number per media kind, so it carries the larger of the two as the
  // coarse gate. The precise static-vs-animated check runs server-side after
  // the bytes are read (isAnimatedWebp + WHATSAPP_STATIC_STICKER_MAX_BYTES),
  // where the webp header can actually be sniffed.
  sticker: 500 * 1024,
  document: 100 * MB,
};

/**
 * WhatsApp's STATIC sticker ceiling — 100 KB (sticker-messages doc). Enforced
 * in the send path once the bytes are readable; see the `sticker` entry above
 * for why the coarse per-kind table carries 500 KB instead.
 */
export const WHATSAPP_STATIC_STICKER_MAX_BYTES = 100 * 1024;

export const MEDIA_SIZE_CAPS_BY_CHANNEL: Partial<Record<Channel, Record<MediaKind, number>>> = {
  whatsapp: WHATSAPP_CAPS,
  messenger: { image: 25 * MB, video: 25 * MB, audio: 25 * MB, sticker: 25 * MB, document: 25 * MB },
  instagram: { image: 8 * MB, video: 25 * MB, audio: 25 * MB, sticker: 8 * MB, document: 25 * MB },
  // First-party widget: a flat 25 MB matches the visitor upload cap (both ends
  // are ours). Stickers aren't a thing here.
  webchatwidget: { image: 25 * MB, video: 25 * MB, audio: 25 * MB, sticker: 25 * MB, document: 25 * MB },
};

/** The full per-kind cap table for a channel (WhatsApp caps for designed-for channels). */
export function mediaSizeCaps(channel: Channel): Record<MediaKind, number> {
  return MEDIA_SIZE_CAPS_BY_CHANNEL[channel] ?? WHATSAPP_CAPS;
}

/** The cap for one media kind on one channel. */
export function mediaSizeCap(channel: Channel, kind: MediaKind): number {
  return mediaSizeCaps(channel)[kind];
}

/**
 * Outbound media KINDS each channel accepts. Instagram DM supports documents but
 * ONLY as PDF (Meta's documented File format for IG is `pdf`, 25 MB) — any other
 * document mime is rejected with an opaque #100, so the PER-MIME document gate
 * (`documentMime`, PDF-only for IG) refuses the rest with an actionable error.
 * Size + mime gate WITHIN a kind; this coarser kind-level gate is for channels
 * that reject a whole kind. A channel without an entry accepts every kind.
 */
const ALL_MEDIA_KINDS: ReadonlySet<MediaKind> = new Set<MediaKind>([
  "image",
  "video",
  "audio",
  "sticker",
  "document",
]);

const MEDIA_KINDS_BY_CHANNEL: Partial<Record<Channel, ReadonlySet<MediaKind>>> = {
  // Instagram has NO arbitrary sticker send — Meta ships only the built-in
  // `like_heart` sticker (not an attachment upload), and a `.webp` attachment is
  // rejected with an opaque #100. Exclude `sticker` so the kind-level gate
  // refuses it with an actionable error instead of failing silently at Meta.
  instagram: new Set<MediaKind>(["image", "video", "audio", "document"]),
  // Messenger likewise has no arbitrary sticker send — an outbound sticker must
  // be a first-party catalog `sticker_id` (a different Send API body), not an
  // uploaded attachment. A `.webp` would otherwise be pushed as a plain image
  // (animation lost). Exclude `sticker` so it errors instead of degrading.
  messenger: new Set<MediaKind>(["image", "video", "audio", "document"]),
  // Website widget: text + image/video/audio/document + reply; no stickers.
  webchatwidget: new Set<MediaKind>(["image", "video", "audio", "document"]),
};

/** Whether `channel` can send outbound media of `kind`. */
export function channelSupportsMediaKind(channel: Channel, kind: MediaKind): boolean {
  return (MEDIA_KINDS_BY_CHANNEL[channel] ?? ALL_MEDIA_KINDS).has(kind);
}
