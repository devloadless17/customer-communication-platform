import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { auth } from "@/lib/auth/better-auth";

/**
 * Cookie-clearing logout endpoint. Used by:
 *   - Server components in lib/auth/current-user.ts when they detect a
 *     stale session row (server components can't mutate cookies, so they
 *     redirect here)
 *   - Anywhere a GET-based logout link is preferable to the server-action
 *     signOutAction (older browsers, fallback paths)
 *
 * Browser-side signout from React components should still go through
 * `signOutAction` in lib/auth/actions.ts (POST server action, plays nicely
 * with the sidebar's "close socket then sign out" sequence). This route is
 * the lower-level escape hatch.
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
