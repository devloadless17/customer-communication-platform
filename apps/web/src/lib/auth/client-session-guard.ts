/**
 * Client-side session expiry guard.
 *
 * Better Auth sessions can expire mid-session — laptop closed overnight,
 * cookie cleared, server-side invalidation. When that happens, every fetch
 * starts coming back 401 and the UI silently fails (failed sends, blank
 * panels, etc.) with no indication of why. This guard handles that path:
 * the first 401 from a guarded fetch redirects the tab to /login?next=<url>,
 * skipping the failure cascade.
 *
 * Use sparingly — only on inbox-critical reads. We don't want a transient
 * 401 from a misbehaving endpoint to nuke a half-typed draft. The user-
 * action paths (send, mark-read) keep their existing error handling so a
 * truly transient 401 surfaces as "couldn't send, retry" instead of a
 * forced logout.
 *
 * Deliberately does NOT broadcast on the auth-channel: a 401 means THIS
 * tab's session row is gone, not necessarily every sibling tab's. The
 * canonical case is change-password — it deletes every Session row EXCEPT
 * the current one, so the user stays signed in on the tab they typed the
 * password into. Broadcasting from here would kick that tab too. Cross-tab
 * signal lives on the explicit signout paths instead.
 */

let redirecting = false;

/**
 * Trip the redirect once. Multiple racy callers (e.g. several in-flight
 * fetches all failing on the same expired session) collapse to one
 * window.location replace.
 *
 * Routes to /logout, NOT /login. The 401 happens when the Session row is
 * gone but the cookie is still in the browser — going straight to /login
 * lets the edge proxy see `hasCookie=true` and bounce to /inbox, which
 * 401s again, in a loop that needs /logout to break. Going to /logout
 * first clears the cookie cleanly, then forwards to /login with `?next=`
 * preserved.
 */
export function handleSessionExpired(): void {
  if (typeof window === "undefined") return;
  if (redirecting) return;
  redirecting = true;
  const next = window.location.pathname + window.location.search;
  window.location.replace(`/logout?next=${encodeURIComponent(next)}`);
}

/**
 * Confirms whether the Better Auth session is actually gone before we
 * nuke the cookie. Hits `/api/auth/get-session` which is served by the
 * Next.js process directly (Better Auth catch-all) — so even when the
 * NestJS upstream is restarting and returning 401s, this endpoint stays
 * authoritative against the Session table via Prisma.
 *
 * Short cache + in-flight coalescing because a NestJS restart fires
 * 401s from every active polling hook (counts, channel events, thread
 * events, search) inside the same ~3s window — without coalescing we'd
 * hammer Better Auth N times for the same answer.
 */
const SESSION_RECHECK_TTL_MS = 5_000;
let lastValidatedAt = 0;
let inFlight: Promise<boolean> | null = null;

async function isSessionStillValid(): Promise<boolean> {
  if (Date.now() - lastValidatedAt < SESSION_RECHECK_TTL_MS) return true;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/api/auth/get-session", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as { user?: unknown } | null;
      const alive = Boolean(data && data.user);
      if (alive) lastValidatedAt = Date.now();
      return alive;
    } catch {
      // Network error fetching the session check itself — be conservative
      // and assume alive. Worst case the next poll cycle catches the real
      // expiry; nuking the cookie on a network blip is the failure mode
      // this whole helper exists to prevent.
      return true;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Drop-in replacement for `fetch` that redirects to /login on 401 instead
 * of returning the response. Other status codes pass through unchanged so
 * existing per-call error handling still works.
 *
 * Single 401 is NOT treated as proof of expiry — during a NestJS dev
 * restart (or any upstream blip) the SessionGuard transiently 401s for
 * a few seconds while Better Auth's DB pool warms. We re-verify against
 * Better Auth's own session endpoint (served by Next.js, independent of
 * the upstream) before wiping the cookie.
 */
export async function fetchWithSessionGuard(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    const stillAuthed = await isSessionStillValid();
    if (stillAuthed) {
      // Transient upstream 401 — session is alive on the cookie-issuing
      // side. Throw so callers' existing error paths fire (same shape as
      // a network blip); the next poll cycle will succeed once the
      // upstream recovers. Do NOT redirect to /logout here.
      throw new Error("transient upstream 401");
    }
    handleSessionExpired();
    // The redirect is async — throw so the caller doesn't try to parse the
    // 401 body as if it were valid data. Any unhandled rejection on the way
    // out is moot; we're navigating away.
    throw new Error("session expired");
  }
  return res;
}
