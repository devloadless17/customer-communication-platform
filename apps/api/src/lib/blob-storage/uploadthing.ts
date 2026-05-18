import { UTApi, UTFile } from "uploadthing/server";

import { extFromMime } from "@/lib/media-storage";
import type {
  BlobStorageProvider,
  UploadInput,
  UploadResult,
} from "./types";

/**
 * UploadThing implementation of BlobStorageProvider.
 *
 * UTApi is constructed lazily so missing-token errors only happen on first
 * USE (e.g. someone sends media), not on module load — keeps the rest of the
 * app bootable in environments where media isn't configured yet.
 *
 * `customId` is set to the provider's external message id (wamid). It's not
 * how we look files up today — we store the returned fileKey on the message
 * row and use that — but it gives us a second handle in the dashboard for
 * audit/debugging.
 */

let utApi: UTApi | null = null;
function getUtApi(): UTApi {
  if (utApi) return utApi;
  const token = process.env.UPLOADTHING_TOKEN;
  if (!token) {
    throw new Error(
      "UPLOADTHING_TOKEN is not set — required to upload media. " +
        "Add it to .env (see .env.example).",
    );
  }
  // The SDK reads `process.env.UPLOADTHING_TOKEN` directly when no token is
  // passed; we still validate above so the error message is on us, not them.
  utApi = new UTApi();
  return utApi;
}

export const uploadthingProvider: BlobStorageProvider = {
  name: "uploadthing",

  async upload(input: UploadInput): Promise<UploadResult> {
    const filename = buildFilename(input);
    // Copy into a tight ArrayBuffer — Uint8Array<ArrayBufferLike> isn't
    // assignable to BlobPart on some Node+TS combinations because of the
    // SharedArrayBuffer branch on `Uint8Array.buffer`. The byte copy is
    // negligible compared to the upload itself.
    const buf = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(buf).set(input.bytes);
    const file = new UTFile([buf], filename, {
      // `type` is on the standard BlobPropertyBag in DOM lib types, but the
      // Node/NestJS tsconfig (lib: ES2022 only) sees the Node global Blob
      // whose property-bag drops it. Double-cast keeps the runtime pass-through.
      type: input.mimeType,
      // Doubles as a back-reference in the dashboard: clicking a file shows
      // its customId, which is the wamid we stored on the Message row.
      customId: input.context.externalId,
    } as unknown as ConstructorParameters<typeof UTFile>[2]);

    const res = await getUtApi().uploadFiles(file);
    if (res.error || !res.data) {
      // `customId` is unique per UploadThing app. A previous attempt that
      // succeeded at the storage layer but failed before the row write
      // (network blip mid-batch, process restart, CAS race in the old
      // 2-phase flow) leaves an orphan blob — re-upload then 409s with a
      // "File already exists" body, but the error code/shape varies across
      // SDK versions, so don't gate on it. Same wamid → same bytes, so a
      // customId-keyed lookup that comes back with a match IS the right
      // answer regardless of what the upload error said. If the lookup
      // misses, fall through to throw the original error (genuine upload
      // failure with no orphan).
      const existing = await resolveByCustomId(input.context.externalId);
      if (existing) return { ...existing, sizeBytes: input.bytes.length };
      const detail = res.error?.message ?? "unknown upload error";
      throw new Error(`uploadthing upload failed: ${detail}`);
    }
    // ufsUrl is the canonical CDN URL going forward; the older `url` is being
    // phased out in uploadthing v9.
    return {
      key: res.data.key,
      url: res.data.ufsUrl,
      sizeBytes: res.data.size,
    };
  },

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length === 0) return;
    try {
      await getUtApi().deleteFiles(list);
    } catch (err) {
      // Same contract as the old disk deleteMedia: never throw. A missing or
      // already-deleted key shouldn't block the surrounding domain delete.
      console.warn("[blob-storage/uploadthing] delete failed (ignored)", err);
    }
  },

  async fetch(keyOrUrl: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    // Public CDN fetch — UploadThing files are public by default, so we can
    // just GET the URL. If we ever switch to signed/private files we'll need
    // to swap in a UTApi presign call here.
    let url: string | undefined;
    if (keyOrUrl.startsWith("http")) {
      // SSRF guard: only fetch URLs we know are ours. The caller usually hands
      // us a row from the messages table, but if a future code path ever lets
      // a user influence mediaUrl this stops outbound fetches to arbitrary
      // hosts (cloud metadata IPs, internal services).
      if (!uploadthingProvider.isOwnUrl(keyOrUrl)) {
        throw new Error("uploadthing fetch: refusing non-uploadthing url");
      }
      url = keyOrUrl;
    } else {
      url = (await getUtApi().getFileUrls(keyOrUrl)).data[0]?.url;
    }
    if (!url) throw new Error(`uploadthing fetch: no url for ${keyOrUrl}`);

    const r = await fetch(url);
    if (!r.ok) throw new Error(`uploadthing fetch failed: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      bytes: new Uint8Array(buf),
      mimeType: r.headers.get("content-type") ?? "application/octet-stream",
    };
  },

  isOwnUrl(url: string): boolean {
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      host = parsed.hostname.toLowerCase();
    } catch {
      return false;
    }
    // UploadThing CDN hostnames: the legacy shared `utfs.io` and the
    // app-scoped `<appid>.ufs.sh`. Match exact-host and subdomain-of.
    return (
      host === "utfs.io" ||
      host.endsWith(".utfs.io") ||
      host === "ufs.sh" ||
      host.endsWith(".ufs.sh")
    );
  },
};

/**
 * Build the filename UploadThing will store the file under. Goal: be able to
 * scan the dashboard and immediately tell which team, which direction, which
 * customer, and which chat a file belongs to.
 *
 * Format: `YYYY-MM-DD_{in|out}_{team}_{phone}_{contact}_{convo8}_{externalShort}.{ext}`
 *
 * Examples:
 *   2026-05-14_in_loadless_+96170921116_ali_cmcabc12_HBgLOTYx.jpg
 *   2026-05-14_out_loadless_+12345678901_jane_doe_cmconv99_HBgLPDF2.pdf
 *
 * UploadThing dashboards show this verbatim. Slashes are NOT used — the SDK
 * preserves the name as-is and slashes render oddly. Underscores keep the
 * name greppable in the dashboard search.
 */
export function buildFilename(input: UploadInput): string {
  const { context, mimeType } = input;
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const team = slug(context.teamSlug ?? context.teamId, 16);
  const phone = context.contactPhone ?? "unknown";
  const contact = slug(context.contactName ?? "anon", 20);
  const convo = (context.conversationId ?? "noconvo").slice(-8);
  const ext = sanitizeExt(documentExtension(input) ?? extFromMime(mimeType));

  // wamids are long (~40+ chars). Tail-slice for uniqueness without bloat —
  // the dashboard search still matches on this slice.
  const extShort = context.externalId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-12);

  // Phone is kept as-is including the leading `+` (E.164 is human-readable);
  // dashboards display it fine and the `+` survives URL encoding in browsers.
  return `${date}_${input.context.direction}_${team}_${phone}_${contact}_${convo}_${extShort}.${ext}`;
}

/**
 * For documents we'd rather preserve the original extension than guess from
 * mime (a generic `application/octet-stream` would otherwise turn into `.bin`).
 */
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

function sanitizeExt(ext: string): string {
  return ext.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase() || "bin";
}

/**
 * Look up an UploadThing file by its customId (the wamid we set at upload).
 * Used to recover from 409 "File already exists" — same wamid means same
 * bytes, so the existing blob is the correct one to point the message row at.
 * Returns null when the lookup fails for any reason (rare; surfaces the
 * original 409 to the caller).
 */
async function resolveByCustomId(
  customId: string,
): Promise<{ key: string; url: string } | null> {
  try {
    const res = await getUtApi().getFileUrls(customId, { keyType: "customId" });
    const first = res.data?.[0];
    if (!first?.url || !first.key) return null;
    return { key: first.key, url: first.url };
  } catch (err) {
    console.warn(
      "[blob-storage/uploadthing] resolveByCustomId failed for",
      customId,
      err,
    );
    return null;
  }
}

/** Exposed for tests. */
export const _testing = { buildFilename, slug };
