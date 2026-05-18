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
 */

let redirecting = false;

/**
 * Trip the redirect once. Multiple racy callers (e.g. several in-flight
 * fetches all failing on the same expired session) collapse to one
 * window.location replace.
 */
export function handleSessionExpired(): void {
  if (typeof window === "undefined") return;
  if (redirecting) return;
  redirecting = true;
  const next = window.location.pathname + window.location.search;
  window.location.replace(`/login?next=${encodeURIComponent(next)}`);
}

/**
 * Drop-in replacement for `fetch` that redirects to /login on 401 instead
 * of returning the response. Other status codes pass through unchanged so
 * existing per-call error handling still works.
 */
export async function fetchWithSessionGuard(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    handleSessionExpired();
    // The redirect is async — throw so the caller doesn't try to parse the
    // 401 body as if it were valid data. Any unhandled rejection on the way
    // out is moot; we're navigating away.
    throw new Error("session expired");
  }
  return res;
}
