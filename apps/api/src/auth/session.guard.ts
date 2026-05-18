import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { auth } from "@/auth/better-auth";
import type { Role } from "@ccp/shared/types";

import { DbService } from "../db/db.service";

/**
 * Shape attached to req.session on success. Same fields the pre-migration
 * Next.js `requireSession()` helper returned, so controllers feel identical
 * to the route handlers they're replacing.
 */
export interface ApiSession {
  userId: string;
  teamId: string;
  role: Role;
  name: string;
  email: string;
  /** Same row the guard already loaded — exposing it lets handlers build
   *  message DTOs inline without a follow-up user lookup. */
  avatarUrl: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    session?: ApiSession;
  }
}

/**
 * Validates the Better Auth session cookie issued by Next.js, then
 * re-checks the underlying user for soft-deletion (deactivatedAt). Same
 * pair of checks the pre-migration Next.js `requireSession()` performed.
 *
 * We call `auth.api.getSession({ headers })` rather than parsing the cookie
 * directly so cookie signing, expiry, and refresh-window semantics stay in
 * one place (the Better Auth config). Cost: one DB roundtrip for the
 * session row, one for the user — same as the Next.js side.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger(SessionGuard.name);

  constructor(private readonly db: DbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const session = await resolveSession(req, this.db, this.logger);
    if (!session) throw new UnauthorizedException("unauthorized");
    req.session = session;
    return true;
  }
}

/**
 * Process-local cache of the post-deactivation-check session snapshot. One
 * RSC render fires ~8 parallel api() calls; each used to hit
 * `prisma.user.findUnique` independently. With this cache the first request
 * pays the DB read and the rest within TTL share the resolved snapshot.
 *
 * TTL chosen to match Better Auth's own cookieCache window (60s) closely
 * enough that revocation latency feels uniform, while still being short
 * enough that an admin-driven deactivation lands within seconds rather
 * than an entire session lifetime. The Session row deletion path stays
 * authoritative via Better Auth's cookie cache miss → DB lookup.
 *
 * Bounded LRU-ish via maxSize so a multi-tenant deploy can't grow the
 * map unboundedly. We evict expired entries opportunistically on read
 * and the oldest entry on insert when over the cap — good enough for an
 * MVP without pulling in lru-cache.
 */
// 15s mirrors Better Auth's cookieCache window closely enough that
// revocation latency feels uniform. A deactivated user may retain access
// for up to 15s after the admin's deactivation lands — acceptable per
// pilot product scope (deactivation isn't a hostile-takeover defense; the
// Session row deletion path stays authoritative via Better Auth's cookie
// cache miss → DB lookup). Lower this if a tighter window is needed AND
// you're willing to pay the DB roundtrip per request on RSC bursts.
// Manual invalidation hook (`invalidateSessionCache`) covers explicit
// state changes that shouldn't wait for the TTL.
const SESSION_CACHE_TTL_MS = 15_000;
const SESSION_CACHE_MAX = 10_000;
const sessionCache = new Map<string, { session: ApiSession; expiresAt: number }>();

/**
 * Public surface so the Socket.io handshake (`SocketAuthService`) can
 * reuse the same per-userId snapshot — without these accessors, every
 * post-deploy reconnect storm pays an independent DB roundtrip.
 */
export function sessionCacheGet(userId: string): ApiSession | null {
  return cacheGet(userId);
}
export function sessionCacheSet(userId: string, session: ApiSession): void {
  cacheSet(userId, session);
}

function cacheGet(userId: string): ApiSession | null {
  const entry = sessionCache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sessionCache.delete(userId);
    return null;
  }
  return entry.session;
}

function cacheSet(userId: string, session: ApiSession): void {
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    // Map preserves insertion order; the first key is the oldest. Drop it.
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) sessionCache.delete(oldest);
  }
  sessionCache.set(userId, {
    session,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });
}

/**
 * Manual invalidation hook for state changes that should bust the cache
 * immediately (sign-out, deactivation, role/team change). Wired via
 * `invalidateSessionCache(userId)` import — call from the controllers
 * that perform those mutations to keep the window from biting on
 * privileged transitions.
 */
export function invalidateSessionCache(userId: string): void {
  sessionCache.delete(userId);
}

/**
 * Shared resolver: cookie → Better Auth → active-user recheck. Exported so
 * the Socket.io handshake can reuse the exact same logic without re-implementing
 * any of the auth flow.
 */
export async function resolveSession(
  req: Request,
  prisma: DbService,
  logger: Logger,
): Promise<ApiSession | null> {
  // Forward the incoming Express headers to Better Auth. It only needs
  // Cookie + (optionally) Authorization, but passing everything is safer
  // than picking the wrong subset across versions.
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (!v) continue;
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else headers.set(k, String(v));
  }

  let result: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
  try {
    result = await auth.api.getSession({ headers });
  } catch (err) {
    logger.warn(`getSession threw: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  if (!result?.user?.id) return null;

  // Hot-path: same user just resolved a moment ago — Better Auth already
  // confirmed the cookie is valid, so the cached deactivation snapshot is
  // still trustworthy for the cache window.
  const cached = cacheGet(result.user.id);
  if (cached) return cached;

  // Deactivation re-check — the edge sees only the signed cookie, not
  // deactivatedAt. Without this an admin's deactivation is up to 90 days
  // late for API calls. Narrow select keeps the row tiny.
  const user = await prisma.user.findUnique({
    where: { id: result.user.id },
    select: {
      id: true,
      teamId: true,
      role: true,
      name: true,
      email: true,
      avatarUrl: true,
      deactivatedAt: true,
    },
  });
  if (!user || user.deactivatedAt) return null;

  const session: ApiSession = {
    userId: user.id,
    teamId: user.teamId,
    role: user.role as Role,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl ?? null,
  };
  cacheSet(user.id, session);
  return session;
}
