/**
 * Minimal in-process fixed-window rate limiter for IP-based gates.
 *
 * Keyed by an arbitrary string (we use `route:ip`). Single instance only —
 * the counter lives in this process's memory, which is correct for the MVP's
 * one-VPS deployment. When a second app instance shows up this moves to Redis
 * alongside the Socket.io adapter (the planned trigger for adding Redis).
 *
 * Deliberately not `server-only`: imported from proxy.ts, which runs in the
 * Edge runtime where module-level state still persists per isolate.
 *
 * Account-level lockout used to live here too; it moved to
 * `lib/auth/lockout.ts` (DB-backed, server-only) so it survives process
 * restarts. This file is now strictly IP rate limiting.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Opportunistic GC so a long-lived process doesn't accumulate dead keys —
// cheap because it only runs when the map is already large.
function sweep(now: number): void {
  if (buckets.size < 5000) return;
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (only meaningful when `ok` is false). */
  retryAfter: number;
}

/**
 * Returns `{ ok: false }` once `limit` hits land within `windowMs` for the
 * same key. The window is fixed (resets `windowMs` after the first hit), not
 * sliding — good enough to blunt credential stuffing without the bookkeeping
 * of a token bucket.
 *
 * Counts EVERY call, so it's right for things like "max N requests per IP".
 * For per-account "max N FAILED attempts" semantics use the DB-backed
 * lockout in `lib/auth/lockout.ts`.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return { ok: false, retryAfter: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}
