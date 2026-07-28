import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildKey } from "./r2";
import { assertAllowedMime, assertSignatureMatches } from "./mime-guard";
import {
  BlobObjectNotFoundError,
  type BlobStorageProvider,
  type UploadInput,
  type UploadResult,
} from "./types";

/**
 * Filesystem implementation of BlobStorageProvider — for CI and offline dev,
 * never for production.
 *
 * It exists because the media paths (call recordings, inbound attachments,
 * exports) are the ones we most need end-to-end coverage on — a lost recording
 * is unrecoverable — and R2 credentials cannot go into a test job: the only
 * ones this repo has are PRODUCTION's, and pointing CI at the live bucket would
 * write test objects into real tenant storage. Without a local backend the
 * whole `whatsapp-call-artifacts` e2e file and the in-app recording specs can
 * only be skipped, which is exactly the coverage we can least afford to lose.
 *
 * Selection is an EXPLICIT opt-in (`BLOB_STORAGE_DRIVER=local`), never an
 * implicit fallback when R2 env is missing — a storage backend that silently
 * degrades is how writes go missing without anyone noticing. See index.ts,
 * which also refuses to load this driver under NODE_ENV=production.
 *
 * Layout: one flat directory, each object stored as two files keyed by the
 * base64url of the object key — the bytes, and a `.type` sidecar holding the
 * content type. Flat + encoded means a key can never escape the root, so the
 * traversal question the R2 impl doesn't have to answer doesn't arise here.
 */

const MAX_FETCH_BYTES = 100 * 1024 * 1024; // parity with the R2 impl

/** Reserved, guaranteed-non-resolvable TLD: a leaked url is inert. */
const LOCAL_HOST = "local-blob.invalid";

let cachedRoot: string | null = null;

function root(): string {
  if (cachedRoot) return cachedRoot;
  cachedRoot =
    process.env.BLOB_LOCAL_DIR || path.join(tmpdir(), "ccp-blob-storage");
  return cachedRoot;
}

function bucket(): string {
  return process.env.R2_BUCKET || "local";
}

function encode(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

function decode(name: string): string {
  return Buffer.from(name, "base64url").toString("utf8");
}

function bytesPath(key: string): string {
  return path.join(root(), encode(key));
}

function typePath(key: string): string {
  return `${bytesPath(key)}.type`;
}

function stableObjectUrl(key: string): string {
  return `https://${LOCAL_HOST}/${bucket()}/${key}`;
}

function keyFromOwnUrl(url: string): string | null {
  if (!localProvider.isOwnUrl(url)) return null;
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

/** Accepts a key or one of our own stable urls; throws on a foreign url. */
function resolveKey(keyOrUrl: string, op: string): string {
  if (!keyOrUrl.startsWith("http")) return keyOrUrl;
  const key = keyFromOwnUrl(keyOrUrl);
  if (!key) throw new Error(`local ${op}: refusing non-local-blob url`);
  return key;
}

async function write(
  key: string,
  body: Uint8Array | { fromFile: string },
  contentType: string,
): Promise<number> {
  await mkdir(root(), { recursive: true });
  let size: number;
  if ("fromFile" in body) {
    // Streamed, not read-then-write: the callers that use this path (a 100k
    // contact export) are the ones running under a heap cap, and buffering
    // here would quietly undo the streaming they went to the trouble of doing.
    ({ size } = await stat(body.fromFile));
    await pipeline(createReadStream(body.fromFile), createWriteStream(bytesPath(key)));
  } else {
    await writeFile(bytesPath(key), body);
    size = body.length;
  }
  await writeFile(typePath(key), contentType, "utf8");
  return size;
}

async function contentTypeOf(key: string): Promise<string> {
  try {
    return (await readFile(typePath(key), "utf8")) || "application/octet-stream";
  } catch {
    return "application/octet-stream";
  }
}

export const localProvider: BlobStorageProvider = {
  name: "local",

  async upload(input: UploadInput): Promise<UploadResult> {
    // Same guards as R2 — the mime allowlist + magic-byte sniff is the
    // stored-XSS defense, and a test backend that skipped it would let a
    // suite go green on bytes production refuses.
    assertAllowedMime(input.kind, input.mimeType);
    assertSignatureMatches(input.bytes, input.mimeType);
    const key = buildKey(input);
    const sizeBytes = await write(key, input.bytes, input.mimeType);
    return { key, url: stableObjectUrl(key), sizeBytes };
  },

  async putObject(input): Promise<UploadResult> {
    const sizeBytes = await write(input.key, input.bytes, input.contentType);
    return { key: input.key, url: stableObjectUrl(input.key), sizeBytes };
  },

  async putObjectFromFile(input): Promise<UploadResult> {
    const sizeBytes = await write(
      input.key,
      { fromFile: input.path },
      input.contentType,
    );
    return { key: input.key, url: stableObjectUrl(input.key), sizeBytes };
  },

  async getObject(keyOrUrl, opts): Promise<import("./types").BlobObjectStream> {
    const key = resolveKey(keyOrUrl, "getObject");
    let size: number;
    try {
      ({ size } = await stat(bytesPath(key)));
    } catch {
      throw new BlobObjectNotFoundError(key);
    }
    const contentType = await contentTypeOf(key);

    const range = parseRange(opts?.range, size);
    if (!range) {
      return {
        body: createReadStream(bytesPath(key)),
        contentType,
        contentLength: size,
        acceptRanges: "bytes",
        statusCode: 200,
      };
    }
    return {
      body: createReadStream(bytesPath(key), { start: range.start, end: range.end }),
      contentType,
      contentLength: range.end - range.start + 1,
      contentRange: `bytes ${range.start}-${range.end}/${size}`,
      acceptRanges: "bytes",
      statusCode: 206,
    };
  },

  async presignGetUrl(keyOrUrl): Promise<string> {
    // There is no signing server here, so this returns the stable address.
    // It is NOT fetchable — the same contract the private R2 bucket gives any
    // consumer that ignores the signature, and enough for the call sites that
    // only pass the url onward (`toExternalMediaUrl`, template header media).
    return stableObjectUrl(resolveKey(keyOrUrl, "presign"));
  },

  async delete(keys: string | string[]): Promise<void> {
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    for (const key of list) {
      // force: true — a missing key must never throw (same contract as R2).
      await rm(bytesPath(key), { force: true }).catch(() => undefined);
      await rm(typePath(key), { force: true }).catch(() => undefined);
    }
  },

  async fetch(keyOrUrl: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const key = resolveKey(keyOrUrl, "fetch");
    let bytes: Buffer;
    try {
      bytes = await readFile(bytesPath(key));
    } catch {
      throw new BlobObjectNotFoundError(key);
    }
    if (bytes.length > MAX_FETCH_BYTES) {
      throw new Error(`local fetch: body exceeded cap ${MAX_FETCH_BYTES}`);
    }
    return { bytes: new Uint8Array(bytes), mimeType: await contentTypeOf(key) };
  },

  isOwnUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      return parsed.hostname.toLowerCase() === LOCAL_HOST;
    } catch {
      return false;
    }
  },

  keyFromUrl(url: string): string | null {
    return keyFromOwnUrl(url);
  },

  async listKeys({ limit, cursor, prefix }) {
    let names: string[];
    try {
      names = await readdir(root());
    } catch {
      return { keys: [] };
    }
    const all: Array<{ key: string; uploadedAt: number }> = [];
    for (const name of names) {
      if (name.endsWith(".type")) continue;
      let key: string;
      try {
        key = decode(name);
      } catch {
        continue;
      }
      if (prefix && !key.startsWith(prefix)) continue;
      const { mtimeMs } = await stat(path.join(root(), name));
      all.push({ key, uploadedAt: mtimeMs });
    }
    // Stable order so the cursor (an index) means the same thing across pages.
    all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const start = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    const page = all.slice(start, start + limit);
    const next = start + page.length;
    return {
      keys: page,
      ...(next < all.length ? { nextCursor: String(next) } : {}),
    };
  },
};

/** `bytes=<start>-<end>` → absolute inclusive offsets, or null for a full read. */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const rawStart = m[1] ?? "";
  const rawEnd = m[2] ?? "";
  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix range: last N bytes.
    const n = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === "" ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
