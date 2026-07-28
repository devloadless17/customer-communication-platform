import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";

import { extFromMime } from "@/lib/media-storage";

import {
  assertAllowedMime,
  assertSignatureMatches,
} from "./mime-guard";
import {
  BlobObjectNotFoundError,
  type BlobStorageProvider,
  type UploadInput,
  type UploadResult,
} from "./types";

/**
 * Cloudflare R2 implementation of BlobStorageProvider (S3-compatible API).
 *
 * The bucket is PRIVATE. We store the object KEY as the canonical reference on
 * the row; the "url" we return is a stable, non-fetchable object address
 * (`https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`) that doubles as
 * the "media ready" sentinel and lets `isOwnUrl` recover the key. Browsers are
 * served short-lived presigned GET URLs via `presignGetUrl(key)` — no public
 * URL ever leaks, and changing domain / serving model later is code-only.
 *
 * The S3Client is constructed lazily so a missing-cred error surfaces on first
 * USE (someone sends media), not on module load — keeps the app bootable in
 * environments where media isn't configured yet.
 */

const UPLOAD_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_FETCH_BYTES = 100 * 1024 * 1024; // matches the outbound document cap

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set — required for R2 blob storage. Add it to .env (see .env.example).`,
    );
  }
  return v;
}

let client: S3Client | null = null;
let cachedBucket: string | null = null;
let cachedAccount: string | null = null;

function getClient(): S3Client {
  if (client) return client;
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  cachedAccount = accountId;
  client = new S3Client({
    region: "auto", // required by the SDK, ignored by R2
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // Path-style ({endpoint}/{bucket}/{key}) so EVERY url this module produces —
    // stableObjectUrl AND presigned GETs — shares the exact host shape
    // `isOwnUrl`/`keyFromOwnUrl` expect. Without it the SDK emits virtual-hosted
    // presigned URLs ({bucket}.{account}.r2…) that `isOwnUrl` would reject if
    // ever fed back through the module. R2 supports path-style.
    forcePathStyle: true,
  });
  return client;
}

function bucket(): string {
  if (cachedBucket) return cachedBucket;
  cachedBucket = requireEnv("R2_BUCKET");
  return cachedBucket;
}

function account(): string {
  if (cachedAccount) return cachedAccount;
  cachedAccount = requireEnv("R2_ACCOUNT_ID");
  return cachedAccount;
}

function presignTtlSeconds(override?: number): number {
  if (override && Number.isFinite(override) && override > 0) return override;
  const raw = Number.parseInt(process.env.R2_PRESIGN_TTL_SECONDS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0 && raw <= 604_800) return raw;
  return 3600;
}

/** Stable, non-fetchable object address for a key. */
function stableObjectUrl(key: string): string {
  return `https://${account()}.r2.cloudflarestorage.com/${bucket()}/${key}`;
}

/**
 * Recover the object key from one of our own stable object URLs. Returns null
 * for anything that isn't ours (SSRF/open-redirect guard rides on this — see
 * `isOwnUrl`). Our keys are URL-safe (alnum + `/ - _ .`), so no decoding needed.
 */
function keyFromOwnUrl(url: string): string | null {
  if (!r2Provider.isOwnUrl(url)) return null;
  try {
    const { pathname } = new URL(url);
    const prefix = `/${bucket()}/`;
    if (!pathname.startsWith(prefix)) return null;
    const key = pathname.slice(prefix.length);
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export const r2Provider: BlobStorageProvider = {
  name: "r2",

  async upload(input: UploadInput): Promise<UploadResult> {
    // Mime allowlist + magic-byte sniff — the load-bearing stored-XSS defense.
    // `kind` is set by the caller from Meta's categorization, not the sender's
    // claim, so it's trustworthy here. See mime-guard.ts.
    assertAllowedMime(input.kind, input.mimeType);
    assertSignatureMatches(input.bytes, input.mimeType);

    const key = buildKey(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      await getClient().send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: key,
          Body: input.bytes,
          ContentType: input.mimeType,
          // Human-readable label for dashboard debugging (team / direction /
          // contact / convo / wamid) — stored as metadata, not in the key.
          Metadata: {
            ccpname: buildReadableName(input),
            externalid: sanitizeMeta(input.context.externalId),
          },
        }),
        { abortSignal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }
    return { key, url: stableObjectUrl(key), sizeBytes: input.bytes.length };
  },

  async putObject(input): Promise<UploadResult> {
    // No magic-byte sniff here (unlike `upload`): these are first-party
    // artifacts (AI knowledge docs, generated TTS audio) whose type the caller
    // has already validated. The key is caller-supplied and MUST be
    // tenant-prefixed. Same private bucket, same timeout budget as `upload`.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      await getClient().send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: input.key,
          Body: input.bytes,
          ContentType: input.contentType,
        }),
        { abortSignal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }
    return {
      key: input.key,
      url: stableObjectUrl(input.key),
      sizeBytes: input.bytes.length,
    };
  },

  async putObjectFromFile(input): Promise<UploadResult> {
    // Body is a read stream, so the file never lands in heap. S3/R2 needs an
    // explicit ContentLength for a stream body (it can't seek to measure one),
    // and without it the SDK falls back to buffering the whole stream to
    // compute the length — silently undoing the streaming. stat first.
    const { size } = await stat(input.path);
    const controller = new AbortController();
    // Scale the timeout with size: the flat 60s budget that suits a photo is
    // not enough for a 25 MB export on a modest uplink, and a timeout here
    // fails a job that did all its work. 60s floor + 1 minute per 10 MB.
    const timeoutMs = UPLOAD_TIMEOUT_MS + Math.ceil(size / (10 * 1024 * 1024)) * 60_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await getClient().send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: input.key,
          Body: createReadStream(input.path),
          ContentLength: size,
          ContentType: input.contentType,
        }),
        { abortSignal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }
    return { key: input.key, url: stableObjectUrl(input.key), sizeBytes: size };
  },

  async getObject(keyOrUrl, opts): Promise<import("./types").BlobObjectStream> {
    let key: string | null = keyOrUrl;
    if (keyOrUrl.startsWith("http")) {
      key = keyFromOwnUrl(keyOrUrl);
      if (!key) throw new Error("r2 getObject: refusing non-r2 url");
    }
    try {
      const res = await getClient().send(
        new GetObjectCommand({
          Bucket: bucket(),
          Key: key,
          ...(opts?.range ? { Range: opts.range } : {}),
        }),
      );
      if (!res.Body) throw new BlobObjectNotFoundError(key);
      return {
        // In the Node runtime the SDK Body is a Node Readable.
        body: res.Body as Readable,
        contentType: res.ContentType ?? "application/octet-stream",
        contentLength:
          typeof res.ContentLength === "number" ? res.ContentLength : undefined,
        contentRange: res.ContentRange,
        acceptRanges: res.AcceptRanges ?? "bytes",
        statusCode: res.ContentRange ? 206 : 200,
      };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
        throw new BlobObjectNotFoundError(key);
      }
      throw err;
    }
  },

  async presignGetUrl(keyOrUrl, opts): Promise<string> {
    let key: string | null = keyOrUrl;
    if (keyOrUrl.startsWith("http")) {
      key = keyFromOwnUrl(keyOrUrl);
      if (!key) throw new Error("r2 presign: refusing non-r2 url");
    }
    const command = new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ...(opts?.downloadFilename
        ? {
            // Strip quote/backslash/CR/LF too (sanitizeMeta only drops
            // non-ASCII) so a filename with a `"` can't break out of the quoted
            // Content-Disposition value in the signed URL.
            ResponseContentDisposition: `attachment; filename="${sanitizeMeta(
              opts.downloadFilename,
            ).replace(/["\\\r\n]/g, "_")}"`,
          }
        : {}),
    });
    return getSignedUrl(getClient(), command, {
      expiresIn: presignTtlSeconds(opts?.ttlSeconds),
    });
  },

  async delete(keys: string | string[]): Promise<void> {
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    if (list.length === 0) return;
    try {
      // DeleteObjects caps at 1000 keys/request. Batch defensively.
      for (let i = 0; i < list.length; i += 1000) {
        const batch = list.slice(i, i + 1000);
        await getClient().send(
          new DeleteObjectsCommand({
            Bucket: bucket(),
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    } catch (err) {
      // Same contract as the old disk deleteMedia: never throw. A missing or
      // already-deleted key must not block the surrounding domain delete.
      // Structured warning so a burst (R2 outage) is greppable; the orphan
      // sweeper reconciles eventually.
      console.warn(
        JSON.stringify({
          event: "blob.delete_failed",
          severity: "warn",
          provider: "r2",
          keyCount: list.length,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  },

  async fetch(keyOrUrl: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    let key: string | null = keyOrUrl;
    if (keyOrUrl.startsWith("http")) {
      // SSRF guard: only fetch objects that are ours.
      key = keyFromOwnUrl(keyOrUrl);
      if (!key) throw new Error("r2 fetch: refusing non-r2 url");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await getClient().send(
        new GetObjectCommand({ Bucket: bucket(), Key: key }),
        { abortSignal: controller.signal },
      );
      if (typeof res.ContentLength === "number" && res.ContentLength > MAX_FETCH_BYTES) {
        throw new Error(
          `r2 fetch: content-length ${res.ContentLength} exceeds cap ${MAX_FETCH_BYTES}`,
        );
      }
      if (!res.Body) throw new Error(`r2 fetch: no body for ${key}`);
      // AWS SDK v3 mixes `transformToByteArray` onto the Node stream Body.
      const bytes = await res.Body.transformToByteArray();
      if (bytes.length > MAX_FETCH_BYTES) {
        throw new Error(`r2 fetch: body exceeded cap ${MAX_FETCH_BYTES}`);
      }
      return {
        bytes,
        mimeType: res.ContentType ?? "application/octet-stream",
      };
    } finally {
      clearTimeout(timer);
    }
  },

  isOwnUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      const host = parsed.hostname.toLowerCase();
      // R2 S3 endpoint host is <accountid>.r2.cloudflarestorage.com. Match the
      // exact configured account host; presigned URLs live on the same host.
      return host === `${account()}.r2.cloudflarestorage.com`;
    } catch {
      return false;
    }
  },

  keyFromUrl(url: string): string | null {
    return keyFromOwnUrl(url);
  },

  async listKeys({ limit, cursor, prefix }) {
    const res = await getClient().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        MaxKeys: limit,
        ...(cursor ? { ContinuationToken: cursor } : {}),
        ...(prefix ? { Prefix: prefix } : {}),
      }),
    );
    const keys = (res.Contents ?? [])
      .filter((o) => o.Key)
      .map((o) => ({
        key: o.Key as string,
        uploadedAt: o.LastModified ? o.LastModified.getTime() : 0,
      }));
    return {
      keys,
      ...(res.IsTruncated && res.NextContinuationToken
        ? { nextCursor: res.NextContinuationToken }
        : {}),
    };
  },
};

/**
 * Deterministic, team-prefixed object key. Deterministic on (externalId, kind)
 * so a re-upload of the same logical object overwrites in place — free
 * idempotency, no orphan on retry (replaces the old customId/409 recovery).
 *
 * Shape: `media/{workspaceId}/{yyyy}/{mm}/{externalShort}-{kind}.{ext}`
 * The `media/` prefix + per-team segment give multi-tenant isolation and let
 * the orphan sweeper tell media apart from `avatars/` by prefix.
 *
 * Exported because the key scheme is storage-agnostic — the local driver
 * (local.ts) must produce the SAME keys, or a suite that runs on it would be
 * exercising a different namespace than production.
 */
export function buildKey(input: UploadInput): string {
  const { context } = input;
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const team = sanitizeSeg(context.workspaceId);
  const externalShort = sanitizeSeg(context.externalId).slice(-48) || "x";
  const ext = sanitizeExt(documentExtension(input) ?? extFromMime(input.mimeType));
  return `media/${team}/${yyyy}/${mm}/${externalShort}-${input.kind}.${ext}`;
}

/**
 * Human-readable label stored as object metadata (not the key) so the R2
 * dashboard is greppable by team / direction / customer / chat / wamid.
 */
function buildReadableName(input: UploadInput): string {
  const { context, mimeType } = input;
  const date = new Date().toISOString().slice(0, 10);
  const team = slug(context.teamSlug ?? context.workspaceId, 16);
  const phone = context.contactPhone ?? "unknown";
  const contact = slug(context.contactName ?? "anon", 20);
  const convo = (context.conversationId ?? "noconvo").slice(-8);
  const ext = sanitizeExt(documentExtension(input) ?? extFromMime(mimeType));
  const extShort = context.externalId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-12);
  return sanitizeMeta(
    `${date}_${context.direction}_${team}_${phone}_${contact}_${convo}_${extShort}.${ext}`,
  );
}

/** For documents, prefer the original extension over guessing from mime. */
function documentExtension(input: UploadInput): string | null {
  if (input.kind !== "document") return null;
  const orig = input.context.originalFilename;
  if (!orig) return null;
  const dot = orig.lastIndexOf(".");
  if (dot < 0 || dot === orig.length - 1) return null;
  return orig.slice(dot + 1).toLowerCase();
}

function slug(s: string, max: number): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max) || "x"
  );
}

/** Key path segment — URL-safe so keys never need URL-encoding. */
function sanitizeSeg(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sanitizeExt(ext: string): string {
  return ext.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase() || "bin";
}

/** S3 object metadata must be ASCII; strip anything else. */
function sanitizeMeta(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "_").slice(0, 200);
}

// There is deliberately NO `r2Internal` escape hatch anymore. avatar.ts and the
// header-media tenant gate used to reach past the interface for a raw S3Client
// and R2's url parser; both now go through BlobStorageProvider (`putObject`,
// `delete`, `keyFromUrl`), so nothing outside this file knows the app stores
// anything on R2 — which is the only reason a second driver can exist at all.

/** Exposed for tests. */
export const _testing = { buildKey, buildReadableName, slug };
