import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

import { COOKIE_PREFIX } from "@ccp/shared/auth/better-auth-config";

import { rateLimit } from "@/lib/rate-limit";

/**
 * Edge proxy (formerly `middleware.ts`; renamed in Next 16). Three jobs:
 *   1. Rate-limit the unauthenticated POSTs that get hammered (login + register)
 *   2. Gate every other route on session-cookie presence
 *   3. Generate a per-request CSP nonce and attach it as both a request
 *      header (consumed by `app/layout.tsx`) and a response header (the
 *      enforcing CSP), so page-served inline scripts execute under
 *      `script-src 'nonce-...'` instead of needing `'unsafe-inline'`.
 *
 * Why cookie presence and not full session validation: doing a DB lookup on
 * every request from every route is the wrong place to pay for it.
 * Better Auth signs the session cookie, so a forged cookie fails parse here
 * (`getSessionCookie` returns null). A cookie that *parses* but points to a
 * deleted/expired session row is allowed through here — the route handler
 * (`requireSession` for APIs, `getSession` for pages) does the DB recheck and
 * returns 401 / redirects through /logout. That's the right division of work:
 * cheap at the edge, authoritative in the handler.
 *
 * Public routes never check cookies. Protected routes check cookies and
 * bounce when missing.
 */
const RATE_LIMITED_POSTS: Record<string, number> = {
  // Login is gated TWICE — per-account lockout in `signInWithCredentials`
  // (5 fails / 15 min) catches password-spray against ONE account; this
  // per-IP gate catches botnet-style spray across MANY accounts where
  // per-account lockout never trips because no single account is targeted
  // enough. 5/min is what real users can manually achieve (typo, retry,
  // typo, retry, success) — 20 in a 10-minute window was generous to the
  // point of meaningless for that threat model.
  "/login": 5, // login attempts via the server action
  "/register": 8, // account creation
};
const RATE_WINDOW_MS = 10 * 60 * 1000;
// Tighter window for the per-IP login limit (5 attempts / 1 minute).
const LOGIN_RATE_WINDOW_MS = 60 * 1000;
// Per-IP GET rate cap for the public invite-lookup endpoint. Tokens are
// 128 bits so brute force is infeasible regardless, but the unauthenticated
// nature of the lookup makes it the easiest path to enumerate / fingerprint
// active teams — cap to a sensible 30 lookups/min per IP.
const INVITE_LOOKUP_RATE_LIMIT = 30;
const INVITE_LOOKUP_RATE_WINDOW_MS = 60 * 1000;

/**
 * How many reverse proxies sit between the client and this process. Defaults
 * to 1 (the typical Caddy/Traefik-in-front-of-Next setup). With this we trust
 * the Nth-from-last entry of `X-Forwarded-For` — i.e. the IP the proxy at
 * that depth actually saw, NOT whatever the client claimed in the leftmost
 * position. Set to 0 to ignore XFF entirely (use the TCP remote address);
 * set higher when chained behind multiple trusted proxies.
 */
const TRUSTED_PROXY_HOPS = Math.max(
  0,
  Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10) || 0,
);

/**
 * Per-request CSP. The nonce slot is filled at request time; everything
 * else is resolved at module load (NEXT_PUBLIC_* envs are inlined at build).
 *
 * Notes:
 *   - `script-src 'nonce-X' 'strict-dynamic'`: only inline scripts carrying
 *     the per-request nonce execute, and scripts they load may execute too.
 *     This is the modern hardening pattern — it lets Next.js inject its
 *     hydration / chunk-loader bootstrap (nonce'd by the framework) without
 *     forcing `'unsafe-inline'` or maintaining a hash allowlist.
 *   - `style-src 'self' 'unsafe-inline'`: framer-motion, next-themes, and
 *     Tailwind's runtime utilities all inject inline `<style>` and `style`
 *     attributes. CSP3's `style-src-attr` separation isn't universal enough
 *     to drop this yet; revisit when we phase out framer-motion (we already
 *     migrated several components to CSS-only animations — see globals.css).
 *   - `img-src 'self' data: blob: https:`: avatars from arbitrary HTTPS hosts
 *     (contact-supplied URLs, Gravatar fallbacks), local blobs for media
 *     previews, base64 placeholders.
 *   - `connect-src 'self' <api-origin> <ws-scheme>//<api-host>`: in prod
 *     Caddy fronts Next + NestJS on a single origin so `'self'` covers
 *     everything; in dev `NEXT_PUBLIC_API_URL` points the browser at the
 *     NestJS process on a different port and the Socket.io WebSocket
 *     handshake needs both the explicit origin AND the matching ws:/wss:
 *     scheme (browsers don't infer the WS scheme from an http(s) origin).
 *   - `frame-ancestors 'none'`: clickjacking defense, replaces the static
 *     CSP header that previously lived in `next.config.ts`.
 */
function buildConnectSrc(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!raw) return "connect-src 'self'";
  try {
    const u = new URL(raw);
    const wsScheme = u.protocol === "https:" ? "wss:" : "ws:";
    // Listing the origin twice when it equals page-origin is harmless;
    // CSP origin matching is OR-wise. Prod (Caddy same-origin) just gets
    // a redundant entry, no behavior change.
    return `connect-src 'self' ${u.origin} ${wsScheme}//${u.host}`;
  } catch {
    return "connect-src 'self'";
  }
}
const CONNECT_SRC = buildConnectSrc();

// React's dev overlay calls eval() to reconstruct call stacks from source
// maps. Production builds never do — keep `'unsafe-eval'` strictly gated on
// NODE_ENV so the prod CSP stays tight.
const IS_DEV = process.env.NODE_ENV !== "production";

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${IS_DEV ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    CONNECT_SRC,
    // /api/media/<id> 302-redirects to the UploadThing CDN, so the browser
    // resolves the final URL against media-src — keep `'self'` for the route
    // itself and add the CDN hosts so <video> / <audio> can actually load.
    // Matches the allow-list in [blob-storage/uploadthing.ts](../../api/src/lib/blob-storage/uploadthing.ts) `isOwnUrl`.
    "media-src 'self' blob: https://*.ufs.sh https://*.utfs.io",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function clientIp(req: NextRequest): string {
  if (TRUSTED_PROXY_HOPS > 0) {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) {
      const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
      // Take the entry set by the trusted proxy farthest from the client —
      // taking parts[0] would be trusting whatever the client itself supplied
      // in XFF, which is bypassable per-request.
      const idx = Math.max(0, parts.length - TRUSTED_PROXY_HOPS);
      const ip = parts[idx];
      if (ip) return ip;
    }
    const realIp = req.headers.get("x-real-ip");
    if (realIp) return realIp.trim();
  }
  // No trusted proxy (or no headers from one) — fall back to the TCP remote
  // address. NextRequest exposes this on `req.ip` in Edge runtime; in
  // environments where it's missing, everything collapses to one bucket.
  // Callers that need fail-closed semantics for security-sensitive paths
  // (e.g. /login per-IP cap) should check for "unknown" and reject rather
  // than bucket the whole world together.
  return (req as NextRequest & { ip?: string }).ip ?? "unknown";
}

/**
 * Route gate. Anything matched by `config.matcher` runs through here.
 *
 * Allowlist (no auth required):
 *   - /login                 — the sign-in page itself
 *   - /register              — the sign-up page itself
 *   - /invite/[token]        — invite acceptance
 *   - /logout                — cookie-clearing route handler
 *   - /api/auth/*            — Better Auth's own endpoints
 *   - /api/webhooks/*        — Meta posts here unauthenticated; verified by HMAC
 *   - /api/socket            — Socket.io handshake (separately authenticated)
 *   - /api/health            — Caddy / systemd liveness probes; no privileged data
 *   - /api/external/*        — bearer-token auth, not session cookies
 *
 * Everything else requires a session cookie. Unauthenticated page requests
 * get redirected to /login?next=<path>; API requests get a JSON 401.
 */
export default function proxy(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  const isApiPath = pathname.startsWith("/api/");
  // Server-to-server endpoints — never render HTML, so don't waste an
  // Edge-runtime crypto.getRandomValues per request on the CSP nonce.
  const isMachinePath = isApiPath || pathname.startsWith("/webhooks/");

  // Page routes get a per-request CSP nonce; API / webhook routes don't
  // render HTML and skip the work. The nonce is set on:
  //   - the request headers (read by app/layout.tsx via headers().get())
  //   - the response Content-Security-Policy (the enforcing header)
  const nonce = isMachinePath ? null : generateNonce();
  const csp = nonce ? buildCsp(nonce) : null;
  const stampCsp = (res: NextResponse): NextResponse => {
    if (csp) res.headers.set("Content-Security-Policy", csp);
    return res;
  };
  const passthroughPage = (): NextResponse => {
    if (!nonce || !csp) return NextResponse.next();
    const reqHeaders = new Headers(req.headers);
    reqHeaders.set("x-nonce", nonce);
    // Next.js looks for `Content-Security-Policy` on the REQUEST headers; when
    // present, it auto-applies the nonce to its hydration / chunk-loader
    // inline scripts. Without this the framework's own scripts would be
    // blocked by `script-src 'nonce-X' 'strict-dynamic'`.
    reqHeaders.set("Content-Security-Policy", csp);
    const res = NextResponse.next({ request: { headers: reqHeaders } });
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  // Block Better Auth's public credential endpoints. They're mounted by the
  // catch-all in app/api/auth/[...all]/route.ts but our login/register/invite
  // flows use server actions that go through `signInWithCredentials` instead.
  // The wrapper layers lockout (5 fails / 15 min per account) and the
  // `deactivatedAt` check; calling Better Auth's HTTP endpoints directly
  // bypasses both, so a deactivated user could log right back in and an
  // attacker could brute-force passwords without ever tripping the lockout.
  // The IP-based rate limit below isn't a substitute — it's per-IP, not
  // per-account, and a botnet defeats it.
  if (
    req.method === "POST" &&
    (pathname === "/api/auth/sign-in/email" || pathname === "/api/auth/sign-up/email")
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (req.method === "POST" && pathname in RATE_LIMITED_POSTS) {
    const ip = clientIp(req);
    // Security-sensitive path: if we cannot identify the client IP, fail
    // closed rather than bucket every unknown caller together (which would
    // let one bad actor exhaust the bucket and DoS legitimate logins).
    if (pathname === "/login" && ip === "unknown") {
      return NextResponse.json(
        { error: "could not identify client; refusing login" },
        { status: 400 },
      );
    }
    const limit = RATE_LIMITED_POSTS[pathname]!;
    const window =
      pathname === "/login" ? LOGIN_RATE_WINDOW_MS : RATE_WINDOW_MS;
    const { ok, retryAfter } = rateLimit(`${pathname}:${ip}`, limit, window);
    if (!ok) {
      return NextResponse.json(
        { error: "too many requests, slow down" },
        { status: 429, headers: { "retry-after": String(retryAfter) } },
      );
    }
  }

  // Per-IP cap on the unauthenticated invite-lookup GET. Token entropy
  // makes brute force infeasible (128 bits) but the lookup is the easiest
  // path to enumerate / fingerprint, so cap volume.
  if (req.method === "GET" && pathname.startsWith("/api/invites/")) {
    const { ok, retryAfter } = rateLimit(
      `invite-lookup:${clientIp(req)}`,
      INVITE_LOOKUP_RATE_LIMIT,
      INVITE_LOOKUP_RATE_WINDOW_MS,
    );
    if (!ok) {
      return NextResponse.json(
        { error: "too many requests, slow down" },
        { status: 429, headers: { "retry-after": String(retryAfter) } },
      );
    }
  }

  // Catch-all for the Better Auth endpoints we don't explicitly block above.
  // /api/auth/sign-in/email and /sign-up/email are 404'd outright; everything
  // else (forget-password, reset-password, verify-email, etc.) gets a per-IP
  // rate limit so email-spray attacks land in 429s. This is defense in depth
  // — even when those flows aren't enabled today, leaving them unrate-limited
  // is a latent footgun if the feature gets flipped on later.
  if (req.method === "POST" && pathname.startsWith("/api/auth/")) {
    const { ok, retryAfter } = rateLimit(
      `auth-misc:${clientIp(req)}`,
      30,
      RATE_WINDOW_MS,
    );
    if (!ok) {
      return NextResponse.json(
        { error: "too many requests, slow down" },
        { status: 429, headers: { "retry-after": String(retryAfter) } },
      );
    }
  }

  const isPublicPage =
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/logout" ||
    pathname.startsWith("/invite/");
  const isPublicApi =
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/webhooks") ||
    // Canonical post-migration webhook path on NestJS. Prod fronts both
    // processes with Caddy which never sends `/webhooks/*` to Next.js,
    // so in prod this branch is unreachable; in no-Caddy dev (ngrok →
    // :3000) the middleware would otherwise 307 Meta's POST to /login.
    pathname.startsWith("/webhooks/") ||
    // Internal-only cache-bust endpoint called by NestJS via shared
    // secret. The route handler does its own timing-safe check.
    pathname.startsWith("/api/internal/") ||
    pathname.startsWith("/api/socket") ||
    pathname === "/api/health" ||
    // External API uses bearer-token auth (TeamApiKey), not session cookies —
    // bypass the cookie gate so n8n / partner integrations can reach it. The
    // NestJS ApiKeyGuard (apps/api/src/auth/api-key.guard.ts) does the auth.
    pathname.startsWith("/api/external/");

  // Cookie presence + signature check. Returns null for missing or tampered
  // cookies, the cookie value otherwise. Does NOT verify the session row
  // exists in the DB — that's the route handler's job.
  //
  // cookiePrefix MUST match `advanced.cookiePrefix` in the shared Better
  // Auth config. Imported from `@ccp/shared` so we have one source of truth
  // — hardcoding "ccp" here previously meant a future rename would silently
  // bounce every signed-in user back to /login because the gate looked
  // for a cookie name nothing actually sets.
  const sessionCookie = getSessionCookie(req, { cookiePrefix: COOKIE_PREFIX });
  const hasCookie = Boolean(sessionCookie);

  // Base for absolute redirects. Behind our Caddy → Node setup, `req.url`
  // can fall back to the server's listening address (0.0.0.0:3000) when
  // building the Location header, which the browser then can't reach.
  // BETTER_AUTH_URL is `prodRequired` (lib/env.ts), so in prod we always
  // have the canonical public origin to anchor redirects against.
  const redirectBase = process.env.BETTER_AUTH_URL || new URL(req.url).origin;

  if (isPublicPage || isPublicApi) {
    // Bonus: if a signed-in user hits /login or /register, bounce them home.
    // The DB recheck on /inbox will catch the stale-cookie case if any.
    if (hasCookie && (pathname === "/login" || pathname === "/register")) {
      return stampCsp(NextResponse.redirect(new URL("/inbox", redirectBase)));
    }
    return isMachinePath ? NextResponse.next() : passthroughPage();
  }

  if (!hasCookie) {
    if (isApiPath) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL("/login", redirectBase);
    url.searchParams.set("next", pathname + search);
    return stampCsp(NextResponse.redirect(url));
  }

  return isMachinePath ? NextResponse.next() : passthroughPage();
}

export const config = {
  // Match everything except Next internals and static assets. The handler
  // above does the fine-grained allow/deny.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
