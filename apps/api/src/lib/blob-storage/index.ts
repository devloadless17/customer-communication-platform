import { avatarObjectKey } from "./avatar";
import { r2Provider } from "./r2";
import type { BlobStorageProvider } from "./types";

/**
 * Active blob storage provider. Cloudflare R2 (private bucket, presigned
 * serving) is the only impl. When we add another (S3, Supabase), this is the
 * only place the wiring changes — every call site already talks to
 * BlobStorageProvider.
 *
 * Mirrors how lib/providers/ keeps a single MetaProvider behind a
 * MessagingProvider interface (CLAUDE.md rule #1).
 */
export const blobStorage: BlobStorageProvider = r2Provider;

/**
 * Turn a stored media url into one an EXTERNAL consumer (outbound-webhook
 * receiver, `/v1` API caller) can actually fetch. The bucket is private, so the
 * stored `stableObjectUrl` 403s for anyone outside our process — external
 * surfaces must hand out a presigned URL instead (self-authenticating, no
 * cookie/API-key needed by the fetcher, unlike the same-origin `/api/media`
 * proxy the browser uses). Legacy/foreign urls (old utfs.io, or any non-ours)
 * pass through untouched. 7-day TTL (the SigV4 max) so a webhook payload or a
 * stored API response stays fetchable well beyond immediate consumption.
 *
 * Browser media does NOT use this — it streams same-origin via `/api/media/*`.
 */
const EXTERNAL_MEDIA_TTL_SECONDS = 604_800; // 7 days (SigV4 max)
export async function toExternalMediaUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  if (!blobStorage.isOwnUrl(url)) return url;
  return blobStorage.presignGetUrl(url, { ttlSeconds: EXTERNAL_MEDIA_TTL_SECONDS });
}

/**
 * Presigned, externally-fetchable URL for a user's avatar — for the `/v1` API
 * and outbound webhooks. `User.avatarUrl` stores the INTERNAL same-origin,
 * session-cookie-gated path (`/api/users/:id/avatar?v=…`) the browser uses;
 * handing that to an API-key partner yields a 401/non-resolvable link. When the
 * user has an avatar, presign the R2 object directly (self-authenticating, same
 * 7-day TTL as media). Returns null when the user has no avatar.
 */
export async function toExternalAvatarUrl(
  userId: string,
  hasAvatar: boolean,
): Promise<string | null> {
  if (!hasAvatar) return null;
  return blobStorage.presignGetUrl(avatarObjectKey(userId), {
    ttlSeconds: EXTERNAL_MEDIA_TTL_SECONDS,
  });
}

export type { BlobStorageProvider, UploadInput, UploadResult, MediaNameContext } from "./types";
