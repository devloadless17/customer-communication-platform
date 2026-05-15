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
  // Derive base URL from the request so we work behind any proxy / domain
  // without needing BETTER_AUTH_URL set just for this redirect.
  await auth.api.signOut({ headers: req.headers });
  return NextResponse.redirect(new URL("/login", req.url));
}

export { handler as GET, handler as POST };
