import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { createTokenBucket } from "../common/token-bucket";

/**
 * Per-team rate limit for the unauthenticated Meta webhook surface. The
 * global RateLimitInterceptor keys on req.session.userId and silently no-ops for
 * unauthenticated routes — which leaves the Meta webhook endpoint with
 * zero proxy-side throttle on the stock-Caddy deploy (the rate_limit
 * Caddyfile directive requires the xcaddy plugin we don't compile in).
 *
 * Bucketing by workspaceId (path param) means one chatty team can't drain the
 * api process for everyone. Fallback to req.ip on a path with no workspaceId
 * (defense in depth — every current webhook route has :workspaceId, but a
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
 *
 * Per-IP bucket second (mirrors WorkflowWebhookRateLimitGuard): the
 * per-team key is an attacker-chosen path param, so spraying random
 * teamIds mints a fresh bucket per request and bypasses the per-team
 * throttle entirely. Meta's webhook egress is a bounded IP set, so a
 * generous 1200/min ceiling bounds a single-IP storm without tripping on
 * legitimate multi-team burst traffic from Meta's shared infrastructure.
 *
 * ACCEPTED, deliberately: the team token is spent BEFORE the controller's
 * HMAC check, so a garbage-signature request still costs the tenant a token
 * and a distributed spray of a known workspaceId can 429 that tenant's real
 * deliveries. Cheap-rejection-first is the trade — refunding the token on a
 * 403 would instead let an unauthenticated spray drive the pre-auth secret
 * lookups without bound. Impact is delay, not loss: Meta retries with
 * backoff and every event dedupes on (workspaceId, channel, externalId).
 */
const metaWebhookBucket = createTokenBucket({ perMin: 600, maxKeys: 5_000 });
const metaWebhookIpBucket = createTokenBucket({ perMin: 1_200, maxKeys: 5_000 });

@Injectable()
export class WebhookRateLimitGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    // workspaceId is set on every current webhook route. Fall back to the
    // proxy-resolved IP so a future un-parameterized webhook route still
    // gets bucket-scoped throttling instead of one global bucket.
    const workspaceId = (req.params as { workspaceId?: string }).workspaceId;
    const ip = req.ip ?? "unknown";
    const key = workspaceId ? `team:${workspaceId}` : `ip:${ip}`;

    const result = metaWebhookBucket.consume(key);
    if (!result.ok) {
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

    // Per-IP bucket second — the per-team key is an attacker-chosen path
    // param, so this is the ceiling that actually bounds a random-workspaceId
    // spray from a single source.
    const ipResult = metaWebhookIpBucket.consume(`ip:${ip}`);
    if (!ipResult.ok) {
      res.setHeader("Retry-After", String(ipResult.retryAfter));
      throw new HttpException(
        {
          error: "rate_limited",
          detail: "Too many webhook requests from this source.",
        },
        429,
      );
    }
    return true;
  }
}

/**
 * Sibling guard for the per-workflow `/api/workspace/workflows/:id/incoming-webhook`
 * endpoint. Two-key bucket: by workflow id (stops a leaked secret from
 * flooding a single workflow) AND by source IP (stops an attacker forging
 * thousands of bogus signatures across many workflow ids).
 *
 * Defaults to a far stricter limit than the Meta webhook (120/min vs 600)
 * — workflow webhooks fire from automation tools (n8n, Zapier, custom
 * scripts), not Meta's burst-prone retry storms.
 */
const workflowBucket = createTokenBucket({ perMin: 120, maxKeys: 5_000 });
const workflowIpBucket = createTokenBucket({ perMin: 600, maxKeys: 5_000 });

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
      const r = workflowBucket.consume(`wf:${workflowId}`);
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
    const r2 = workflowIpBucket.consume(`ip:${ip}`);
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
