// SSRF-safe fetch. Used by every code path that issues an HTTP request to a
// customer-configured URL: outbound webhook delivery, workflow `http_request`
// step, future incoming-webhook test pings, etc.
//
// Defenses, in order of importance:
//   1. Resolve the hostname before connect. If ANY resolved address is in the
//      blocklist (loopback, link-local incl. AWS IMDS 169.254/16, RFC1918,
//      ULA, CGNAT, broadcast, reserved), refuse. This catches the "public DNS
//      record pointing to 169.254.169.254" attack.
//   2. Disallow non-http(s) schemes. The URL parser already rejects most, but
//      a `data:` / `file:` URL that somehow gets through the registration
//      schema gets stopped here too.
//   3. Manual redirect handling. Node's default `fetch` follows up to 20
//      redirects with no per-hop validation — a public 302 → 169.254.169.254
//      bypass. We set `redirect: "manual"` and re-validate every hop, capped
//      at `MAX_REDIRECTS`.
//   4. Disallow URL-embedded credentials (`https://user:pass@host`) — they
//      get sent in `Authorization` headers and trip log scrubbers.
//
// Bypass for trusted dev usage (running a local receiver during integration
// development): set `INTEGRATIONS_ALLOW_PRIVATE_HOSTS=1`. Production environment
// MUST NOT set this — the comment in `outbound-webhooks.schemas.ts` calling
// out the worker-side SSRF defense exists because of this helper.

import { promises as dns } from "node:dns";
import { isIP } from "node:net";

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED" as const;
  readonly url: string;
  readonly reason: string;
  constructor(url: string, reason: string) {
    super(`refusing to fetch ${url}: ${reason}`);
    this.name = "SsrfBlockedError";
    this.url = url;
    this.reason = reason;
  }
}

function allowPrivate(): boolean {
  return process.env.INTEGRATIONS_ALLOW_PRIVATE_HOSTS === "1";
}

/**
 * True if `ip` is in a range we never permit egress to from the integrations
 * layer. Accepts both IPv4 dotted-quad and IPv6 colon-hex strings.
 *
 * IPv4 ranges blocked:
 *   - 0.0.0.0/8        (this network)
 *   - 10.0.0.0/8       (RFC1918)
 *   - 100.64.0.0/10    (CGNAT)
 *   - 127.0.0.0/8      (loopback)
 *   - 169.254.0.0/16   (link-local, includes AWS/GCP/Azure IMDS)
 *   - 172.16.0.0/12    (RFC1918)
 *   - 192.0.0.0/24     (IETF protocol assignments)
 *   - 192.168.0.0/16   (RFC1918)
 *   - 198.18.0.0/15    (benchmarking)
 *   - 224.0.0.0/4      (multicast)
 *   - 240.0.0.0/4      (reserved)
 *   - 255.255.255.255  (broadcast)
 *
 * IPv6 ranges blocked: loopback ::1, link-local fe80::/10, ULA fc00::/7,
 * IPv4-mapped ::ffff:0:0/96 (re-checks the embedded v4 against above).
 */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIpv4(ip);
  if (v === 6) return isBlockedIpv6(ip);
  return true; // unknown = block
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + IMDS
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // IPv4-mapped: ::ffff:1.2.3.4 — re-check the embedded v4.
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped && isIP(mapped[1]!) === 4) {
    return isBlockedIpv4(mapped[1]!);
  }
  // fe80::/10 (link-local), fc00::/7 (ULA, incl fd00::/8)
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // ff00::/8 multicast
  if (lower.startsWith("ff")) return true;
  return false;
}

/**
 * Validate a URL is safe to fetch. Resolves the hostname via DNS and rejects
 * if any returned address sits in a blocked range. This is called fresh on
 * each request (NOT cached) so DNS rebinding past the first request also
 * fails on the second hop.
 *
 * Throws `SsrfBlockedError` on rejection. Returns the original URL string
 * (possibly normalized) on success.
 */
export async function assertPublicHost(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(url, "invalid url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(url, `scheme ${parsed.protocol} not allowed`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError(url, "url-embedded credentials not allowed");
  }
  const hostname = parsed.hostname;
  if (!hostname) {
    throw new SsrfBlockedError(url, "missing hostname");
  }

  // If the hostname is already an IP literal, check it directly.
  if (isIP(hostname)) {
    if (isBlockedIp(hostname) && !allowPrivate()) {
      throw new SsrfBlockedError(url, `host ${hostname} is in a blocked range`);
    }
    return;
  }

  // Resolve via DNS — get every A/AAAA so a multi-record answer can't sneak
  // a private address through.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new SsrfBlockedError(url, `dns lookup failed: ${err instanceof Error ? err.message : err}`);
  }
  if (addrs.length === 0) {
    throw new SsrfBlockedError(url, "dns returned no addresses");
  }
  if (!allowPrivate()) {
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        throw new SsrfBlockedError(url, `host ${hostname} resolved to blocked ${a.address}`);
      }
    }
  }
}

export interface SafeFetchOptions extends Omit<RequestInit, "redirect"> {
  /** Per-attempt timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Override the default redirect cap (3). */
  maxRedirects?: number;
}

/**
 * Fetch wrapper that validates the destination (and every redirect hop) is
 * not a private/loopback/link-local address before connecting. Returns the
 * final non-redirect Response — callers handle status code semantics.
 *
 * The redirect cap is intentionally lower than Node's default (20). Almost
 * every legitimate webhook receiver is a direct endpoint; 3 hops covers
 * the rare CDN/load-balancer chain.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;

  let currentUrl = url;
  let currentMethod = (opts.method ?? "GET").toUpperCase();
  let currentBody: RequestInit["body"] = opts.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHost(currentUrl);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        ...opts,
        method: currentMethod,
        body: currentBody,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }

    // Non-redirect → caller handles.
    if (res.status < 300 || res.status >= 400 || res.status === 304) {
      return res;
    }
    const loc = res.headers.get("location");
    if (!loc) return res; // malformed redirect; let caller see the 3xx.

    // Resolve relative redirects against the current URL.
    let next: URL;
    try {
      next = new URL(loc, currentUrl);
    } catch {
      throw new SsrfBlockedError(loc, "redirect target is not a valid URL");
    }

    // 303 always demotes to GET with no body. 301/302/307/308 follow HTTP
    // semantics — 307/308 preserve method+body; 301/302 historically demote
    // to GET, which is the safer default here.
    if (res.status === 303 || res.status === 301 || res.status === 302) {
      currentMethod = "GET";
      currentBody = undefined;
    }
    currentUrl = next.toString();
  }

  throw new SsrfBlockedError(url, `exceeded ${maxRedirects} redirects`);
}

/**
 * Read a Response body with a hard byte ceiling. Used everywhere callers
 * previously did `response.text()` and post-truncated — that pattern loads
 * the whole body into memory first, so a malicious or buggy receiver can
 * OOM the worker with a multi-GB response. Streams instead.
 */
export async function readLimitedBody(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort cleanup
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  for (const c of chunks) out += decoder.decode(c, { stream: true });
  out += decoder.decode();
  return truncated ? out + "…[truncated]" : out;
}
