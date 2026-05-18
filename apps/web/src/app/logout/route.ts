import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { auth } from "@/lib/auth/better-auth";

/**
 * Cookie-clearing logout endpoint. The canonical sign-out path — every
 * caller (sidebar menus, stale-session redirects from server components,
 * error pages) navigates here via a hard browser navigation.
 *
 * Why a route handler instead of a server action:
 *   - Callable by a plain anchor (sidebar menu), a form submit, AND a
 *     `redirect("/logout")` from RSC / api-client — a server action can't
 *     serve all three.
 *   - Pairing a Better Auth cookie mutation with `redirect()` inside a
 *     server action has produced "An unexpected response was received from
 *     the server" in this codebase before (see [hooks/use-auth-redirect.tsx]
 *     for the same root cause on the sign-in side). A route handler's
 *     standard 302 + Set-Cookie response is what the browser understands
 *     natively, with no Next-client parsing involved.
 *
 * Both GET and POST so a plain anchor tag works AND a form submit works.
 */

export const runtime = "nodejs";

// Better Auth cookies. Names mirror `COOKIE_PREFIX` + Better Auth's defaults.
// `__Secure-` prefix only appears when `useSecureCookies` is on (prod). We
// clear both variants on every logout because we can't be sure which one
// the browser is holding (a tab opened before isProd flipped, a misconfig
// in dev, etc.) — extra Set-Cookie headers for absent cookies are harmless.
const SESSION_COOKIE_NAMES = [
  "ccp.session_token",
  "ccp.session_data",
  "ccp.dont_remember",
  "__Secure-ccp.session_token",
  "__Secure-ccp.session_data",
  "__Secure-ccp.dont_remember",
] as const;

async function handler(req: NextRequest) {
  // signOut deletes the Session DB row and tries to clear cookies via
  // nextCookies()'s `cookies().delete(...)`. Best-effort — if the cookie
  // is malformed / unrecognised, signOut silently no-ops, which is how
  // the redirect loop crept in (DB row gone in some flows, but cookie
  // not cleared on the wire). The explicit `response.cookies.delete`
  // calls below are the load-bearing part.
  try {
    await auth.api.signOut({ headers: req.headers });
  } catch {
    // Stale / missing session: nothing to sign out from the DB side, but
    // we still need to clear the browser's cookie below.
  }

  // Use BETTER_AUTH_URL when set (always in prod — see lib/env.ts) instead
  // of req.url. Next's `request.url` behind our Caddy → Node hop falls back
  // to the server's listening address (0.0.0.0:3000) for Location-header
  // redirects, so without this the Location ends up at
  // https://0.0.0.0:3000/login and the browser bounces to "site can't be
  // reached." Sticking to the canonical public origin is the only safe
  // base for absolute redirects from a route handler.
  const base = process.env.BETTER_AUTH_URL || new URL(req.url).origin;
  const response = NextResponse.redirect(new URL("/login", base));

  // Belt-and-suspenders: clear every known Better Auth cookie on the
  // response itself. Without this, a stale-session redirect chain
  // (/inbox → /logout → /login → middleware sees cookie → /inbox → …)
  // loops forever because signOut silently no-op'd.
  for (const name of SESSION_COOKIE_NAMES) {
    response.cookies.delete(name);
  }
  return response;
}

export { handler as GET, handler as POST };
