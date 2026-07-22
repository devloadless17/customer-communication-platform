"use client";

import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";

import { BROWSER_API_BASE } from "./browser-base";

/**
 * Centralized client-side fetch.
 *
 * Three things every browser → api call should do, packaged into one place:
 *
 *   1. Prepend BROWSER_API_BASE for absolute targeting in dev (where Next.js
 *      and NestJS run on different ports). Empty base → relative URL stays
 *      relative, which is what prod (Caddy fronts both) wants.
 *   2. Forward the Better Auth session cookie via `credentials: "include"`.
 *      Default is "same-origin" — fine for relative URLs in prod, but in
 *      dev the absolute URL crosses :3000 → :4000 and the cookie gets
 *      dropped silently. Include works in both topologies.
 *   3. Route 401s through the existing session-expiry guard, which
 *      navigates the tab to /logout (clears the stale cookie) before
 *      bouncing to /login. Skipping this gives you a stale-session
 *      cascade of blank panels.
 *
 * Use for NEW client mutations and for any absolute-URL call. Existing
 * relative-URL fetches still work as-is (same-origin → cookies travel);
 * migrate them opportunistically, not in a big bang.
 *
 * Deliberately thin. Returns `Response` so callers do their own
 * res.ok / res.json() parsing — no auto-JSON, no retries, no
 * interceptors. Add those at the call-site when they actually help, not
 * here in the wrapper where they'd hide failures.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${BROWSER_API_BASE}${path}`;
  return fetchWithSessionGuard(url, {
    ...init,
    headers: withJsonContentType(init),
    credentials: init.credentials ?? "include",
  });
}

/**
 * Default `content-type: application/json` when the caller sends a string body
 * and hasn't set one.
 *
 * This is defaulted HERE, not left to each call site, because forgetting it
 * fails in the most confusing way possible: Express's `express.json()` skips a
 * body with no JSON content-type, so the route receives `{}`, the Zod pipe
 * rejects it, and the caller gets a 400 for a request that looks perfectly
 * correct in the network tab. The workspace switcher shipped with exactly that
 * bug — clicking a workspace did nothing at all.
 *
 * Only string bodies get it. FormData (file uploads) MUST keep the browser's
 * generated `multipart/form-data; boundary=…`; setting a content-type there
 * would strip the boundary and corrupt every upload.
 */
function withJsonContentType(init: RequestInit): HeadersInit | undefined {
  const body = init.body;
  if (typeof body !== "string") return init.headers;
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}
