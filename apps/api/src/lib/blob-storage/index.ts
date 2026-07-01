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

export type { BlobStorageProvider, UploadInput, UploadResult, MediaNameContext } from "./types";
