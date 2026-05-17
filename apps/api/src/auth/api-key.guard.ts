import { createHash } from "node:crypto";

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { PrismaService } from "../prisma/prisma.service";

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
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing bearer token");
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw new UnauthorizedException("empty bearer token");

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = await this.prisma.teamApiKey.findUnique({
      where: { tokenHash },
      select: { id: true, teamId: true, revokedAt: true },
    });
    if (!row || row.revokedAt) throw new UnauthorizedException("invalid api key");

    req.apiKey = { teamId: row.teamId, apiKeyId: row.id };

    // Stamp lastUsedAt async — failing this should NOT fail the request.
    // BullMQ / Prisma update under load occasionally throws on connection
    // pool exhaustion; the API call itself doesn't need to wait or care.
    this.prisma.teamApiKey
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return true;
  }
}
