import type { MediaKind } from "@ccp/shared/types";

/**
 * Mime-type helpers + per-kind size caps. The actual byte storage lives behind
 * `lib/blob-storage/` (UploadThing today, swappable later). This module
 * intentionally has no filesystem access.
 *
 * Caps mirror Meta's documented per-type limits. Outbound uploads hit these
 * BEFORE we touch Meta so a 100MB payload doesn't waste a round trip.
 * Inbound is trusted but we cap defensively too — anything over the cap is
 * dropped at the webhook before being sent to the blob provider.
 */

export const MEDIA_SIZE_CAPS: Record<MediaKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  sticker: 500 * 1024,
  document: 100 * 1024 * 1024,
};

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

/** Pick a reasonable extension from a mime type. */
export function extFromMime(mime: string): string {
  const m = mime.toLowerCase().split(";")[0]?.trim() ?? "";
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
