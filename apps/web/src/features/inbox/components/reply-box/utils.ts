import type { MediaKind } from "@ccp/shared/types";

// Cheap unique id; doesn't need crypto-strength because it's only matched
// against ourselves within a few seconds.
export function newClientTempId(): string {
  return `tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// Inline kind detection — lib/media-storage.ts is server-only and we need
// the kind on the client to render the optimistic bubble. The server makes
// the authoritative decision; this is just a best-guess for paint.
export function kindFromMimeClient(mime: string): MediaKind {
  const lower = (mime || "").toLowerCase();
  if (lower === "image/webp") return "sticker";
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/")) return "video";
  if (lower.startsWith("audio/")) return "audio";
  return "document";
}

export async function safeReadError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: string; detail?: string };
    if (json.detail) return `${json.error ?? "error"}: ${json.detail}`;
    return json.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Inspect the textarea contents around the cursor and figure out whether
 * the user is in the middle of typing a `/<word>` snippet trigger.
 *
 * Rules:
 *   - The slash must sit at the start of the text or follow whitespace /
 *     newline / tab. We don't treat slashes inside other tokens (e.g.
 *     URLs, file paths) as triggers — too noisy.
 *   - Only `[a-z0-9_]` after the slash. The first character that isn't
 *     one of those (space, punctuation, etc.) closes the popup. The
 *     query is normalized to lowercase so case-insensitive lookups work.
 *
 * Returns the `[start, end]` range to splice when the user picks a snippet
 * — `start` points at the `/`, `end` is the cursor.
 */
export function detectSlashQuery(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  // Walk backwards from the cursor until we hit whitespace or a boundary.
  let i = cursor;
  while (i > 0) {
    const c = text[i - 1];
    if (c === " " || c === "\n" || c === "\t") break;
    i -= 1;
  }
  if (text[i] !== "/") return null;
  const q = text.slice(i + 1, cursor);
  if (!/^[a-z0-9_]*$/i.test(q)) return null;
  return { start: i, end: cursor, query: q.toLowerCase() };
}
