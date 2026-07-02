import type { Request, Response, NextFunction } from "express";

import { createTokenBucket } from "./token-bucket";

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
 * Backed by the canonical `createTokenBucket` helper (same one the session
 * guard + 6 other call sites use) — one implementation of the refill/LRU/idle-
 * sweep logic instead of a third hand-rolled copy. Moves to Redis on the same
 * trigger (second app instance).
 */

const PER_MINUTE = 600;
const BUCKET_MAX = 20_000;

// 20k distinct IPs before LRU eviction — sized for a spray attack without
// unbounded growth. The shared module-level sweeper time-evicts idle keys.
const ipBucket = createTokenBucket({ perMin: PER_MINUTE, maxKeys: BUCKET_MAX });

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
    const r = ipBucket.consume(ip);
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
