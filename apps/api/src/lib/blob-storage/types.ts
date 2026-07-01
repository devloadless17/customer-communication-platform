/**
 * Cross-provider blob storage interface. CLAUDE.md rule #1 applied to media:
 * the app talks to this interface, never directly to a vendor's API shape, so
 * swapping the provider only adds a new impl under lib/blob-storage/ — call
 * sites don't move.
 *
 * The "key" returned from upload is the provider's reference for the file (S3 /
 * R2 object key). It's what we hand back to `delete` and `presignGetUrl`, and it
 * is the CANONICAL identifier we persist. The "url" is a STABLE object address
 * for the key — with the R2 impl the bucket is private, so this url is NOT
 * directly fetchable; serving always goes through `presignGetUrl(key)`. Keeping
 * the key canonical means changing domain / serving model later is a code-only
 * change with no DB migration.
 */

import type { Readable } from "node:stream";

import type { MediaKind } from "@ccp/shared/types";

/** Thrown by `getObject` when the key doesn't exist (maps to a 404 at the edge). */
export class BlobObjectNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`blob object not found: ${key}`);
    this.name = "BlobObjectNotFoundError";
  }
}

/** A streamable object read — proxied to the browser same-origin (no redirect). */
export interface BlobObjectStream {
  body: Readable;
  contentType: string;
  /** Present on a full (200) response; absent on some range responses. */
  contentLength?: number;
  /** Present on a 206 partial response. */
  contentRange?: string;
  acceptRanges: string;
  statusCode: 200 | 206;
}

/** Pieces of context used to build a human-readable filename in the provider's dashboard. */
export interface MediaNameContext {
  /** Always set — multi-tenancy is on every row. */
  teamId: string;
  /** Optional friendly slug (team name normalized). Helps when scanning the dashboard. */
  teamSlug?: string;
  /** "in" for inbound (customer → us), "out" for outbound (us → customer). */
  direction: "in" | "out";
  /** Contact's E.164 phone — the WhatsApp identity. */
  contactPhone?: string;
  /** Contact display name, normalized. */
  contactName?: string;
  /** Conversation id (cuid) — short prefix included so we can grep by chat. */
  conversationId?: string;
  /** Provider message id (wamid for Meta) — guarantees uniqueness in the file name. */
  externalId: string;
  /** Original filename from the user / Meta — used as a fallback suffix for documents. */
  originalFilename?: string | null;
}

export interface UploadInput {
  bytes: Uint8Array;
  /** Source mime — provider uses this to set Content-Type on its CDN response. */
  mimeType: string;
  /** Media kind, used by the name builder to add a hint to the filename. */
  kind: MediaKind;
  /** Used to build a meaningful filename in the dashboard. */
  context: MediaNameContext;
}

export interface UploadResult {
  /** Provider key — pass to `delete` / `presignGetUrl` later. (R2/S3 object key) */
  key: string;
  /**
   * Stable object address for the key. With a private bucket this is NOT
   * directly fetchable — it's a durable identifier that (a) doubles as the
   * "media ready" sentinel on the row and (b) lets `isOwnUrl` recover the key.
   * Serve to browsers via `presignGetUrl(key)`, never this url directly.
   */
  url: string;
  sizeBytes: number;
}

export interface BlobStorageProvider {
  name: "r2" | (string & {});
  /** Upload bytes; returns the key + stable object url. */
  upload(input: UploadInput): Promise<UploadResult>;
  /**
   * Stream a stored object back for a same-origin proxy response (how browsers
   * fetch media — we never hand the browser a storage URL). Accepts a key or
   * one of our own stable object URLs. `range` forwards the client's Range
   * header so <video>/<audio> seeking works (returns a 206 with Content-Range).
   * Throws `BlobObjectNotFoundError` when the key is missing.
   */
  getObject(keyOrUrl: string, opts?: { range?: string }): Promise<BlobObjectStream>;
  /**
   * Presign a short-lived GET URL — used ONLY where a third party must fetch
   * the object directly (Meta fetching template-header media). Browser media
   * goes through `getObject` instead. Accepts a key or one of our own stable
   * object URLs (isOwnUrl-gated) so call sites that persisted only a url
   * (header media threaded through workflow/broadcast config) can presign fresh
   * at send time without re-plumbing a key field.
   */
  presignGetUrl(
    keyOrUrl: string,
    opts?: { ttlSeconds?: number; downloadFilename?: string },
  ): Promise<string>;
  /** Delete one or many keys. Idempotent — missing keys must NOT throw. */
  delete(keys: string | string[]): Promise<void>;
  /**
   * Fetch the bytes back (used by the forward path so we can re-upload to Meta).
   * Implementations can short-circuit by GET'ing the public URL.
   */
  fetch(keyOrUrl: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /**
   * Host allowlist gate. Returns true iff `url` points at this provider's CDN.
   * Used to (a) prevent SSRF when `fetch()` is called with a URL string and
   * (b) prevent an open-redirect from `/api/media/[id]` if `mediaUrl` ever
   * came from somewhere untrusted. Keep this conservative — accept only the
   * exact host shapes the provider actually emits.
   */
  isOwnUrl(url: string): boolean;
  /**
   * Enumerate stored blobs in pages. Used by the blob-orphan sweeper to
   * cross-check provider state against the DB and reclaim leaked uploads
   * (e.g. a contact delete whose blobStorage.delete() got swallowed by a
   * transient provider outage). `uploadedAt` is unix-ms so the sweeper can
   * skip recent uploads and avoid racing with in-flight sends.
   *
   * Pagination is cursor-based (S3/R2 ListObjectsV2 continuation token) — pass
   * `cursor` from the previous page's `nextCursor`; a nullish `nextCursor`
   * means the listing is exhausted.
   *
   * Returns `null` when the provider has no list capability — sweeper treats
   * that as "no orphan cleanup possible" rather than throwing.
   */
  listKeys?(opts: {
    limit: number;
    cursor?: string;
  }): Promise<{
    // Blob categories NOT cross-checked against a `mediaKey` column (avatars,
    // which persist only a URL) are told apart by KEY PREFIX (`avatars/`), so
    // no per-object customId is needed anymore.
    keys: ReadonlyArray<{ key: string; uploadedAt: number }>;
    nextCursor?: string;
  }>;
}
