import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from "@nestjs/common";
import type { Request, Response } from "express";

/**
 * Per-team rate limit for the unauthenticated webhook surface. The global
 * RateLimitGuard keys on req.session.userId and silently no-ops for
 * unauthenticated routes — which leaves the Meta webhook endpoint with
 * zero proxy-side throttle on the stock-Caddy deploy (the rate_limit
 * Caddyfile directive requires the xcaddy plugin we don't compile in).
 *
 * Bucketing by teamId (path param) means one chatty team can't drain the
 * api process for everyone. Fallback to req.ip on a path with no teamId
 * (defense in depth — every current webhook route has :teamId, but a
 * future route might forget the guard then forget the param).
 *
 * Default ceiling: 600 req/min per team. Meta's outbound rate cap per
 * business number is ~80/min for sends; inbound webhook bursts can be a
 * small multiple of that (reactions, status callbacks, message bunches),
 * so 600 leaves comfortable headroom while still bounding a true storm.
 *
 * Response: HTTP 429 + Retry-After in seconds. Meta respects Retry-After
 * on webhook responses — better than 5xx because 5xx puts the team on
 * Meta's "your webhook is broken" health board.
 */

const PER_MIN = 600;
const WINDOW_MS = 60_000;
const BUCKET_MAX = 5_000;
const BUCKET_IDLE_SWEEP_MS = 10 * 60_000;
const BUCKET_SWEEP_INTERVAL_MS = 5 * 60_000;

interface Bucket {
  tokens: number;
  capacity: number;
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

function consume(key: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const refillPerMs = PER_MIN / WINDOW_MS;
  const bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= BUCKET_MAX) {
      // LRU-ish overflow eviction — drop the oldest insertion. Cheap and
      // good enough at this volume; the alternative (full LRU) isn't worth
      // the bookkeeping for a 5k cap.
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(key, { tokens: PER_MIN - 1, capacity: PER_MIN, lastRefill: now });
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
export class WebhookRateLimitGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    // teamId is set on every current webhook route. Fall back to the
    // proxy-resolved IP so a future un-parameterized webhook route still
    // gets bucket-scoped throttling instead of one global bucket.
    const teamId = (req.params as { teamId?: string }).teamId;
    const key = teamId ? `team:${teamId}` : `ip:${req.ip ?? "unknown"}`;

    const result = consume(key);
    if (result.ok) return true;

    res.setHeader("Retry-After", String(result.retryAfter));
    throw new HttpException(
      {
        error: "rate_limited",
        detail:
          "Too many webhooks for this team in the last minute. " +
          "Retry-After header indicates when to try again.",
      },
      429,
    );
  }
}

/**
 * Sibling guard for the per-workflow `/api/team/workflows/:id/incoming-webhook`
 * endpoint. Two-key bucket: by workflow id (stops a leaked secret from
 * flooding a single workflow) AND by source IP (stops an attacker forging
 * thousands of bogus signatures across many workflow ids).
 *
 * Defaults to a far stricter limit than the Meta webhook (120/min vs 600)
 * — workflow webhooks fire from automation tools (n8n, Zapier, custom
 * scripts), not Meta's burst-prone retry storms.
 */
const WORKFLOW_PER_MIN = 120;
const WORKFLOW_IP_PER_MIN = 600;

const workflowBuckets = new Map<string, Bucket>();
const workflowIpBuckets = new Map<string, Bucket>();

function consumeFromMap(
  map: Map<string, Bucket>,
  key: string,
  perMin: number,
): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const refillPerMs = perMin / WINDOW_MS;
  const bucket = map.get(key);
  if (!bucket) {
    if (map.size >= BUCKET_MAX) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, { tokens: perMin - 1, capacity: perMin, lastRefill: now });
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

const workflowSweeper = setInterval(() => {
  const cutoff = Date.now() - BUCKET_IDLE_SWEEP_MS;
  for (const [k, b] of workflowBuckets) if (b.lastRefill < cutoff) workflowBuckets.delete(k);
  for (const [k, b] of workflowIpBuckets) if (b.lastRefill < cutoff) workflowIpBuckets.delete(k);
}, BUCKET_SWEEP_INTERVAL_MS);
workflowSweeper.unref?.();

@Injectable()
export class WorkflowWebhookRateLimitGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const workflowId = (req.params as { id?: string }).id;
    const ip = req.ip ?? "unknown";

    // Per-workflow bucket first — the common abuse case is a leaked secret
    // flooding a single workflow.
    if (workflowId) {
      const r = consumeFromMap(workflowBuckets, `wf:${workflowId}`, WORKFLOW_PER_MIN);
      if (!r.ok) {
        res.setHeader("Retry-After", String(r.retryAfter));
        throw new HttpException(
          {
            error: "rate_limited",
            detail: "Too many requests to this workflow webhook.",
          },
          429,
        );
      }
    }

    // Per-IP bucket second — stops the cross-workflow signature-fuzz
    // pattern (attacker hammering many workflow ids with garbage sigs).
    const r2 = consumeFromMap(workflowIpBuckets, `ip:${ip}`, WORKFLOW_IP_PER_MIN);
    if (!r2.ok) {
      res.setHeader("Retry-After", String(r2.retryAfter));
      throw new HttpException(
        {
          error: "rate_limited",
          detail: "Too many requests from this source.",
        },
        429,
      );
    }
    return true;
  }
}
