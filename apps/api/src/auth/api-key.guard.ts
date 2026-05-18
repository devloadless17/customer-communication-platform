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
      throw new UnauthorizedException("missing bearer token");
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw new UnauthorizedException("empty bearer token");

    // Shape gate before DB lookup. Equalizes timing for "garbage in the
    // header" vs "valid-shape but wrong token" — both now take the fast
    // path. Without this, an attacker could distinguish "we ran a DB
    // query for you" (longer response) from "we didn't" (shorter), which
    // leaks the token's expected shape.
    if (!looksLikeApiKey(token)) {
      throw new UnauthorizedException("invalid api key");
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = await this.db.teamApiKey.findUnique({
      where: { tokenHash },
      select: { id: true, teamId: true, revokedAt: true, scopes: true },
    });
    if (!row || row.revokedAt) throw new UnauthorizedException("invalid api key");

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

    req.apiKey = { teamId: row.teamId, apiKeyId: row.id, scopes: row.scopes };

    // Stamp lastUsedAt async — failing this should NOT fail the request.
    // BullMQ / Prisma update under load occasionally throws on connection
    // pool exhaustion; the API call itself doesn't need to wait or care.
    this.db.teamApiKey
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return true;
  }
}
