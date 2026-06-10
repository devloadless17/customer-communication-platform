import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { auth } from "@/auth/better-auth";
import type { Role, TeamStatus } from "@ccp/shared/types";

import { DbService } from "../db/db.service";

/**
 * Shape attached to req.session on success. Same fields the pre-migration
 * Next.js `requireSession()` helper returned, so controllers feel identical
 * to the route handlers they're replacing.
 */
export interface ApiSession {
  /** Better Auth Session.id of the row that authorized this request. Used
   *  by handlers that need to revoke OTHER sessions while keeping the
   *  current one alive — e.g. password change deletes every Session row
   *  for the user except this one so the requesting tab stays signed in
   *  while every other device is kicked. */
  sessionId: string;
  userId: string;
  teamId: string;
  role: Role;
  name: string;
  email: string;
  /** Same row the guard already loaded — exposing it lets handlers build
   *  message DTOs inline without a follow-up user lookup. */
  avatarUrl: string | null;
  /** Org-approval status of this user's team. SessionGuard rejects any
   *  non-`active` org (pending review / suspended) before the request reaches
   *  a controller — superAdmins exempt. Bounded by the same 15s session cache
   *  as the deactivation check, so a suspend lands within ~15s on the API. */
  teamStatus: TeamStatus;
  /** The team's raw `rolePermissions` JSON (admin-configured per-role
   *  capability overrides). Carried on the session so CapabilityGuard +
   *  handler-level checks resolve permissions with ZERO extra DB read; the
   *  15s session cache bounds staleness after an admin edits the matrix. */
  rolePermissions: unknown;
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
    let session: ApiSession | null;
    try {
      session = await resolveSession(req, this.db, this.logger);
    } catch (err) {
      if (err instanceof AuthUnavailableError) {
        // Auth backend is degraded — return 401 (NOT 503) so the browser's
        // socket reconnect logic also treats this as "retry later," not "you
        // are now logged out." HTTP path still rejects the request; the
        // alternative (503 here) would risk false-positive sign-outs in
        // the web app's session-refresh path.
        throw new UnauthorizedException({ error: "auth_unavailable" });
      }
      throw err;
    }
    if (!session) throw new UnauthorizedException({ error: "unauthorized" });
    // Org-approval gate. A pending (awaiting review) or suspended (revoked) org
    // has no API access. superAdmins are exempt — their team is just an anchor
    // row and they manage the platform from the (platform) shell. Checked on
    // both the cache-hit and cache-miss paths because `teamStatus` rides on the
    // cached ApiSession; a status flip propagates within the 15s cache TTL.
    if (session.role !== "superAdmin" && session.teamStatus !== "active") {
      throw new ForbiddenException({ error: "org_not_active" });
    }
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

// Cookie-hash-keyed cache: short-circuits `auth.api.getSession` itself, not
// just the deactivation re-check. Without this every fresh socket handshake
// (and every uncached HTTP request) pays a Postgres lookup inside Better
// Auth, so a deploy + 80-agent reconnect storm starves the pool. We can't
// key on the cookie string directly (don't want secrets in heap dumps), so
// hash it. Same 15s TTL as the user cache. Cleared on signout/deactivation
// via `invalidateSessionCache(userId)`, which walks the cookieCache and
// drops every entry pointing to the given userId — the only mutation paths
// (signout, deactivation, role change, password change) all know the userId.
// Entry carries `sessionId` (this cookie's Session row id) ALONGSIDE userId.
// The deactivation snapshot is keyed by userId and shared across a user's
// browsers, but `sessionId` is per-cookie. A user with two browsers has two
// Session rows; the cookie-cache fast path MUST return THIS cookie's sessionId,
// not whichever row last populated the userId cache — otherwise change-password
// ("sign out my other devices") deletes the wrong Session row. Mirrors the
// explicit re-bind on the slow path (`return { ...cached, sessionId }`).
const cookieCache = new Map<
  string,
  { userId: string; sessionId: string; expiresAt: number }
>();

import { createHash } from "node:crypto";

function hashCookie(cookieHeader: string): string {
  return createHash("sha256").update(cookieHeader).digest("hex");
}

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

/**
 * Look up an already-resolved (cookie → user) mapping. Returns the cached
 * ApiSession for that cookie, or null if no live entry. Used by the socket
 * handshake to skip `auth.api.getSession` entirely on the hot reconnect
 * path. Returns null if EITHER the cookie cache OR the user cache has
 * expired so a stale cookie hash never resurrects a dead session.
 */
export function sessionCacheGetByCookie(cookieHeader: string): ApiSession | null {
  const key = hashCookie(cookieHeader);
  const entry = cookieCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cookieCache.delete(key);
    return null;
  }
  const cached = cacheGet(entry.userId);
  if (!cached) return null;
  // Re-bind THIS cookie's sessionId over the userId-keyed snapshot — same
  // reason the slow path does `{ ...cached, sessionId }`. Without it, a user
  // with two browsers gets the other browser's sessionId here, and
  // change-password deletes the wrong Session row.
  return { ...cached, sessionId: entry.sessionId };
}

export function sessionCacheSetByCookie(
  cookieHeader: string,
  userId: string,
  sessionId: string,
): void {
  const key = hashCookie(cookieHeader);
  if (cookieCache.size >= SESSION_CACHE_MAX) {
    const oldest = cookieCache.keys().next().value;
    if (oldest !== undefined) cookieCache.delete(oldest);
  }
  cookieCache.set(key, {
    userId,
    sessionId,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });
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
 *
 * Also walks the cookie-hash cache to evict every cookie that resolved to
 * this user. Stale cookie cache entries are otherwise self-healing within
 * the 15s TTL, but a deactivation should land immediately for sockets too.
 */
export function invalidateSessionCache(userId: string): void {
  sessionCache.delete(userId);
  for (const [key, entry] of cookieCache) {
    if (entry.userId === userId) cookieCache.delete(key);
  }
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

  // Fast-path: cookie-hash cache short-circuits Better Auth + the user
  // re-check entirely. Critical under reconnect storms — without it, every
  // handshake (HTTP or socket) does a Postgres roundtrip via Better Auth.
  const cookieHeader = req.headers["cookie"];
  if (typeof cookieHeader === "string" && cookieHeader.length > 0) {
    const cached = sessionCacheGetByCookie(cookieHeader);
    if (cached) return cached;
  }

  let result: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
  let getSessionThrew = false;
  try {
    result = await auth.api.getSession({ headers });
  } catch (err) {
    getSessionThrew = true;
    logger.warn(`getSession threw: ${err instanceof Error ? err.message : err}`);
    // Signal "auth service unavailable" to callers (vs "no session"). The
    // socket handshake uses this to NOT emit `unauthenticated` (which would
    // hard-log-out every connected agent on a Postgres flap); the HTTP path
    // still 401s.
    throw new AuthUnavailableError(err);
  }

  if (!result?.user?.id || !result?.session?.id) return null;
  void getSessionThrew;
  const sessionId = result.session.id;

  // Hot-path: same user just resolved a moment ago — Better Auth already
  // confirmed the cookie is valid, so the cached deactivation snapshot is
  // still trustworthy for the cache window. We must still re-bind
  // `sessionId` to the current request because the cache is keyed by
  // userId, not by session — a user with two browsers has two session
  // rows, and `session.sessionId` must reflect THIS request's row.
  const cached = cacheGet(result.user.id);
  if (cached) return { ...cached, sessionId };

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
      team: { select: { rolePermissions: true, status: true } },
    },
  });
  if (!user || user.deactivatedAt) return null;

  const session: ApiSession = {
    sessionId,
    userId: user.id,
    teamId: user.teamId,
    role: user.role as Role,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl ?? null,
    teamStatus: (user.team?.status ?? "active") as TeamStatus,
    rolePermissions: user.team?.rolePermissions ?? {},
  };
  cacheSet(user.id, session);
  if (typeof cookieHeader === "string" && cookieHeader.length > 0) {
    sessionCacheSetByCookie(cookieHeader, user.id, sessionId);
  }
  return session;
}

/**
 * Thrown when `auth.api.getSession` itself throws (e.g. Postgres
 * unreachable). Distinct from "no session present" so callers can
 * distinguish "log out" from "service degraded, retry."
 */
export class AuthUnavailableError extends Error {
  constructor(public override readonly cause: unknown) {
    super("auth_unavailable");
  }
}
