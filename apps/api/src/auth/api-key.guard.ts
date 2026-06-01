import { createHash } from "node:crypto";

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { createTokenBucket } from "../common/token-bucket";
import { DbService } from "../db/db.service";
import { looksLikeApiKey } from "./api-key";

/**
 * Shape attached to req.apiKey on success. Used by /external/v1/* controllers.
 * Same teamId scoping as the session guard so downstream services don't have
 * to branch on auth method.
 *
 * `scopes` lists every capability granted to this key. The wildcard `"*"`
 * grants everything; specific entries grant only that capability. The
 * ScopeGuard at route level enforces required scopes — handlers should NOT
 * re-check scopes themselves, that's a layering violation.
 */
export interface ApiKeyContext {
  teamId: string;
  apiKeyId: string;
  scopes: readonly string[];
}

declare module "express-serve-static-core" {
  interface Request {
    apiKey?: ApiKeyContext;
  }
}

// Per-key rate limit: 60 req/min/key. Moves to Redis when a 2nd app
// instance shows up. Capacity is 10k keys (well above any reasonable
// team's key count); idle entries are time- and LRU-evicted.
const apiKeyBucket = createTokenBucket({ perMin: 60, maxKeys: 10_000 });

// Per-IP rate limit for UNAUTH'd /v1 hits — fires ONLY when a request
// presents a missing / malformed / wrong token. A valid token never
// touches this bucket (its meter is `apiKeyBucket` keyed by apiKeyId).
//
// Why this exists: ipRateLimitMiddleware explicitly skips /api/external/v1
// because partners share a small set of integration IPs and the per-key
// bucket is the right meter for them. But that skip leaves a hole — well-
// formed-but-wrong tokens still hit a DB index lookup (cheap, but
// unbounded). A scripted attacker who knows the key prefix (`ccp_…`) can
// probe the keyspace forever without throttle. 30 req/min/IP for the
// NEGATIVE path absorbs the probe without affecting legitimate partner
// traffic: a real partner sees `row != null` and bypasses this gate.
//
// Why a separate bucket (not the main IP limiter): we don't want a bursty
// partner who briefly trips a positive-path quota to subsequently be
// metered as anonymous probing.
const unauthIpBucket = createTokenBucket({ perMin: 30, maxKeys: 10_000 });

// Debounce `lastUsedAt` writes per key. Without this a high-frequency partner
// hot-writes the SAME TeamApiKey row on every request (write amplification +
// row-lock contention on one row). We persist at most once per window per key;
// `lastUsedAt` is a coarse "last seen" display, so window-grained accuracy is
// fine. In-memory only (single-process pilot — bounded by key count); a restart
// just re-stamps on the next request.
const LAST_USED_DEBOUNCE_MS = 60_000;
const lastUsedStampedAt = new Map<string, number>();

/**
 * Refund a token on the API-key bucket. Used by handlers that detected an
 * idempotency-cache HIT: the request did no real work, so the upstream
 * guard's consume() should be returned. Without this, a partner whose
 * automation crashes and retries the same Idempotency-Key for 24h burns
 * 60 tokens/min on cache reads that produce zero side effects, starving
 * legitimate requests on the same key.
 */
export function refundApiKeyBucket(apiKeyId: string): void {
  apiKeyBucket.refund(apiKeyId);
}

/**
 * Public hook for OTHER /v1 abuse-blocking layers (e.g. main.ts's CORS
 * browser-origin refusal) to consume from the same per-IP bucket. Without
 * this, an attacker stamping `Origin: anything` on every /v1 hit gets
 * unlimited 403s from main.ts without burning the throttle. Returns
 * `{ ok: true }` on success; `{ ok: false }` when the bucket is empty
 * (caller decides whether to upgrade their 4xx to 429).
 */
export function consumeUnauthIpToken(
  ip: string,
): { ok: true } | { ok: false; retryAfter: number } {
  return unauthIpBucket.consume(ip);
}

/**
 * Consume an unauth-IP token, then throw 401 (or 429 if the IP has spent
 * its budget probing). Centralizes the unauth rejection so every negative
 * path in canActivate runs the same throttle. `never` return type tells TS
 * downstream code is unreachable.
 */
function rejectUnauth(req: Request, detail: string): never {
  const ip = req.ip ?? "unknown";
  const r = unauthIpBucket.consume(ip);
  if (!r.ok) {
    throw new HttpException(
      { error: "rate_limited", detail: "30 unauthenticated req/min/IP on /v1" },
      429,
    );
  }
  throw new UnauthorizedException(detail);
}

/**
 * Bearer-token guard for the external API.
 *
 *   - Read `Authorization: Bearer <token>` header
 *   - Hash with SHA-256 (same as token generation in ./api-key.ts)
 *   - Look up `TeamApiKey` by tokenHash
 *   - Reject if revoked
 *   - Stamp lastUsedAt (best-effort, non-blocking)
 *
 * We do NOT decode the token itself — only the hash is stored, by design.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly db: DbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      rejectUnauth(req, "missing bearer token");
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) rejectUnauth(req, "empty bearer token");

    // Shape gate before DB lookup. Equalizes timing for "garbage in the
    // header" vs "valid-shape but wrong token" — both now take the fast
    // path. Without this, an attacker could distinguish "we ran a DB
    // query for you" (longer response) from "we didn't" (shorter), which
    // leaks the token's expected shape.
    if (!looksLikeApiKey(token)) {
      rejectUnauth(req, "invalid api key");
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = await this.db.teamApiKey.findUnique({
      where: { tokenHash },
      select: { id: true, teamId: true, revokedAt: true, scopes: true },
    });
    if (!row || row.revokedAt) rejectUnauth(req, "invalid api key");

    // Per-key rate limit — bounds cost on a leaked/abused key. Each request
    // hits Meta's Cloud API and counts against the team's quality rating,
    // so unbounded request rates are a real bill + reputation risk.
    const rate = apiKeyBucket.consume(row.id);
    if (!rate.ok) {
      throw new HttpException(
        { error: "rate_limited", detail: "60 req/min" },
        429,
      );
    }

    // Loop guard. `X-CCP-Origin-Key` is OUR header — the outbound-webhook
    // worker stamps it on every delivery with the apiKeyId that triggered the
    // event (worker.ts). If a partner blindly relays our webhook back to /v1
    // using the SAME key, the header arrives matching THIS request's key,
    // which means the request was triggered by an event this very key caused:
    // a hot-potato loop (partner → POST /v1 → message.sent → webhook →
    // partner → POST again …). Refuse it server-side instead of trusting the
    // partner to check the header. The consumed rate-limit token is left
    // spent on purpose — natural backpressure on a runaway loop. A legitimate
    // caller never sends our internal origin header.
    const originKey = req.headers["x-ccp-origin-key"];
    if (typeof originKey === "string" && originKey === row.id) {
      throw new HttpException(
        {
          error: "loop_detected",
          detail:
            "X-CCP-Origin-Key matches the calling API key — strip CCP webhook headers before relaying a delivery back to the API.",
        },
        409,
      );
    }

    req.apiKey = { teamId: row.teamId, apiKeyId: row.id, scopes: row.scopes };

    // Stamp lastUsedAt async + DEBOUNCED — failing this should NOT fail the
    // request, and a hot partner shouldn't hot-write the same row on every
    // call. Skip the write when this key was stamped within the window.
    const now = Date.now();
    if (now - (lastUsedStampedAt.get(row.id) ?? 0) >= LAST_USED_DEBOUNCE_MS) {
      lastUsedStampedAt.set(row.id, now);
      this.db.teamApiKey
        .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {});
    }

    return true;
  }
}
