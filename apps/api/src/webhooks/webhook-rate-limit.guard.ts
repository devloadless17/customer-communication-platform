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
 * global RateLimitGuard keys on req.session.userId and silently no-ops for
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
const metaWebhookBucket = createTokenBucket({ perMin: 600, maxKeys: 5_000 });

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

    const result = metaWebhookBucket.consume(key);
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
