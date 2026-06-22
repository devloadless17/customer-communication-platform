import { UTApi, UTFile } from "uploadthing/server";

/**
 * Avatar upload — deliberately separate from the WhatsApp `MediaKind` blob
 * pipeline. Avatars are public, image-only, lightweight; they don't share
 * Meta's per-kind mime allowlist or the customId-keyed dedup the message
 * media path needs. Keeping a focused helper means a future S3/R2 swap for
 * avatars only doesn't have to fork the BlobStorageProvider interface.
 *
 * Cap: 2 MiB. PNG/JPG/WEBP only — SVG excluded for the same stored-XSS
 * reason called out in [uploadthing.ts](./uploadthing.ts) and GIF excluded
 * because animated avatars distract more than they help in dense lists.
 */

const ALLOWED_AVATAR_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MiB

let utApi: UTApi | null = null;
function getUtApi(): UTApi {
  if (utApi) return utApi;
  if (!process.env.UPLOADTHING_TOKEN) {
    throw new Error("UPLOADTHING_TOKEN env var is required for avatar uploads");
  }
  utApi = new UTApi();
  return utApi;
}

export interface AvatarUploadInput {
  userId: string;
  bytes: Uint8Array;
  mimeType: string;
  /** Used only to derive the file extension in the UploadThing dashboard. */
  originalFilename?: string | null;
}

export interface AvatarUploadResult {
  key: string;
  url: string;
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

  const ext = extFromMime(mime);
  const filename = `avatar-${input.userId}-${Date.now()}.${ext}`;

  const file = new UTFile([input.bytes as Uint8Array<ArrayBuffer>], filename, {
    type: mime,
    customId: `avatar-${input.userId}-${Date.now()}`,
  } as unknown as ConstructorParameters<typeof UTFile>[2]);

  const res = await getUtApi().uploadFiles(file);
  if (res.error || !res.data) {
    const detail = res.error?.message ?? "unknown upload error";
    throw new AvatarUploadError("upload_failed", `uploadthing avatar upload failed: ${detail}`);
  }
  return { key: res.data.key, url: res.data.ufsUrl, sizeBytes: res.data.size };
}

/**
 * Best-effort delete of a previously-uploaded avatar blob, given its URL.
 * Avatars use a timestamped customId, so each re-upload mints a NEW blob and
 * the orphan sweeper deliberately skips the `avatar-` prefix — without this a
 * replaced avatar would leak in shared storage forever. Never throws: blob GC
 * must not block a profile update. No-op for non-UploadThing URLs (the key
 * sits in the `/f/<fileKey>` path segment).
 */
export async function deleteAvatarByUrl(url: string): Promise<void> {
  try {
    const key = url.split("/f/")[1]?.split(/[?#]/)[0];
    if (!key) return;
    await getUtApi().deleteFiles(key);
  } catch {
    // swallow — a leaked blob is far less bad than a failed avatar change
  }
}

function extFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
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
