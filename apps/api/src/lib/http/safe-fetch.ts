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

import http from "node:http";
import https from "node:https";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
// Cap the buffered response body. The pinned request below reads the body
// eagerly to build a Response; without a ceiling a hostile receiver could
// stream unbounded bytes into memory. 16 MB is far above any webhook ack or
// automation API response we expect; exceeding it aborts the hop (the caller
// sees a network-style error, same as a timeout).
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

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

type ResolvedAddr = { address: string; family: number };

function allowPrivate(): boolean {
  return process.env.INTEGRATIONS_ALLOW_PRIVATE_HOSTS === "1";
}

/** Normalize fetch-style headers to a Node outgoing-headers object. */
function toNodeHeaders(
  h: NonNullable<RequestInit["headers"]> | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k] = v as string;
  return out;
}

/**
 * Issue ONE request to a host whose IP was already validated, PINNING the
 * socket to exactly those addresses via a custom `lookup` — so undici/the OS
 * can't independently re-resolve the hostname to a now-private IP between the
 * check and the connect (the DNS-rebinding TOCTOU). SNI/cert validation still
 * use the original hostname (`servername`), so HTTPS is unaffected. Returns a
 * real `Response`; redirects are NOT followed here (Node returns the 3xx) — the
 * caller's loop handles them, re-validating + re-pinning each hop.
 */
async function pinnedFetch(
  url: string,
  addrs: ResolvedAddr[],
  opts: {
    method: string;
    headers: NonNullable<RequestInit["headers"]> | undefined;
    body: RequestInit["body"];
    signal: AbortSignal;
  },
): Promise<Response> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const mod = isHttps ? https : http;
  const lookup = (
    _hostname: string,
    options: { all?: boolean } | number,
    cb: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
  ): void => {
    // Connect ONLY to the addresses we already validated for this exact host.
    if (addrs.length === 0) {
      cb(new SsrfBlockedError(url, "no validated address to connect"));
      return;
    }
    const all = typeof options === "object" && options.all;
    if (all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
    else cb(null, addrs[0]!.address, addrs[0]!.family);
  };
  return await new Promise<Response>((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: opts.method,
        headers: toNodeHeaders(opts.headers),
        lookup: lookup as never,
        ...(isHttps && !isIP(u.hostname) ? { servername: u.hostname } : {}),
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("response body exceeded cap"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v == null) continue;
            if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
            else headers.set(k, String(v));
          }
          const status = res.statusCode ?? 502;
          const nullBody =
            status === 204 || status === 205 || status === 304 || size === 0;
          resolve(
            new Response(nullBody ? null : Buffer.concat(chunks), {
              status,
              statusText: res.statusMessage ?? "",
              headers,
            }),
          );
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    const body = opts.body;
    if (body != null) {
      if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
        req.write(body);
      } else {
        req.destroy();
        reject(new TypeError("safeFetch: unsupported body type for pinned request"));
        return;
      }
    }
    req.end();
  });
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
export async function assertPublicHost(
  url: string,
): Promise<ResolvedAddr[] | null> {
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

  // If the hostname is already an IP literal, check it directly. No DNS, so
  // there's no resolve-twice gap — the connection targets exactly this literal.
  // Return null: nothing to pin.
  if (isIP(hostname)) {
    if (isBlockedIp(hostname) && !allowPrivate()) {
      throw new SsrfBlockedError(url, `host ${hostname} is in a blocked range`);
    }
    return null;
  }

  // Resolve via DNS — get every A/AAAA so a multi-record answer can't sneak
  // a private address through.
  let addrs: ResolvedAddr[];
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new SsrfBlockedError(url, `dns lookup failed: ${err instanceof Error ? err.message : err}`);
  }
  if (addrs.length === 0) {
    throw new SsrfBlockedError(url, "dns returned no addresses");
  }
  if (allowPrivate()) return null; // dev escape hatch — don't pin, don't block
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new SsrfBlockedError(url, `host ${hostname} resolved to blocked ${a.address}`);
    }
  }
  // Return the VALIDATED addresses so the caller can PIN the socket to exactly
  // these IPs — closing the same-request DNS-rebinding gap where the OS would
  // otherwise re-resolve `hostname` independently between this check and the
  // actual connect (a low-TTL attacker domain answering public-then-private).
  return addrs;
}

/**
 * SYNTACTIC SSRF pre-check for REGISTRATION time (no DNS). Rejects obviously
 * unsafe webhook/callback URLs up front — wrong scheme, embedded credentials,
 * private/loopback/metadata IP LITERALS, and conventional internal hostnames
 * (localhost / *.localhost / *.local / *.internal / *.intranet / *.lan) —
 * WITHOUT resolving DNS.
 *
 * Why no DNS here: `assertPublicHost` (with DNS, re-run on every delivery hop)
 * stays the AUTHORITATIVE guard — it's the only place that can catch DNS
 * rebinding. Registration must accept a domain that doesn't resolve yet
 * (not-yet-propagated, transient DNS, or a deliberately-unresolvable test
 * domain like `*.invalid`); a stored URL that never resolves simply fails at
 * delivery and trips the breaker. Resolving DNS at registration was too strict
 * and rejected those legitimate cases. Honors the INTEGRATIONS_ALLOW_PRIVATE_HOSTS
 * dev escape hatch.
 */
export function assertRegistrableHost(url: string): void {
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
  if (allowPrivate()) return;
  // IP literal → blocked-range check (metadata 169.254.169.254, RFC1918,
  // loopback, ULA, etc.) with no DNS.
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SsrfBlockedError(url, `host ${hostname} is in a blocked range`);
    }
    return;
  }
  // Name-based internal-host block (no DNS). A public domain that rebinds to a
  // private IP still passes HERE but is caught at delivery by assertPublicHost.
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan"];
  if (lower === "localhost" || INTERNAL_SUFFIXES.some((s) => lower.endsWith(s))) {
    throw new SsrfBlockedError(url, `host ${hostname} is an internal hostname`);
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
  // Per-hop headers — on redirect we drop sensitive headers so a malicious
  // 307 to a different host can't capture the auth/signature meant for the
  // original. Same posture browser fetch + curl take by default.
  let currentHeaders: NonNullable<RequestInit["headers"]> | undefined = opts.headers;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validatedAddrs = await assertPublicHost(currentUrl);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      if (validatedAddrs) {
        // DNS host in the enforced path → connect ONLY to the validated IPs so
        // the hostname can't re-resolve to a private address (rebinding TOCTOU).
        res = await pinnedFetch(currentUrl, validatedAddrs, {
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          signal: controller.signal,
        });
      } else {
        // IP-literal target (no re-resolution gap) or dev allow-private hatch —
        // plain fetch is safe; nothing to pin.
        res = await fetch(currentUrl, {
          ...opts,
          headers: currentHeaders,
          method: currentMethod,
          body: currentBody,
          redirect: "manual",
          signal: controller.signal,
        });
      }
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
    // Strip sensitive headers on every redirect hop. A malicious
    // receiver (or a redirect to a different host) must not see the
    // original Authorization / signature / API-key headers. Same
    // posture browsers / curl take by default.
    currentHeaders = stripSensitiveHeaders(currentHeaders);
    currentUrl = next.toString();
  }

  throw new SsrfBlockedError(url, `exceeded ${maxRedirects} redirects`);
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-ccp-signature",
  "x-ccp-origin-key",
  "x-api-key",
  "proxy-authorization",
]);

function stripSensitiveHeaders(headers: NonNullable<RequestInit["headers"]> | undefined): NonNullable<RequestInit["headers"]> | undefined {
  if (!headers) return headers;
  if (headers instanceof Headers) {
    const out = new Headers(headers);
    for (const k of SENSITIVE_HEADERS) out.delete(k);
    return out;
  }
  if (Array.isArray(headers)) {
    return headers.filter(([k]) => !SENSITIVE_HEADERS.has(k.toLowerCase()));
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) {
      out[k] = v as string;
    }
  }
  return out;
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
