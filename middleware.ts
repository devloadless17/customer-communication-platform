import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);

/**
 * Route gate. Anything matched by `config.matcher` runs through here.
 *
 * Allowlist (no auth required):
 *   - /login                 — the sign-in page itself
 *   - /api/auth/*            — NextAuth's own endpoints
 *   - /api/webhooks/*        — Meta posts here unauthenticated; verified by HMAC
 *   - /api/socket            — Socket.io handshake (separately authenticated)
 *
 * Everything else requires a session. Unauthenticated requests to a page get
 * redirected to /login?next=<path>; API requests get a JSON 401 so client
 * fetches don't accidentally render an HTML login page.
 */
export default auth((req) => {
  const { pathname, search } = req.nextUrl;

  const isPublicPage =
    pathname === "/login" ||
    pathname === "/register" ||
    pathname.startsWith("/invite/");
  const isPublicApi =
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/webhooks") ||
    pathname.startsWith("/api/socket") ||
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
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

export const config = {
  // Match everything except Next internals and static assets. The handler
  // above does the fine-grained allow/deny.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
