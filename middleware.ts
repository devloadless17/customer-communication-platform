import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import { authConfig } from "@/lib/auth.config";
import { rateLimit } from "@/lib/rate-limit";

const { auth } = NextAuth(authConfig);

/**
 * Unauthenticated POSTs worth throttling against credential stuffing / signup
 * abuse: a per-IP allowance over a 10-minute fixed window. GETs are never
 * limited — NextAuth polls `/api/auth/session` constantly.
 */
const RATE_LIMITED_POSTS: Record<string, number> = {
  "/api/auth/callback/credentials": 20, // login attempts
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

function clientIp(req: Request & { ip?: string }): string {
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
  // address. NextRequest exposes this; in environments where it's missing,
  // everything collapses to one bucket, which keeps the limiter conservative
  // rather than completely defeated.
  return req.ip ?? "unknown";
}

/**
 * Route gate. Anything matched by `config.matcher` runs through here.
 *
 * Allowlist (no auth required):
 *   - /login                 — the sign-in page itself
 *   - /api/auth/*            — NextAuth's own endpoints
 *   - /api/webhooks/*        — Meta posts here unauthenticated; verified by HMAC
 *   - /api/socket            — Socket.io handshake (separately authenticated)
 *   - /api/health            — Caddy / systemd liveness probes; no privileged data
 *
 * Everything else requires a session. Unauthenticated requests to a page get
 * redirected to /login?next=<path>; API requests get a JSON 401 so client
 * fetches don't accidentally render an HTML login page.
 */
export default auth((req) => {
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
    pathname.startsWith("/invite/");
  const isPublicApi =
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/webhooks") ||
    pathname.startsWith("/api/socket") ||
    pathname === "/api/health" ||
    // External API uses bearer-token auth (TeamApiKey), not session cookies —
    // bypass the cookie gate so n8n / partner integrations can reach it. The
    // route handler does its own authentication via lib/external-auth.ts.
    pathname.startsWith("/api/external/") ||
    // Server actions for registration / invite acceptance run as POSTs to
    // these page routes; auth() returns null until the action signs the user
    // in, so the request must be allowed through unauth'd.
    pathname === "/register" ||
    pathname.startsWith("/invite/");

  if (isPublicPage || isPublicApi) {
    // Bonus: if a signed-in user hits /login or /register, bounce them home.
    if (req.auth && (pathname === "/login" || pathname === "/register")) {
      return NextResponse.redirect(new URL("/inbox", req.url));
    }
    return NextResponse.next();
  }

  if (!req.auth) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname + search);
    const res = NextResponse.redirect(url);
    // Defensive: clear any auth cookies on the way to /login. A stale or
    // unverifiable session cookie (e.g. from an AUTH_SECRET rotation, or
    // from an old session-shape that the middleware reads but the server
    // component rejects) can otherwise drive an infinite redirect loop —
    // middleware sees "looks valid", page bounces, repeat.
    const isProd = process.env.NODE_ENV === "production";
    const names = isProd
      ? ["__Secure-authjs.session-token", "__Secure-authjs.callback-url", "__Host-authjs.csrf-token"]
      : ["authjs.session-token", "authjs.callback-url", "authjs.csrf-token"];
    // Use the descriptor form so the Set-Cookie deletion replays Secure +
    // Path=/. __Host- / __Secure- prefixed cookies are silently NOT deleted
    // by Chrome unless the deletion Set-Cookie itself satisfies the prefix
    // rules (Secure required, Path=/, no Domain).
    for (const n of names) res.cookies.delete({ name: n, path: "/", secure: isProd });
    return res;
  }

  return NextResponse.next();
});

export const config = {
  // Match everything except Next internals and static assets. The handler
  // above does the fine-grained allow/deny.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
