import { createHash } from "node:crypto";

import { safeFetch } from "@/lib/http/safe-fetch";
import { normalizeMimeType } from "@/lib/media-storage";

import { blobStorage } from "./provider";

/**
 * Avatar upload — deliberately separate from the WhatsApp `MediaKind` blob
 * pipeline. Avatars are image-only, lightweight, and served through the
 * authenticated `GET /api/users/:userId/avatar` route (not directly), so they
 * don't share Meta's per-kind mime allowlist.
 *
 * Key scheme: DETERMINISTIC `avatars/{userId}` (no timestamp/extension). A
 * replace overwrites in place, so there's no orphan to GC on re-upload, and the
 * serve route can presign the key knowing only the userId. The stored
 * ContentType drives what the browser renders regardless of the missing ext.
 * The `avatars/` prefix is how the orphan sweeper tells avatars apart from
 * `media/` objects.
 *
 * Cap: 2 MiB. PNG/JPG/WEBP only — SVG excluded (stored-XSS, same rationale as
 * [mime-guard.ts](./mime-guard.ts)); GIF excluded (animated avatars distract in
 * dense lists).
 */

const ALLOWED_AVATAR_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Deterministic object key for a user's avatar. Exported so the serve route
 *  can stream it directly (bucket is private — no URL is ever exposed). */
export function avatarObjectKey(userId: string): string {
  return `avatars/${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export interface AvatarUploadInput {
  userId: string;
  bytes: Uint8Array;
  mimeType: string;
  /** Unused now (deterministic key ignores the name) — kept for call-site compat. */
  originalFilename?: string | null;
}

export interface AvatarUploadResult {
  key: string;
  sizeBytes: number;
}

export async function uploadAvatar(input: AvatarUploadInput): Promise<AvatarUploadResult> {
  const mime = normalizeMimeType(input.mimeType);
  if (!ALLOWED_AVATAR_MIME.has(mime)) {
    throw new AvatarUploadError(
      "unsupported_mime",
      "Avatar must be a PNG, JPG, or WEBP image.",
    );
  }
  if (input.bytes.length === 0) {
    throw new AvatarUploadError("empty_file", "Avatar file is empty.");
  }
  if (input.bytes.length > MAX_AVATAR_BYTES) {
    throw new AvatarUploadError(
      "too_large",
      `Avatar must be ≤ ${MAX_AVATAR_BYTES / (1024 * 1024)} MiB.`,
    );
  }

  const key = avatarObjectKey(input.userId);
  try {
    // Through the provider (not a raw S3 command) so avatars land wherever the
    // active driver stores everything else — the mime allowlist above is this
    // path's own gate, which is why it uses putObject rather than upload.
    await blobStorage.putObject({ key, bytes: input.bytes, contentType: mime });
  } catch (err) {
    throw new AvatarUploadError(
      "upload_failed",
      `avatar upload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { key, sizeBytes: input.bytes.length };
}

/**
 * Best-effort delete of a user's avatar object. Called when an avatar is
 * cleared (revert to initials). Never throws: a leaked blob is far less bad
 * than a failed profile update. (On REPLACE there's nothing to delete — the
 * deterministic key overwrites in place.)
 */
export async function deleteAvatar(userId: string): Promise<void> {
  // `delete` is contractually non-throwing (a missing key is not an error), so
  // there is nothing left to swallow here.
  await blobStorage.delete(avatarObjectKey(userId));
}

export class AvatarUploadError extends Error {
  constructor(
    public readonly code: "unsupported_mime" | "empty_file" | "too_large" | "upload_failed",
    message: string,
  ) {
    super(message);
    this.name = "AvatarUploadError";
  }
}

// ---------------------------------------------------------------------------
// Contact avatars — captured from a social provider's profile picture.
//
// Meta hands us the customer's `profile_pic` as a SHORT-LIVED signed CDN URL
// (fbcdn / cdninstagram). Hotlinking it directly from the browser works for a
// few days and then 403s — the avatar silently reverts to initials. So we
// download the bytes ONCE at ingest, store them under a deterministic
// `avatars/contact-…` key (the orphan sweeper skips the `avatars/` prefix, so
// there's nothing to GC), and serve them same-origin through
// `GET /api/contacts/:id/avatar` — identical to how user avatars work. The
// stored `Contact.avatarUrl` is that same-origin path, never the Meta URL.
// ---------------------------------------------------------------------------

/** Deterministic object key for a contact's captured avatar. Distinct
 *  `contact-` namespace so it never collides with a user's `avatars/{userId}`. */
export function contactAvatarObjectKey(contactId: string): string {
  return `avatars/contact-${contactId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * Best-effort capture of a remote (Meta CDN) profile picture into R2. Returns
 * the SAME-ORIGIN serving path to store in `Contact.avatarUrl` (with a content
 * hash `?v` cache-buster so a later change busts the browser cache), or `null`
 * on any failure — enrichment is opportunistic and must never throw or block
 * inbound. Non-image responses and oversized payloads are rejected.
 */
export async function captureRemoteContactAvatar(
  contactId: string,
  sourceUrl: string,
  currentAvatarUrl?: string | null,
): Promise<string | null> {
  try {
    // SSRF-SAFE, not raw `fetch` — the same reasoning as `fetchUrlBytes` in
    // media-capture.ts, which handles the sibling URL class: this URL arrives
    // from a webhook/Graph payload whose HMAC is signed with a secret the
    // WORKSPACE ADMIN controls, so a crafted `profile_pic` could name any host
    // reachable from this container. `safeFetch` refuses private/link-local
    // ranges and pins the validated address; redirects OFF because a CDN 302
    // to an internal host re-opens the hole one hop later. This was the one
    // Meta-bound fetch outside the guarded mechanisms (audit 2026-08-11).
    const res = await safeFetch(sourceUrl, {
      timeoutMs: 20_000, // hung-CDN guard
      maxRedirects: 0,
      maxResponseBytes: MAX_AVATAR_BYTES,
    });
    if (!res.ok) return null;

    const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }

    const mime = normalizeMimeType(res.headers.get("content-type") ?? "image/jpeg");
    if (!ALLOWED_AVATAR_MIME.has(mime)) return null;

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null;

    // The `?v` is a content hash — so an unchanged picture yields the SAME
    // serving path. Skip the R2 write (and let the caller skip the DB update)
    // when the bytes match what we already hold: this is what makes re-capture
    // cheap enough to run on demand AND correctly refresh a CHANGED picture.
    const v = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const path = `/api/contacts/${contactId}/avatar?v=${v}`;
    if (currentAvatarUrl === path) return path;

    await blobStorage.putObject({
      key: contactAvatarObjectKey(contactId),
      bytes,
      contentType: mime,
    });
    return path;
  } catch {
    return null; // best-effort — keep the initials fallback on any failure
  }
}
