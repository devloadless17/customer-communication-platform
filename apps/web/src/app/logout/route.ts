import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  cookieNameRequiresSecure,
  isOwnedCookieName,
  shouldIssueSecureCookies,
} from "@ccp/shared/auth/better-auth-config";

import { auth } from "@/lib/auth/better-auth";
import { db } from "@/lib/db";
import { fireSessionInvalidated } from "@/lib/auth/session-invalidation";

/**
 * Canonical sign-out exit. Every caller that needs to end a session hard-
 * navigates here. Steps:
 *
 *   1. Capture the userId + sessionId (before the Session row is deleted).
 *   2. `auth.api.signOut` — deletes the Session row. If it throws (DB flap),
 *      a fallback `Session.deleteMany({ id: sessionId })` runs so the row
 *      doesn't outlive the cookie clear — without it a stolen cookie kept
 *      working until session expiry.
 *   3. Clear every owned cookie on a fresh redirect response. Attributes
 *      must mirror how they were set: `Secure` for `__Secure-`/`__Host-`
 *      names, and for everything in prod. Without that the browser
 *      silently drops the clear and the cookie outlives sign-out.
 *   4. Tell NestJS to drop the user's sockets + session cache. Fire-and-
 *      forget; the 15s NestJS cache TTL is the fallback if the call fails.
 *   5. Redirect to `/login?next=<safe>` (forwarded from `?next=` if present).
 *
 * Both GET and POST so anchor clicks and form submits both work — GET is
 * also reachable from cross-origin `<img src>` / `<link href>`, which is a
 * classic CSRF logout vector. The Sec-Fetch-Site guard at the top of the
 * handler refuses cross-site GETs (`cross-site` / `same-site` from a
 * different domain) before any state change runs. Same-origin GETs (a
 * top-level navigation from our own login chain) keep working.
 */

export const runtime = "nodejs";

const IS_SECURE_COOKIE_MODE = shouldIssueSecureCookies();

function safeNext(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.startsWith("/_next/") || raw === "/logout") return null;
  return raw;
}

async function handler(req: NextRequest) {
  // CSRF guard: cross-origin GETs (typical of `<img src=/logout>` from a
  // hostile third-party page) MUST not log the user out. Top-level same-
  // origin navigations report `Sec-Fetch-Site: same-origin` (or `none` for
  // user-typed addresses / bookmarks). Cross-site requests report
  // `cross-site` or `same-site` (cousin subdomains). Refuse those silently.
  // Modern browsers (Chrome ≥76, Firefox ≥90, Safari ≥16.4) always set the
  // header; we treat missing as `none` (same-origin posture). POSTs are
  // also guarded — a CSRF token isn't strictly necessary here because the
  // owned cookies are `SameSite=Lax`, but a defense-in-depth check costs
  // nothing.
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return new NextResponse("forbidden", { status: 403 });
  }

  let userId: string | undefined;
  let sessionId: string | undefined;
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    userId = session?.user?.id;
    sessionId = session?.session?.id;
  } catch {
    // Stale cookie — nothing useful to invalidate. Cookie clear below still runs.
  }

  try {
    await auth.api.signOut({ headers: req.headers });
  } catch (err) {
    console.warn(
      `[logout] auth.api.signOut threw (cookie clear still runs): ${err instanceof Error ? err.message : err}`,
    );
  }
  // ALWAYS delete the Session row by id — not only on the catch path. Better
  // Auth's signOut is "best effort" on idempotent retry: if it decides the
  // session is already gone (e.g. a duplicate logout request) it silently
  // no-ops without throwing. The cookie is cleared below, but a stolen-
  // cookie attacker would keep working against the still-present DB Session
  // row until its 90-day expiry. Belt-and-suspenders: one extra cheap
  // delete on the happy path closes the gap permanently. Scoped to the
  // SPECIFIC sessionId so other devices aren't kicked.
  if (sessionId) {
    try {
      await db.session.deleteMany({ where: { id: sessionId } });
    } catch (fallbackErr) {
      console.warn(
        `[logout] DB session delete failed: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`,
      );
    }
  }

  const base = process.env.BETTER_AUTH_URL || new URL(req.url).origin;
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const loginUrl = new URL("/login", base);
  if (next) loginUrl.searchParams.set("next", next);
  // `?bc=1` tells the login page to fire a cross-tab signout broadcast on
  // mount. The rail button + team-settings deactivate paths already
  // broadcast BEFORE navigating here, but server-initiated entry points
  // (email "sign out" links, 401 → /logout redirect chains) need this flag
  // so sibling tabs don't keep stale session UI until their next interaction.
  // Change-password does NOT redirect through here — that tab keeps its
  // session — so this is safe to set on any real signout.
  if (userId) loginUrl.searchParams.set("bc", "1");
  const response = NextResponse.redirect(loginUrl);

  // Clear every owned cookie the browser actually sent. Self-maintaining:
  // any current or future Better Auth cookie (`session_token`, `session_data`,
  // `dont_remember`, additions in future versions) is caught by the prefix
  // match — no hardcoded list to drift.
  for (const c of req.cookies.getAll()) {
    if (!isOwnedCookieName(c.name)) continue;
    response.cookies.set({
      name: c.name,
      value: "",
      maxAge: 0,
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: cookieNameRequiresSecure(c.name) || IS_SECURE_COOKIE_MODE,
    });
  }

  if (userId) {
    void fireSessionInvalidated(userId, "signout");
  }

  return response;
}

export { handler as GET, handler as POST };
