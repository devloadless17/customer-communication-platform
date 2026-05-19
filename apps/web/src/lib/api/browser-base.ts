/**
 * Single source of truth for the BROWSER's API target.
 *
 *   - dev (cross-port):   NEXT_PUBLIC_API_URL=http://localhost:4000
 *                         → absolute URLs hit the NestJS api directly
 *   - prod (same-origin): unset (or empty) → Caddy fronts both processes
 *                         on one host, relative URLs work via the proxy
 *
 * Trimmed and exported once so socket-client + apiFetch + any future
 * absolute-URL caller can't disagree. RSC/server code uses
 * `INTERNAL_API_URL` instead (see lib/api-client.ts) — that's the
 * inside-the-network loopback path, not this one.
 */
export const BROWSER_API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").trim();
