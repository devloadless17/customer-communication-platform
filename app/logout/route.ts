import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { auth } from "@/lib/auth/better-auth";

/**
 * Cookie-clearing logout endpoint. The canonical sign-out path — every
 * caller (sidebar menus, stale-session redirects from server components,
 * error pages) navigates here via a hard browser navigation.
 *
 * Why not a server action: pairing a Better Auth cookie mutation with
 * `redirect()` inside a server action can intermittently produce "An
 * unexpected response was received from the server" in Next 15's client
 * runtime (same race that broke /login?next=/). A route handler runs as
 * a normal HTTP request — its 302 + Set-Cookie response is what the
 * browser understands natively, with no Next-client parsing involved.
 *
 * Both GET and POST so a plain anchor tag works AND a form submit works.
 */

export const runtime = "nodejs";

async function handler(req: NextRequest) {
  await auth.api.signOut({ headers: req.headers });
  // Use BETTER_AUTH_URL when set (always in prod — see lib/env.ts) instead
  // of req.url. Next's `request.url` behind our Caddy → Node hop falls back
  // to the server's listening address (0.0.0.0:3000) for Location-header
  // redirects, so without this the Location ends up at
  // https://0.0.0.0:3000/login and the browser bounces to "site can't be
  // reached." Sticking to the canonical public origin is the only safe
  // base for absolute redirects from a route handler.
  const base = process.env.BETTER_AUTH_URL || new URL(req.url).origin;
  return NextResponse.redirect(new URL("/login", base));
}

export { handler as GET, handler as POST };
