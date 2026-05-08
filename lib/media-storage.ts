import "server-only";

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MediaKind } from "@/lib/types";

/**
 * On-disk media storage. One directory per team, one file per message.
 *
 *   <STORAGE_ROOT>/<teamId>/<key>.<ext>
 *
 * `key` is typically the message externalId (wamid for Meta) — unique per
 * message and stable across re-ingest. We only ever serve files through
 * /api/media/<messageId> so the on-disk path never escapes the server.
 *
 * STORAGE_ROOT is `./storage` by default — make sure docker-compose mounts
 * this as a named volume so media survives container restarts.
 */

const STORAGE_ROOT = process.env.MEDIA_STORAGE_PATH ?? path.resolve("./storage");

// Hard caps mirror Meta's documented per-type limits. Outbound uploads hit
// these on our side BEFORE we touch Meta so a 100MB payload doesn't waste a
// round trip. Inbound is trusted but we cap defensively too.
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

/** Filesystem-safe id sanitiser. */
function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
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

export interface SavedMedia {
  /** Absolute path on disk. */
  path: string;
  sizeBytes: number;
}

export async function saveMedia(
  teamId: string,
  key: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<SavedMedia> {
  const teamDir = path.join(STORAGE_ROOT, safeId(teamId));
  await mkdir(teamDir, { recursive: true });
  const ext = extFromMime(mimeType);
  const filePath = path.join(teamDir, `${safeId(key)}.${ext}`);
  await writeFile(filePath, bytes);
  const s = await stat(filePath);
  return { path: filePath, sizeBytes: s.size };
}

export async function readMedia(absolutePath: string): Promise<Buffer> {
  // Path-traversal defence: refuse anything that isn't inside STORAGE_ROOT.
  // STORAGE_ROOT is what we control; the message row stores the path we wrote
  // ourselves, but a defective row (or future column-injection bug) shouldn't
  // grant arbitrary file reads.
  const resolved = path.resolve(absolutePath);
  const root = path.resolve(STORAGE_ROOT);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("media path outside storage root");
  }
  if (!existsSync(resolved)) {
    throw new Error("media file missing");
  }
  return readFile(resolved);
}

export async function deleteMedia(absolutePath: string): Promise<void> {
  try {
    await unlink(absolutePath);
  } catch {
    // already gone — fine
  }
}
