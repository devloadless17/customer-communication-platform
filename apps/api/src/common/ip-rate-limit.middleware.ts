import type { Request, Response, NextFunction } from "express";

/**
 * Per-IP token bucket applied BEFORE the session guard. The session guard's
 * own bucket only fires once `req.session.userId` is set, which means a
 * hostile attacker hammering a session-guarded route with garbage cookies
 * pays the full Better Auth `getSession` cost per request without any
 * upstream brake. Without this middleware, that's a low-effort DoS:
 * Postgres pool starvation + Better Auth latency spike → every legitimate
 * request 503s.
 *
 * Numbers picked so legitimate browsers — which fire 10–20 parallel
 * requests on a cold cache — never trip, but a scripted attacker is bounded
 * at ~10 req/sec sustained from a single IP. Production sits behind Caddy,
 * so `req.ip` reflects the real client (we already set `trust proxy: 1`).
 *
 * Skips:
 *   - `/webhooks/*` — already covered by `WebhookRateLimitGuard`.
 *   - `/api/external/v1/*` — server-to-server, covered by `ApiKeyGuard`.
 *   - `/api/health` — must remain responsive for liveness probes.
 *   - `/api/socket/*` — Socket.io handshakes are throttled in the gateway.
 *
 * Same in-memory shape as `rate-limit.guard.ts`; moves to Redis on the
 * same trigger (second app instance).
 */

const PER_MINUTE = 600;
const WINDOW_MS = 60_000;
const BUCKET_MAX = 20_000;
const BUCKET_IDLE_SWEEP_MS = 10 * 60_000;
const BUCKET_SWEEP_INTERVAL_MS = 5 * 60_000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();
const sweeper = setInterval(() => {
  const cutoff = Date.now() - BUCKET_IDLE_SWEEP_MS;
  for (const [k, b] of buckets) {
    if (b.lastRefill < cutoff) buckets.delete(k);
  }
}, BUCKET_SWEEP_INTERVAL_MS);
sweeper.unref?.();

function consume(ip: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const refillPerMs = PER_MINUTE / WINDOW_MS;
  let bucket = buckets.get(ip);
  if (!bucket) {
    if (buckets.size >= BUCKET_MAX) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    bucket = { tokens: PER_MINUTE - 1, lastRefill: now };
    buckets.set(ip, bucket);
    return { ok: true };
  }
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(PER_MINUTE, bucket.tokens + elapsed * refillPerMs);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) {
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)),
    };
  }
  bucket.tokens -= 1;
  return { ok: true };
}

function shouldSkip(url: string): boolean {
  return (
    url.startsWith("/webhooks/") ||
    url.startsWith("/api/external/v1") ||
    url === "/api/health" ||
    url === "/health" ||
    url.startsWith("/api/socket")
  );
}

export function ipRateLimitMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req, res, next) => {
    const url = req.url ?? "";
    if (shouldSkip(url)) return next();
    const ip = req.ip ?? "unknown";
    const r = consume(ip);
    if (!r.ok) {
      res.setHeader("Retry-After", String(r.retryAfter));
      res.status(429).json({
        error: "rate_limited",
        detail: `${PER_MINUTE} req/min per IP`,
        retryAfter: r.retryAfter,
      });
      return;
    }
    next();
  };
}
