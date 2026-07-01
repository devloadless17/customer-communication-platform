import {
  DeleteObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import { r2Internal } from "./r2";

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
  const mime = (input.mimeType.split(";")[0] ?? "").trim().toLowerCase();
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
    await r2Internal.client().send(
      new PutObjectCommand({
        Bucket: r2Internal.bucket(),
        Key: key,
        Body: input.bytes,
        ContentType: mime,
      }),
    );
  } catch (err) {
    throw new AvatarUploadError(
      "upload_failed",
      `r2 avatar upload failed: ${err instanceof Error ? err.message : String(err)}`,
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
  try {
    await r2Internal.client().send(
      new DeleteObjectCommand({ Bucket: r2Internal.bucket(), Key: avatarObjectKey(userId) }),
    );
  } catch {
    // swallow — see doc comment
  }
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
