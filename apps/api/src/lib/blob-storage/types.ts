/**
 * Cross-provider blob storage interface. CLAUDE.md rule #1 applied to media:
 * the app talks to this interface, never directly to UploadThing's API shape,
 * so swapping in S3 / R2 / Supabase later only adds a new impl under
 * lib/blob-storage/ — call sites don't move.
 *
 * The "key" returned from upload is the provider's reference for the file
 * (UploadThing fileKey, S3 object key, etc). It's what we hand back to
 * `delete`. The "url" is the public CDN URL we serve to browsers.
 */

import type { MediaKind } from "@ccp/shared/types";

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
  /** Provider key — pass to `delete` later. (UploadThing: fileKey) */
  key: string;
  /** Public CDN URL the browser should load. */
  url: string;
  sizeBytes: number;
}

export interface BlobStorageProvider {
  name: "uploadthing" | (string & {});
  /** Upload bytes; returns the key + public URL. */
  upload(input: UploadInput): Promise<UploadResult>;
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
}
