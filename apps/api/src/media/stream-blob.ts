import type { Response } from "express";

import { blobStorage } from "@/lib/blob-storage";
import { BlobObjectNotFoundError } from "@/lib/blob-storage/types";

/**
 * Stream a private blob object to the browser SAME-ORIGIN (no redirect, no
 * presigned URL). This is how every authenticated media surface serves bytes —
 * /api/media/:id, video/audio thumbnails, avatars, team-chat attachments,
 * template-header previews. Range is forwarded so <video>/<audio> seeking works
 * (R2 answers with a 206 + Content-Range).
 *
 * Why proxy instead of 302-to-presigned: same-origin means no CSP host
 * juggling, no cross-origin-redirect + Range fragility, and no GET-vs-HEAD
 * presign-signature mismatch — the redirect approach broke all three of those.
 * R2 egress is free, so at pilot scale the VPS passthrough cost is negligible.
 *
 * The bytes for a given (messageId → key) never change, so we can cache hard
 * (1 year, immutable) — much better than the short TTL a presigned URL forced.
 */
export async function streamBlob(
  res: Response,
  keyOrUrl: string,
  range: string | undefined,
  opts?: { downloadFilename?: string; cacheSeconds?: number },
): Promise<void> {
  let obj;
  try {
    obj = await blobStorage.getObject(keyOrUrl, range ? { range } : undefined);
  } catch (err) {
    if (err instanceof BlobObjectNotFoundError) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // An unsatisfiable Range (client seeked past EOF / sent a garbage range) is
    // a 416, not a server fault — forward it so the media element retries with a
    // valid range instead of treating a 502 as an outage.
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    if (status === 416) {
      res.status(416).json({ error: "range_not_satisfiable" });
      return;
    }
    // Transient upstream error — clean 502 rather than a hung socket.
    res.status(502).json({ error: "upstream_error" });
    return;
  }

  res.status(obj.statusCode);
  res.set("Content-Type", obj.contentType);
  res.set("Accept-Ranges", obj.acceptRanges);
  if (obj.contentLength != null) res.set("Content-Length", String(obj.contentLength));
  if (obj.contentRange) res.set("Content-Range", obj.contentRange);
  res.set("Cache-Control", `private, max-age=${opts?.cacheSeconds ?? 31_536_000}, immutable`);
  res.set("Vary", "Cookie");
  // Default: NO Content-Disposition → the browser renders inline (PDFs open in
  // the built-in viewer, images/video/audio play in-tab). Only force a download
  // (attachment) when a downloadFilename is passed — the explicit "Download"
  // affordance sends `?download=1`. Setting `attachment` here is what makes a
  // same-origin download reliable now that media isn't a cross-origin redirect.
  if (opts?.downloadFilename) {
    const raw = opts.downloadFilename.slice(0, 200);
    // ASCII fallback for legacy agents: strip quotes/backslash/CR/LF AND any
    // non-ASCII byte (code point > 0x7E). Node's `res.set` serializes headers
    // as latin1 and THROWS ERR_INVALID_CHAR on a code point > 255, so a plain
    // `filename="<utf8>"` crashes the whole response for any emoji/CJK/accented
    // filename. RFC 5987's `filename*=UTF-8''<pct-encoded>` carries the real
    // name for modern browsers; `filename=` is the ASCII fallback.
    const asciiFallback =
      raw.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_") || "download";
    const encoded = encodeURIComponent(raw);
    res.set(
      "Content-Disposition",
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
    );
  }

  // If the client aborts (closes the tab, seeks away), tear down the upstream
  // read so we don't leak the socket.
  res.on("close", () => obj.body.destroy());
  obj.body.on("error", () => {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  obj.body.pipe(res);
}

/**
 * Cheap existence check for the `?probe=1` liveness path — reads the first byte
 * (Range: bytes=0-0) and discards it. Returns whether the object is fetchable
 * so the client can show an in-app "unavailable" state instead of opening a tab
 * onto a 404. Never throws.
 */
export async function probeBlob(keyOrUrl: string): Promise<boolean> {
  try {
    const obj = await blobStorage.getObject(keyOrUrl, { range: "bytes=0-0" });
    obj.body.destroy();
    return true;
  } catch {
    return false;
  }
}
