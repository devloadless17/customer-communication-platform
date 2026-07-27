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
 * This edge check tests only for the session cookie's PRESENCE —
 * `getSessionCookie` reads the cookie value; it does NOT verify Better Auth's
 * signature. So a forged/tampered cookie (or one that points at a deleted/
 * expired session row) PASSES here and is rejected downstream: the route
 * handler (`requireSession` for APIs, `getSession` for pages) does the
 * authoritative DB recheck and returns 401 / redirects through /logout. That's
 * the right division of work: cheap presence gate at the edge, authoritative
 * validation in the handler.
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
  // Each request here can SEND AN EMAIL against a 300/day quota, from an
  // endpoint that takes an arbitrary address and needs no session. Unlimited,
  // it is both a free mail cannon aimed at third parties and a way to burn the
  // day's sends. 5 covers a genuine typo-and-retry; nothing legitimate needs
  // more.
  "/forgot-password": 5,
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
    // All media (image/video/audio/documents/avatars) is streamed SAME-ORIGIN
    // through /api/media/* + the avatar/team-chat routes — the browser never
    // touches the R2 host directly (the bucket is private). So `'self'` is all
    // <video>/<audio> need; `blob:` covers optimistic local previews.
    "media-src 'self' blob:",
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

/**
 * Request-correlation id for the whole edge→web→api request tree. We mint one
 * here (or adopt a plausible inbound one) and stamp it on BOTH the request
 * headers — so RSC code can read it via `headers().get("x-request-id")` and
 * forward it on its NestJS fan-out fetches — and the response. NestJS's
 * correlation middleware then ADOPTS this id instead of generating a fresh one
 * per fetch, so all ~8 parallel RSC calls behind a single page load share one
 * correlation id, traceable back to the originating browser request.
 *
 * The accepted shape must match NestJS's `REQUEST_ID_PATTERN`
 * (`/^[A-Za-z0-9_-]{8,64}$/`, see apps/api/src/common/correlation.ts) — a UUID
 * qualifies, and a non-conforming inbound value is dropped in favour of a fresh
 * UUID so a malformed client header can't poison the trace id.
 */
const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function resolveRequestId(req: NextRequest): string {
  const inbound = req.headers.get(REQUEST_ID_HEADER);
  if (inbound && REQUEST_ID_PATTERN.test(inbound)) return inbound;
  return crypto.randomUUID();
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
 *   - /docs/*                — public API reference (no privileged data)
 *   - /api/auth/*            — Better Auth's own endpoints
 *   - /api/webhooks/*        — Meta posts here unauthenticated; verified by HMAC
 *   - /api/socket            — Socket.io handshake (separately authenticated)
 *   - /api/health*           — Caddy / Docker / monitor liveness probes
 *                              (deep /api/health AND shallow /api/health/web);
 *                              no privileged data
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

  // One correlation id for the whole request tree. Stamped on the response of
  // EVERY branch (browser-visible) and, for page passthroughs, on the REQUEST
  // headers so RSC code (api-client.ts) can forward it on its NestJS fan-out.
  const requestId = resolveRequestId(req);
  const stampResponse = (res: NextResponse): NextResponse => {
    if (csp) res.headers.set("Content-Security-Policy", csp);
    res.headers.set(REQUEST_ID_HEADER, requestId);
    return res;
  };
  const passthroughPage = (): NextResponse => {
    const reqHeaders = new Headers(req.headers);
    reqHeaders.set(REQUEST_ID_HEADER, requestId);
    if (nonce && csp) {
      reqHeaders.set("x-nonce", nonce);
      // Next.js looks for `Content-Security-Policy` on the REQUEST headers; when
      // present, it auto-applies the nonce to its hydration / chunk-loader
      // inline scripts. Without this the framework's own scripts would be
      // blocked by `script-src 'nonce-X' 'strict-dynamic'`.
      reqHeaders.set("Content-Security-Policy", csp);
    }
    const res = NextResponse.next({ request: { headers: reqHeaders } });
    if (csp) res.headers.set("Content-Security-Policy", csp);
    res.headers.set(REQUEST_ID_HEADER, requestId);
    return res;
  };
  // Machine paths (API / webhook) skip the CSP nonce but still carry the
  // correlation id on the forwarded request (read by the legacy Meta webhook
  // proxy + the web-side API routes) and the response.
  const passthroughMachine = (): NextResponse => {
    const reqHeaders = new Headers(req.headers);
    reqHeaders.set(REQUEST_ID_HEADER, requestId);
    const res = NextResponse.next({ request: { headers: reqHeaders } });
    res.headers.set(REQUEST_ID_HEADER, requestId);
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
  //
  // `sign-in/email-otp` is blocked for the same reason: this app has no
  // passwordless sign-in flow (OTP is used only for email verification and
  // password reset, both via server-side `auth.api.*` calls that never touch
  // this proxy), but the plugin ships the route enabled — it would let an
  // existing user authenticate with a mailed code, skipping the lockout and
  // deactivation pre-checks the wrapper owns. `disableSignUp: true` in
  // better-auth.ts closes the account-creation half; this closes the rest.
  if (
    req.method === "POST" &&
    (pathname === "/api/auth/sign-in/email" ||
      pathname === "/api/auth/sign-up/email" ||
      pathname === "/api/auth/sign-in/email-otp")
  ) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (req.method === "POST" && pathname in RATE_LIMITED_POSTS) {
    const ip = clientIp(req);
    // Security-sensitive path: if we cannot identify the client IP, fail
    // closed rather than bucket every unknown caller together (which would
    // let one bad actor exhaust the bucket and DoS legitimate logins).
    if (pathname === "/login" && ip === "unknown") {
      return NextResponse.json(
        { error: "client_unidentified" },
        { status: 400 },
      );
    }
    const limit = RATE_LIMITED_POSTS[pathname]!;
    const window =
      pathname === "/login" ? LOGIN_RATE_WINDOW_MS : RATE_WINDOW_MS;
    const { ok, retryAfter } = rateLimit(`${pathname}:${ip}`, limit, window);
    if (!ok) {
      return NextResponse.json(
        { error: "rate_limited" },
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
        { error: "rate_limited" },
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
        { error: "rate_limited" },
        { status: 429, headers: { "retry-after": String(retryAfter) } },
      );
    }
  }

  const isPublicPage =
    pathname === "/login" ||
    pathname === "/register" ||
    // Password recovery is BY DEFINITION unauthenticated — someone who can't
    // sign in cannot have a cookie. Without this the gate 307s them to /login,
    // which is the exact screen they're stuck on.
    pathname === "/forgot-password" ||
    pathname === "/logout" ||
    pathname.startsWith("/invite/") ||
    // API reference is deliberately public — it renders only static reference
    // content (no getSession, no privileged data) so prospective partners can
    // read it before signing up. Without this the cookie gate 307s them to
    // /login, contradicting the page's stated intent.
    pathname.startsWith("/docs");
  const isPublicApi =
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/webhooks") ||
    // Canonical post-migration webhook path on NestJS. Prod fronts both
    // processes with Caddy which never sends `/webhooks/*` to Next.js,
    // so in prod this branch is unreachable; in no-Caddy dev (ngrok →
    // :3000) the middleware would otherwise 307 Meta's POST to /login.
    pathname.startsWith("/webhooks/") ||
    pathname.startsWith("/api/socket") ||
    // Liveness probes — `startsWith`, NOT `=== "/api/health"`. The SHALLOW
    // web probe `/api/health/web` (what Caddy's web-upstream `health_uri`
    // hits every 2s) lives under this prefix. An exact match left it gated,
    // so the cookie-less probe got a 401, Caddy marked the ONLY web upstream
    // down, and every page 503'd — while `/api/health` (matched exactly)
    // still passed and the deploy's health gate stayed green. No health
    // response carries privileged data, so the prefix is safe. Keep this in
    // sync with the Caddyfile web-block `health_uri` (deploy/Caddyfile.template).
    pathname.startsWith("/api/health") ||
    // External API uses bearer-token auth (WorkspaceApiKey), not session cookies —
    // bypass the cookie gate so n8n / partner integrations can reach it. The
    // NestJS ApiKeyGuard (apps/api/src/auth/api-key.guard.ts) does the auth.
    pathname.startsWith("/api/external/");

  // Cookie PRESENCE check only. Returns null for a missing cookie, the cookie
  // value otherwise — it does NOT verify the cookie's signature, nor that the
  // session row exists in the DB. Both of those are the route handler's job
  // (authoritative DB recheck). A forged/tampered cookie passes here and is
  // rejected downstream.
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
  // BETTER_AUTH_URL is validated as required in prod by instrumentation.ts
  // (the boot hook that replaced lib/env.ts + server.ts), so in prod we always
  // have the canonical public origin to anchor redirects against.
  const redirectBase = process.env.BETTER_AUTH_URL || new URL(req.url).origin;

  if (isPublicPage || isPublicApi) {
    // Bonus: if a signed-in user hits /login or /register, bounce them home.
    // The DB recheck on /inbox will catch the stale-cookie case if any.
    if (hasCookie && (pathname === "/login" || pathname === "/register")) {
      return stampResponse(NextResponse.redirect(new URL("/inbox", redirectBase)));
    }
    return isMachinePath ? passthroughMachine() : passthroughPage();
  }

  if (!hasCookie) {
    if (isApiPath) {
      return stampResponse(
        NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      );
    }
    const url = new URL("/login", redirectBase);
    url.searchParams.set("next", pathname + search);
    return stampResponse(NextResponse.redirect(url));
  }

  return isMachinePath ? passthroughMachine() : passthroughPage();
}

export const config = {
  // Match everything except Next internals and static assets. The handler
  // above does the fine-grained allow/deny.
  //
  // `.*\.[\w]+$` excludes only paths ENDING in a file extension (real static
  // assets: .png/.css/.js/.woff2/…). The prior `.*\..*` excluded any path with
  // a dot ANYWHERE, so a legit app route carrying a dot mid-path (e.g. an email
  // in a segment) silently bypassed BOTH the session-cookie gate and the CSP
  // header. App routes don't end in a dotted extension, so this keeps assets
  // excluded while gating those dotted routes.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
