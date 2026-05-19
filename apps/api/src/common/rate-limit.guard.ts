import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

/**
 * Per-user token-bucket rate limit. Mirrors the API-key bucket in
 * `auth/api-key.guard.ts` — same in-memory pattern, same eviction sweeper.
 * Moves to Redis on the same trigger (second app instance).
 *
 * Wired globally via `APP_GUARD` in CommonModule. The guard runs for every
 * request but only consumes a token when `req.session?.userId` is set —
 * unauthenticated routes (login pages, webhooks) and API-key routes
 * (already rate-limited by ApiKeyGuard) pass through without metering.
 *
 * Default ceiling: 300 req/min per user (~5 req/sec sustained, up to 300
 * burst). One agent loading the inbox fires ~10-15 parallel queries on a
 * cold cache — that's well within burst. A runaway browser script can't
 * exceed 5 req/sec sustained, which bounds DoS-yourself risk on the api
 * process and the Postgres connection pool.
 *
 * Tighter or looser limits per route are decorator-driven:
 *
 *   `@RateLimit({ perMinute: 60 })` on mutating sends
 *   `@RateLimit({ perMinute: 1200 })` on read-heavy list endpoints
 *
 * Pre-deploy targets default `perMinute: 300` is correct for everything
 * except `messages.send` (60/min — the Meta API hard cap per number is
 * 80/min, so 60 keeps comfortable headroom on the local rate limit).
 */

const DEFAULT_PER_MIN = 300;
const WINDOW_MS = 60_000;
const BUCKET_MAX = 10_000;
const BUCKET_IDLE_SWEEP_MS = 10 * 60_000;
const BUCKET_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface RateLimitOptions {
  /** Token-bucket capacity AND refill-per-minute. Bucket fills at perMinute/60s. */
  perMinute: number;
}

const RATE_LIMIT_METADATA = "rate-limit:options";

/**
 * Override the default per-user rate limit on a controller method or class.
 * Lower for mutating / expensive routes; higher for cheap reads.
 */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_METADATA, options);

interface Bucket {
  tokens: number;
  capacity: number;
  lastRefill: number;
}

// Key shape: `${userId}:${perMinute}` — different per-route limits live in
// separate buckets so a hot read-endpoint can't starve mutation budget.
const buckets = new Map<string, Bucket>();

const sweeper = setInterval(() => {
  const cutoff = Date.now() - BUCKET_IDLE_SWEEP_MS;
  for (const [k, b] of buckets) {
    if (b.lastRefill < cutoff) buckets.delete(k);
  }
}, BUCKET_SWEEP_INTERVAL_MS);
sweeper.unref?.();

// Cap-eviction is a silent limit relaxation (the evicted user's next
// request gets a full bucket). We don't expect to ever hit BUCKET_MAX on
// the single-process pilot — if this log fires, the in-memory assumption
// is breaking and it's time to move buckets to Redis. Rate-limit the log
// itself so a stuck-evicting state doesn't drown stdout.
const EVICTION_LOG_INTERVAL_MS = 60_000;
let evictionLogCount = 0;
let evictionLogLast = 0;
function logEviction(): void {
  evictionLogCount += 1;
  const now = Date.now();
  if (now - evictionLogLast < EVICTION_LOG_INTERVAL_MS) return;
  console.warn(
    `[rate-limit] bucket cap ${BUCKET_MAX} reached — evicted ${evictionLogCount} ` +
      `oldest entries since last log. Move to Redis if this fires often.`,
  );
  evictionLogLast = now;
  evictionLogCount = 0;
}

function consume(
  userId: string,
  perMinute: number,
): { ok: true } | { ok: false; retryAfter: number } {
  const key = `${userId}:${perMinute}`;
  const now = Date.now();
  const refillPerMs = perMinute / WINDOW_MS;
  const bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= BUCKET_MAX) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) {
        buckets.delete(oldest);
        logEviction();
      }
    }
    buckets.set(key, { tokens: perMinute - 1, capacity: perMinute, lastRefill: now });
    return { ok: true };
  }
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * refillPerMs);
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

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // Skip for non-HTTP contexts (Socket.io gateway etc.).
    // Buckets by userId (session-auth) OR apiKeyId (Bearer-auth). The
    // upstream ApiKeyGuard already enforces a 60/min default ceiling; this
    // decorator-driven path lets specific routes tighten further (e.g. a
    // bulk-tag endpoint at 20/min/key).
    const userId = req.session?.userId;
    const apiKeyId = req.apiKey?.apiKeyId;
    const key = userId ? `u:${userId}` : apiKeyId ? `k:${apiKeyId}` : null;
    if (!key) return true;

    const opts =
      this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
        RATE_LIMIT_METADATA,
        [context.getHandler(), context.getClass()],
      ) ?? { perMinute: DEFAULT_PER_MIN };

    const r = consume(key, opts.perMinute);
    if (!r.ok) {
      throw new HttpException(
        {
          error: "rate_limited",
          detail: `${opts.perMinute} req/min per ${userId ? "user" : "api key"}`,
          retryAfter: r.retryAfter,
        },
        429,
      );
    }
    return true;
  }
}
