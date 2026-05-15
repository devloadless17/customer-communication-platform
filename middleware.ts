import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

import { rateLimit } from "@/lib/rate-limit";

/**
 * Edge middleware. Two jobs:
 *   1. Rate-limit the unauthenticated POSTs that get hammered (login + register)
 *   2. Gate every other route on session-cookie presence
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
  "/api/auth/sign-in/email": 20, // login attempts (Better Auth credential endpoint)
  "/login": 20, // login attempts via the server action
  "/register": 8, // account creation
};
const RATE_WINDOW_MS = 10 * 60 * 1000;

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
  // environments where it's missing, everything collapses to one bucket,
  // which keeps the limiter conservative rather than completely defeated.
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
export default function middleware(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;

  if (req.method === "POST" && pathname in RATE_LIMITED_POSTS) {
    const limit = RATE_LIMITED_POSTS[pathname]!;
    const { ok, retryAfter } = rateLimit(`${pathname}:${clientIp(req)}`, limit, RATE_WINDOW_MS);
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
    pathname.startsWith("/api/socket") ||
    pathname === "/api/health" ||
    // External API uses bearer-token auth (TeamApiKey), not session cookies —
    // bypass the cookie gate so n8n / partner integrations can reach it. The
    // route handler does its own authentication via lib/auth/external.ts.
    pathname.startsWith("/api/external/");

  // Cookie presence + signature check. Returns null for missing or tampered
  // cookies, the cookie value otherwise. Does NOT verify the session row
  // exists in the DB — that's the route handler's job.
  const sessionCookie = getSessionCookie(req);
  const hasCookie = Boolean(sessionCookie);

  if (isPublicPage || isPublicApi) {
    // Bonus: if a signed-in user hits /login or /register, bounce them home.
    // The DB recheck on /inbox will catch the stale-cookie case if any.
    if (hasCookie && (pathname === "/login" || pathname === "/register")) {
      return NextResponse.redirect(new URL("/inbox", req.url));
    }
    return NextResponse.next();
  }

  if (!hasCookie) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Match everything except Next internals and static assets. The handler
  // above does the fine-grained allow/deny.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
