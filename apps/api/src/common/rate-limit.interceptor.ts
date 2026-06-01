import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { Observable } from "rxjs";

/**
 * Per-user / per-api-key token-bucket rate limit. Mirrors the API-key bucket
 * in `auth/api-key.guard.ts` — same in-memory pattern, same eviction sweeper.
 * Moves to Redis on the same trigger (second app instance).
 *
 * MUST be an INTERCEPTOR, not a guard. It buckets by `req.session?.userId`
 * (set by SessionGuard) / `req.apiKey?.apiKeyId` (set by ApiKeyGuard). Those
 * guards are applied per-controller via `@UseGuards(...)`. In NestJS, a global
 * `APP_GUARD` runs BEFORE controller-scoped guards — so as a global guard this
 * code ran before the principal existed, the bucket key was always null, and
 * EVERY session-authenticated request passed unmetered (the per-route
 * `@RateLimit({ perMinute: 60 })` send cap was inert). Interceptors run AFTER
 * all guards, so by the time `intercept` fires the principal is populated.
 * Registered via `APP_INTERCEPTOR` in CommonModule.
 *
 * Still a no-op when neither principal is set (login pages, webhooks — those
 * have their own IP-level limits), so unauthenticated routes are unaffected.
 *
 * Default ceiling: 300 req/min per user (~5 req/sec sustained, up to 300
 * burst). One agent loading the inbox fires ~10-15 parallel queries on a
 * cold cache — well within burst. A runaway browser script can't exceed 5
 * req/sec sustained, which bounds DoS-yourself risk on the api process and
 * the Postgres connection pool.
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

// Key shape: `${principal}:${perMinute}` — different per-route limits live in
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
  principal: string,
  perMinute: number,
): { ok: true } | { ok: false; retryAfter: number } {
  const key = `${principal}:${perMinute}`;
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
export class RateLimitInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Skip for non-HTTP contexts (Socket.io gateway etc.).
    if (context.getType() !== "http") return next.handle();

    const req = context.switchToHttp().getRequest<Request>();

    // Buckets by userId (session-auth) OR apiKeyId (Bearer-auth) — both set
    // by their respective guards, which have already run by the time an
    // interceptor fires. The upstream ApiKeyGuard already enforces a 60/min
    // default ceiling; this decorator-driven path lets specific routes
    // tighten further (e.g. a bulk-tag endpoint at 20/min/key).
    const userId = req.session?.userId;
    const apiKeyId = req.apiKey?.apiKeyId;
    const key = userId ? `u:${userId}` : apiKeyId ? `k:${apiKeyId}` : null;
    if (!key) return next.handle();

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
    return next.handle();
  }
}
