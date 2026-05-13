/**
 * Minimal in-process fixed-window rate limiter.
 *
 * Keyed by an arbitrary string (we use `route:ip`). Single instance only —
 * the counter lives in this process's memory, which is correct for the MVP's
 * one-VPS deployment. When a second app instance shows up this moves to Redis
 * alongside the Socket.io adapter (the planned trigger for adding Redis).
 *
 * Deliberately not `server-only`: imported from middleware, which runs in the
 * Edge runtime where module-level state still persists per isolate.
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
 * Counts EVERY call, so it's right for things like "max N requests per
 * IP". For "max N FAILED attempts on this account" use the lockout pair
 * (`isLockedOut` + `recordFailure` + `clearFailures`) instead — those only
 * count failures, so a legit user with the wrong password once doesn't lock
 * themselves out by retrying successfully.
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

/**
 * Account-level lockout. Used by the Credentials authorize() to block further
 * password tries after N failures on the same email — defends against
 * distributed credential stuffing (many IPs, one account) that the IP-based
 * limiter in middleware can't catch.
 *
 * Pattern:
 *   if (isLockedOut(key, 5)) return null;
 *   const ok = await verifyPassword(...);
 *   if (!ok) { recordFailure(key, 15 * 60_000); return null; }
 *   clearFailures(key);
 */
export function isLockedOut(key: string, limit: number): boolean {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= Date.now()) return false;
  return bucket.count >= limit;
}

export function recordFailure(key: string, windowMs: number): void {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  existing.count += 1;
}

export function clearFailures(key: string): void {
  buckets.delete(key);
}
