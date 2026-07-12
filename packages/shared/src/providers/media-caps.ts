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
  sticker: 500 * 1024,
  document: 100 * MB,
};

export const MEDIA_SIZE_CAPS_BY_CHANNEL: Partial<Record<Channel, Record<MediaKind, number>>> = {
  whatsapp: WHATSAPP_CAPS,
  messenger: { image: 25 * MB, video: 25 * MB, audio: 25 * MB, sticker: 25 * MB, document: 25 * MB },
  instagram: { image: 8 * MB, video: 25 * MB, audio: 25 * MB, sticker: 8 * MB, document: 25 * MB },
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
 * Outbound media KINDS each channel accepts. Instagram DM has no file/document
 * send support — Meta rejects a `type:"file"` attachment with an opaque #100, and
 * the by-URL send path can't even carry a filename — so a document attached on an
 * IG thread must be refused up front (with an actionable error) instead of shipped
 * as a nameless "file" that fails at Meta. Size + mime still gate WITHIN a kind;
 * this is the coarser kind-level gate that size/mime alone couldn't express.
 * A channel without an entry accepts every kind.
 */
const ALL_MEDIA_KINDS: ReadonlySet<MediaKind> = new Set<MediaKind>([
  "image",
  "video",
  "audio",
  "sticker",
  "document",
]);

const MEDIA_KINDS_BY_CHANNEL: Partial<Record<Channel, ReadonlySet<MediaKind>>> = {
  instagram: new Set<MediaKind>(["image", "video", "audio", "sticker"]),
};

/** Whether `channel` can send outbound media of `kind`. */
export function channelSupportsMediaKind(channel: Channel, kind: MediaKind): boolean {
  return (MEDIA_KINDS_BY_CHANNEL[channel] ?? ALL_MEDIA_KINDS).has(kind);
}
