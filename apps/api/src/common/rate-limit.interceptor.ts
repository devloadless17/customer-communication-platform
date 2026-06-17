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
import { tap } from "rxjs/operators";

import { wasIdempotentReplay } from "./correlation";

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
  /**
   * I-8: bucket SCOPE. Two unrelated controllers that happen to share the same
   * `perMinute` (e.g. Messages 60/min and Calls 60/min) must NOT share a bucket,
   * or sending 60 messages 429s a voice call. Defaults to the controller class
   * name so a controller's routes share one bucket (the documented intent —
   * text/media/template/forward share a cap) while different controllers don't.
   * Set explicitly to deliberately share a bucket ACROSS controllers, or to
   * give one route its own.
   */
  bucket?: string;
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

// Key shape: `${principal}:${scope}:${perMinute}` (I-8). `scope` keeps two
// controllers that share a perMinute value in separate buckets; different
// per-route limits still live in separate buckets (perMinute in the key) so a
// hot read-endpoint can't starve mutation budget.
const buckets = new Map<string, Bucket>();

function bucketKey(principal: string, scope: string, perMinute: number): string {
  return `${principal}:${scope}:${perMinute}`;
}

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
  scope: string,
  perMinute: number,
): { ok: true } | { ok: false; retryAfter: number } {
  const key = bucketKey(principal, scope, perMinute);
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

/**
 * minor#9: hand a token back to a bucket. Called when a request did zero real
 * work (an idempotent /v1 replay), so it shouldn't burn the per-route quota.
 * No-op if the bucket was evicted in the meantime (it would refill anyway).
 */
function refund(principal: string, scope: string, perMinute: number): void {
  const bucket = buckets.get(bucketKey(principal, scope, perMinute));
  if (bucket) bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
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

    const decoratorOpts = this.reflector.getAllAndOverride<
      RateLimitOptions | undefined
    >(RATE_LIMIT_METADATA, [context.getHandler(), context.getClass()]);
    const opts = decoratorOpts ?? { perMinute: DEFAULT_PER_MIN };

    // I-8: explicit per-route limits get a per-CONTROLLER (or per-decorator-
    // bucket) scope so two controllers sharing a perMinute don't collide. The
    // DEFAULT ceiling stays GLOBAL per-user (one bucket across all controllers)
    // — scoping it per-controller would let a user do 300/min PER controller and
    // defeat the global DoS ceiling.
    const scope = decoratorOpts
      ? (decoratorOpts.bucket ?? context.getClass().name)
      : "__default__";

    const r = consume(key, scope, opts.perMinute);
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
    // minor#9: refund the token if the handler short-circuited to an idempotent
    // /v1 replay (zero real work). Mirrors the api-key guard bucket refund.
    return next.handle().pipe(
      tap(() => {
        if (wasIdempotentReplay()) refund(key, scope, opts.perMinute);
      }),
    );
  }
}
