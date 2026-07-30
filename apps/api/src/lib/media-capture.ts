/**
 * Fetching remote media into R2 — the SSRF-safe download and the process-wide
 * concurrency gate that bounds it.
 *
 * EXTRACTED VERBATIM from `webhooks/meta/meta.controller.ts`, where it lived as
 * three module-private functions. Nothing about the behaviour changed; the move
 * exists because a SECOND caller now needs it (the outbound sticker send, which
 * must capture Meta's sticker CDN image before that URL expires), and the only
 * alternative was a second copy of `fetchUrlBytes`.
 *
 * That copy is what makes this a real seam rather than tidying: `fetchUrlBytes`
 * is a SECURITY CONTROL. It is the SSRF gate on a URL that arrives inside a
 * webhook body whose HMAC is signed with a secret the workspace admin sets
 * themselves — so an admin can name any host reachable from this container and
 * read the bytes back out through `GET /api/media/:messageId`. Two copies of that
 * defence is one copy that eventually drifts.
 *
 * Everything below is the original code and the original comments.
 */

import { SsrfBlockedError, safeFetch } from "@/lib/http/safe-fetch";

/**
 * Process-wide gate on concurrent inbound-media DOWNLOADS.
 *
 * WHY: each download buffers the whole binary in memory (up to the per-kind cap
 * — 100MB for a WhatsApp document, 25MB for social). The per-webhook-batch
 * `runWithConcurrency(4)` bounds ONE delivery, but Meta fans webhooks out in
 * parallel across all ~30 tenants, so a redelivery burst after downtime can put
 * dozens of full Buffers in flight at once — external memory that is NOT counted
 * against `--max-old-space-size`, so RSS can blow past the 3g cgroup and
 * OOM-kill the api (the same failure class ffmpeg-slots.ts guards for the decode
 * stage). A counting semaphore with a bounded wait caps the aggregate. On
 * wait-timeout the acquire throws into each download's existing catch, which
 * records the outcome (retriable for WhatsApp → the inbound-media sweeper
 * re-fetches; a labeled bubble for social) — no message row is lost. Single
 * process, like every in-memory gate here (CLAUDE.md §16); a second app instance
 * would need a shared counter.
 */
const MEDIA_DOWNLOAD_WAIT_MS = 15_000;

function mediaDownloadMaxConcurrent(): number {
  const raw = Number.parseInt(process.env.MEDIA_DOWNLOAD_CONCURRENCY ?? "8", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 32 ? raw : 8;
}

let mediaDownloadsActive = 0;
const mediaDownloadWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

function releaseMediaDownloadSlot(): void {
  const next = mediaDownloadWaiters.shift();
  if (next) {
    // Hand the slot straight to the next waiter — do NOT decrement first, or a
    // caller arriving between the decrement and the handoff can steal it and
    // push `active` over the cap (same discipline as ffmpeg-slots.ts).
    next.resolve();
    return;
  }
  mediaDownloadsActive = Math.max(0, mediaDownloadsActive - 1);
}

function acquireMediaDownloadSlot(waitMs: number): Promise<void> {
  if (mediaDownloadsActive < mediaDownloadMaxConcurrent()) {
    mediaDownloadsActive += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const entry = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject,
    };
    const timer = setTimeout(() => {
      const i = mediaDownloadWaiters.indexOf(entry);
      if (i >= 0) mediaDownloadWaiters.splice(i, 1);
      reject(
        new Error(
          `media download slot wait exceeded ${waitMs}ms (${mediaDownloadsActive} active, ${mediaDownloadWaiters.length} queued)`,
        ),
      );
    }, waitMs);
    timer.unref();
    mediaDownloadWaiters.push(entry);
  });
}

/**
 * Run `fn` (a single media download) holding one process-wide slot. Throws if no
 * slot frees within the wait budget; both callers already treat a throw as a
 * failed download and record the appropriate outcome.
 */
export async function withMediaDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireMediaDownloadSlot(MEDIA_DOWNLOAD_WAIT_MS);
  try {
    return await fn();
  } finally {
    releaseMediaDownloadSlot();
  }
}

/**
 * Fetch a direct media URL (Messenger / Instagram attachment) into memory,
 * capping by Content-Length before buffering when the CDN sends it. The
 * authoritative post-buffer cap lives in the caller (`downloadSocialMedia`) for
 * CDNs that omit/understate the header. Reads the real mime type from the
 * response. 20s hard timeout so a hung CDN can't pin a connection.
 */
export async function fetchUrlBytes(
  url: string,
  capBytes: number,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  try {
    // SSRF-SAFE, not raw `fetch`. This URL comes straight out of a webhook
    // payload, and the HMAC that authenticates that payload is signed with an
    // `appSecret` the WORKSPACE ADMIN sets themselves — so an admin can sign a
    // body naming any host reachable from this container (`127.0.0.1`,
    // `169.254.169.254`, another service on the VPS), have us fetch it, and
    // then read the bytes back through `GET /api/media/:messageId`. Full read
    // exfiltration, not blind: the mime gate doesn't stop it, because an
    // unknown body sniffs to nothing and falls through to the kind's canonical
    // type.
    //
    // `safeFetch` resolves the host, refuses every private/link-local range in
    // both v4 and all v6 notations, and PINS the validated address for the
    // actual connection so a DNS rebind between check and fetch can't win.
    // CLAUDE.md §16 already required it for provider/webhook calls; this path
    // was the one that missed. Redirects off — a CDN 302 to an internal host
    // would otherwise re-open the hole one hop later.
    const res = await safeFetch(url, {
      timeoutMs: 20_000,
      maxRedirects: 0,
      maxResponseBytes: capBytes,
    });
    if (!res.ok) throw new Error(`social media fetch ${res.status}`);
    // Content-Length is an EARLY reject when present, but a CDN can omit or
    // understate it — so we ALSO enforce the cap while STREAMING the body,
    // aborting the moment accumulated bytes exceed `capBytes`. Never buffer an
    // unbounded response into heap (`res.arrayBuffer()` would): a Content-Length-
    // less multi-hundred-MB attachment must not spike RAM on the shared VPS.
    const cl = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(cl) && cl > capBytes) {
      throw new Error(`social media over cap (content-length ${cl} > ${capBytes})`);
    }
    const bytes = await readBodyCapped(res, capBytes);
    const mimeType =
      (res.headers.get("content-type") ?? "application/octet-stream")
        .split(";")[0]
        ?.trim() || "application/octet-stream";
    return { bytes, mimeType };
  } catch (err) {
    // Surface an SSRF refusal distinctly so an operator debugging a missing
    // attachment sees "we refused this host", not a generic fetch failure.
    // (This block used to rethrow unchanged, which made the comment a lie and
    // the wrapper dead weight — lint's `no-useless-catch` was right.)
    if (err instanceof SsrfBlockedError) {
      throw new Error(`social media fetch refused: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Read a fetch Response body into a Uint8Array, aborting as soon as the running
 * total exceeds `capBytes` — so heap never holds more than ~`capBytes` + one
 * chunk regardless of the (possibly absent/lying) Content-Length header.
 */
async function readBodyCapped(
  res: Awaited<ReturnType<typeof fetch>>,
  capBytes: number,
): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No readable stream — fall back to a full read but still enforce the cap.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > capBytes) {
      throw new Error(`social media over cap (${buf.length} > ${capBytes})`);
    }
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > capBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`social media over cap (streamed ${total} > ${capBytes})`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
