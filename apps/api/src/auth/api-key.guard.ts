import { createHash } from "node:crypto";

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { DbService } from "../db/db.service";

/**
 * Shape attached to req.apiKey on success. Used by /external/v1/* controllers
 * after Phase 3 migration. Same teamId scoping as the session guard so
 * downstream services don't have to branch on auth method.
 */
export interface ApiKeyContext {
  teamId: string;
  apiKeyId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    apiKey?: ApiKeyContext;
  }
}

/**
 * Per-key token bucket. In-memory only — single-process pilot deploy, no
 * cross-instance scaling yet. Each key gets `RATE_LIMIT_PER_MIN` requests
 * per rolling 60-second window. When a second app instance shows up this
 * moves to Redis (same trigger as everything else in-process).
 *
 * Chose token bucket over fixed window so a key that bursts at second 59
 * doesn't immediately get fresh budget at second 60. `lastRefill` is a
 * millisecond timestamp; budget refills continuously.
 */
const RATE_LIMIT_PER_MIN = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
interface KeyBucket {
  tokens: number;
  lastRefill: number;
}
const keyBuckets = new Map<string, KeyBucket>();

function consumeToken(apiKeyId: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const refillRate = RATE_LIMIT_PER_MIN / RATE_LIMIT_WINDOW_MS;
  const bucket = keyBuckets.get(apiKeyId);
  if (!bucket) {
    keyBuckets.set(apiKeyId, { tokens: RATE_LIMIT_PER_MIN - 1, lastRefill: now });
    return { ok: true };
  }
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(RATE_LIMIT_PER_MIN, bucket.tokens + elapsed * refillRate);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) {
    return { ok: false, retryAfter: Math.ceil((1 - bucket.tokens) / refillRate / 1000) };
  }
  bucket.tokens -= 1;
  return { ok: true };
}

/**
 * Bearer-token guard for the external API. Mirrors `authenticateApiKey()`
 * in [lib/auth/external.ts](../../../../../lib/auth/external.ts):
 *
 *   - Read `Authorization: Bearer <token>` header
 *   - Hash with SHA-256 (same as token generation)
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
      throw new UnauthorizedException("missing bearer token");
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw new UnauthorizedException("empty bearer token");

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = await this.db.teamApiKey.findUnique({
      where: { tokenHash },
      select: { id: true, teamId: true, revokedAt: true },
    });
    if (!row || row.revokedAt) throw new UnauthorizedException("invalid api key");

    // Per-key rate limit — bounds cost on a leaked/abused key. Each request
    // hits Meta's Cloud API and counts against the team's quality rating,
    // so unbounded request rates are a real bill + reputation risk.
    const rate = consumeToken(row.id);
    if (!rate.ok) {
      throw new HttpException(
        { error: "rate_limited", detail: `${RATE_LIMIT_PER_MIN} req/min` },
        429,
      );
    }

    req.apiKey = { teamId: row.teamId, apiKeyId: row.id };

    // Stamp lastUsedAt async — failing this should NOT fail the request.
    // BullMQ / Prisma update under load occasionally throws on connection
    // pool exhaustion; the API call itself doesn't need to wait or care.
    this.db.teamApiKey
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return true;
  }
}
