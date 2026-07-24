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
import {
  ACTIVE_WORKSPACE_COOKIE,
  readActiveWorkspaceCookie,
  resolveActiveWorkspaceId,
} from "@ccp/shared/auth/active-workspace";
import type { Role, OrgRole, OrgStatus } from "@ccp/shared/types";

import { DbService } from "../db/db.service";

/**
 * Cookie carrying the CANDIDATE active workspace. Deliberately a cookie rather
 * than a header or a path segment: RSC fetches and the Socket.io handshake both
 * send cookies automatically, so one mechanism covers HTTP + realtime without a
 * routing refactor.
 *
 * SECURITY: this is client input. It only ever SELECTS among workspaces the
 * user provably belongs to (validated in `resolveActiveWorkspaceId`) — it can
 * never widen access. The durable, server-side truth is
 * `Session.activeWorkspaceId`.
 *
 * Both the cookie name and its parser now live in `@ccp/shared/auth/active-workspace`
 * alongside the resolution rule itself; re-exported here so the existing
 * importers (the switch controller, the socket handshake) keep one import path.
 */
export { ACTIVE_WORKSPACE_COOKIE, readActiveWorkspaceCookie };

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
  /** Organization (tenant / billing root) this user belongs to. A user belongs
   *  to exactly ONE org and joins many of its workspaces. */
  organizationId: string;
  /** Org-directory role — governs billing, the user directory, and workspace
   *  creation. Distinct from `role`, which is per-workspace. */
  orgRole: OrgRole;
  /** Platform-level operator. Replaces the removed `Role.superAdmin`: bypasses
   *  the org-approval gate and every per-workspace permission check. */
  isSuperAdmin: boolean;
  /** The ACTIVE workspace for this request — the data-isolation scope that
   *  every `where: { workspaceId }` uses. Resolved server-side from the
   *  membership-validated `ccp.ws` cookie / `Session.activeWorkspaceId`, NEVER
   *  taken raw from client input. */
  workspaceId: string;
  /** EFFECTIVE role in the active workspace:
   *    isSuperAdmin            → "admin" (and every gate short-circuits anyway)
   *    orgRole owner|admin     → "admin" in every workspace of the org
   *    otherwise               → the WorkspaceMember.role for this workspace
   *  Computed once here so guards stay a pure field read. */
  role: Role;
  /** Every workspace this user may switch to, for the switcher UI and to
   *  validate a switch request without a second query. */
  workspaceMemberships: { workspaceId: string; name: string; role: Role }[];
  name: string;
  email: string;
  /** Same row the guard already loaded — exposing it lets handlers build
   *  message DTOs inline without a follow-up user lookup. */
  avatarUrl: string | null;
  /** Org-approval status of this user's ORGANIZATION. SessionGuard rejects any
   *  non-`active` org (pending review / suspended) before the request reaches
   *  a controller — superAdmins exempt. Bounded by the same 15s session cache
   *  as the deactivation check, so a suspend lands within ~15s on the API. */
  orgStatus: OrgStatus;
  /**
   * Has this person proven they control their email address?
   *
   * Carried on the session so the guard can refuse an unverified caller and the
   * web can route them to /verify. See the rejection in `SessionGuard` for why
   * the check lives at the API boundary rather than in a layout.
   */
  emailVerified: boolean;
  /** The team's raw `rolePermissions` JSON (admin-configured per-role
   *  capability overrides). Carried on the session so CapabilityGuard +
   *  handler-level checks resolve permissions with ZERO extra DB read; the
   *  15s session cache bounds staleness after an admin edits the matrix. */
  rolePermissions: unknown;
  /** `Team.agentConversationVisibility` ("team" | "assigned"). Carried on the
   *  session so the read boundary in lib/conversations/visibility.ts costs ZERO
   *  extra queries on every conversation read; the 15s session cache bounds
   *  staleness after an admin flips it (and the flip busts the cache). */
  agentConversationVisibility: string;
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
    // both the cache-hit and cache-miss paths because `orgStatus` rides on the
    // cached ApiSession; a status flip propagates within the 15s cache TTL.
    if (!session.isSuperAdmin && session.orgStatus !== "active") {
      throw new ForbiddenException({ error: "org_not_active" });
    }
    // Email-verification gate, and it lives HERE for the same reason the
    // org-approval gate does: this is the boundary. Bouncing an unverified user
    // in middleware or a layout would leave every API route open to them —
    // the browser is not what enforces this.
    //
    // A distinct error code, not a bare 401: the web needs to tell "you are
    // signed out" (go to /login) apart from "you are signed in but unverified"
    // (go to /verify). Collapsing them sends a half-registered user round a
    // login loop with a session that is perfectly valid.
    //
    // superAdmins exempt, matching the gate above — the platform operator is
    // seeded, not self-registered.
    if (!session.isSuperAdmin && !session.emailVerified) {
      throw new ForbiddenException({ error: "email_not_verified" });
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
/**
 * Keyed by `${userId}:${workspaceId}`, NOT by userId alone.
 *
 * The snapshot carries workspace-scoped fields (`workspaceId`, `role`,
 * `rolePermissions`, `agentConversationVisibility`). Keyed by userId, a
 * multi-workspace user — two devices, or one device mid-switch — could be
 * served a snapshot scoped to the OTHER workspace and run the request against
 * it for the whole TTL. The old guard against that (`snapshotMatchesActiveWorkspace`)
 * accepted any snapshot when the request carried no `ccp.ws` cookie, which is
 * precisely the case where the two devices disagree. Putting the workspace in
 * the key removes the ambiguity instead of special-casing it: a lookup can only
 * ever return a snapshot for the workspace it asked for.
 */
const sessionCache = new Map<string, { session: ApiSession; expiresAt: number }>();

const snapshotKey = (userId: string, workspaceId: string) => `${userId}:${workspaceId}`;

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
// The deactivation snapshot is shared across a user's browsers, but `sessionId`
// is per-cookie. A user with two browsers has two Session rows; the cookie-cache
// fast path MUST return THIS cookie's sessionId, not whichever row last
// populated the snapshot cache — otherwise change-password ("sign out my other
// devices") deletes the wrong Session row. Mirrors the explicit re-bind on the
// slow path (`return { ...cached, sessionId }`).
//
// It also carries the `workspaceId` this cookie RESOLVED to. The snapshot cache
// is keyed by (userId, workspaceId), and this is what lets the cookie fast path
// name the right key without re-resolving. Note the hash covers the WHOLE Cookie
// header — including `ccp.ws` — so a switch produces a different key and can
// never hit a pre-switch entry.
const cookieCache = new Map<
  string,
  { userId: string; sessionId: string; workspaceId: string; expiresAt: number }
>();

import { createHash } from "node:crypto";

function hashCookie(cookieHeader: string): string {
  return createHash("sha256").update(cookieHeader).digest("hex");
}

/**
 * Public surface so the Socket.io handshake (`SocketAuthService`) can reuse the
 * same snapshot — without these accessors, every post-deploy reconnect storm
 * pays an independent DB roundtrip.
 *
 * `workspaceId` is REQUIRED on the read: the snapshot is workspace-scoped, so a
 * caller that doesn't yet know which workspace it wants has nothing to hit the
 * cache with and must resolve first. That is the point — see `sessionCache`.
 */
export function sessionCacheGet(userId: string, workspaceId: string): ApiSession | null {
  return cacheGet(userId, workspaceId);
}
/** The snapshot carries its own `userId` + `workspaceId` — the key derives from
 *  them, so there is no way to file one under the wrong pair. */
export function sessionCacheSet(session: ApiSession): void {
  cacheSet(session);
}

/**
 * Look up an already-resolved (cookie → user + workspace) mapping. Returns the
 * cached ApiSession for that cookie, or null if no live entry. Used by the
 * socket handshake to skip `auth.api.getSession` entirely on the hot reconnect
 * path. Returns null if EITHER the cookie cache OR the snapshot cache has
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
  const cached = cacheGet(entry.userId, entry.workspaceId);
  if (!cached) return null;
  // Re-bind THIS cookie's sessionId over the shared snapshot — same reason the
  // slow path does `{ ...cached, sessionId }`. Without it, a user with two
  // browsers gets the other browser's sessionId here, and change-password
  // deletes the wrong Session row.
  return { ...cached, sessionId: entry.sessionId };
}

export function sessionCacheSetByCookie(
  cookieHeader: string,
  userId: string,
  sessionId: string,
  workspaceId: string,
): void {
  const key = hashCookie(cookieHeader);
  if (cookieCache.size >= SESSION_CACHE_MAX) {
    const oldest = cookieCache.keys().next().value;
    if (oldest !== undefined) cookieCache.delete(oldest);
  }
  cookieCache.set(key, {
    userId,
    sessionId,
    workspaceId,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });
}

function cacheGet(userId: string, workspaceId: string): ApiSession | null {
  const key = snapshotKey(userId, workspaceId);
  const entry = sessionCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sessionCache.delete(key);
    return null;
  }
  return entry.session;
}

function cacheSet(session: ApiSession): void {
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    // Map preserves insertion order; the first key is the oldest. Drop it.
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) sessionCache.delete(oldest);
  }
  sessionCache.set(snapshotKey(session.userId, session.workspaceId), {
    session,
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  });
}

/**
 * Manual invalidation hook for state changes that should bust the cache
 * immediately (sign-out, deactivation, role/membership change). Wired via
 * `invalidateSessionCache(userId)` import — call from the services that
 * perform those mutations to keep the window from biting on privileged
 * transitions.
 *
 * Drops EVERY workspace's snapshot for the user (the cache is keyed by
 * `${userId}:${workspaceId}`, and a membership change can alter any of them),
 * then walks the cookie-hash cache to evict every cookie that resolved to this
 * user. Stale cookie entries are otherwise self-healing within the 15s TTL, but
 * a deactivation should land immediately for sockets too.
 */
export function invalidateSessionCache(userId: string): void {
  const prefix = `${userId}:`;
  for (const key of sessionCache.keys()) {
    if (key.startsWith(prefix)) sessionCache.delete(key);
  }
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
    // The cookie-hash entry records the workspace THIS cookie resolved to, and
    // the snapshot cache is keyed by (userId, workspaceId) — so a hit can only
    // ever be the right workspace. No post-hoc match check is needed (or
    // possible to forget).
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

  // Hot-path: same (user, workspace) just resolved a moment ago — Better Auth
  // already confirmed the cookie is valid, so the cached deactivation snapshot
  // is still trustworthy for the cache window. We must still re-bind
  // `sessionId` to the current request because the snapshot is shared across a
  // user's devices — a user with two browsers has two Session rows, and
  // `session.sessionId` must reflect THIS request's row.
  //
  // Only reachable when the request NAMES a workspace: without `ccp.ws` there
  // is no key to look up, and guessing one is precisely the bug this keying
  // fixes. Cookie-less requests fall through to the full resolve below, which
  // consults `Session.activeWorkspaceId` — correct, and rare enough that the
  // extra roundtrip doesn't matter.
  const cookieCandidate = readActiveWorkspaceCookie(cookieHeader);
  const cached = cookieCandidate ? cacheGet(result.user.id, cookieCandidate) : null;
  if (cached) {
    // Repopulate the cookie-hash cache so the NEXT request on THIS cookie hits
    // the fast-path at the top and short-circuits `auth.api.getSession`
    // entirely — matching the full path below and the socket handshake
    // (socket-auth.service.ts). Without this, a user warmed only via the
    // snapshot cache (socket handshake / another device) kept paying the Better
    // Auth DB roundtrip on every HTTP request even though the cookie cache
    // could have served it.
    if (typeof cookieHeader === "string" && cookieHeader.length > 0) {
      sessionCacheSetByCookie(cookieHeader, result.user.id, sessionId, cached.workspaceId);
    }
    return { ...cached, sessionId };
  }

  // Deactivation re-check — the edge sees only the signed cookie, not
  // deactivatedAt. Without this an admin's deactivation is up to 90 days
  // late for API calls. Narrow select keeps the row tiny.
  const user = await prisma.user.findUnique({
    where: { id: result.user.id },
    select: {
      id: true,
      organizationId: true,
      orgRole: true,
      isSuperAdmin: true,
      name: true,
      email: true,
      avatarUrl: true,
      deactivatedAt: true,
      emailVerified: true,
      organization: { select: { status: true } },
      // Every workspace this user may act in. Ordered so the "first membership"
      // fallback is deterministic across requests/devices.
      workspaceMemberships: {
        orderBy: { createdAt: "asc" },
        select: {
          role: true,
          workspace: {
            select: {
              id: true,
              name: true,
              rolePermissions: true,
              agentConversationVisibility: true,
            },
          },
        },
      },
    },
  });
  if (!user || user.deactivatedAt) return null;

  const memberships = user.workspaceMemberships;
  // An org admin/owner is implicitly admin in EVERY workspace of THEIR OWN org,
  // so they may act in workspaces they hold no explicit membership row for.
  const isOrgAdmin = user.orgRole === "owner" || user.orgRole === "admin";
  const memberWorkspaceIds = new Set(memberships.map((m) => m.workspace.id));

  // Whether the user may select `wsId` as their active workspace.
  //
  // SECURITY-CRITICAL, and async ON PURPOSE. The `ccp.ws` cookie is client
  // input; this is the gate that stops it being a cross-org key. Membership is
  // the fast path (no query). BEYOND membership, the org-admin / superAdmin
  // short-circuit MUST be verified against the DB — an org owner (every
  // self-signup is `orgRole: "owner"`) is admin only within their OWN org, so
  // the workspace has to be confirmed to belong to `user.organizationId`.
  // Trusting `isOrgAdmin` unscoped let any org owner set `ccp.ws` to any
  // workspace on the platform and act as its admin (mirrors the check
  // `workspaces.service.canAccess` already does for the switch endpoint).
  const canAccessUncached = async (wsId: string): Promise<boolean> => {
    if (memberWorkspaceIds.has(wsId)) return true;
    if (user.isSuperAdmin) {
      return (await prisma.workspace.count({ where: { id: wsId } })) > 0;
    }
    if (isOrgAdmin) {
      return (
        (await prisma.workspace.count({
          where: { id: wsId, organizationId: user.organizationId },
        })) > 0
      );
    }
    return false;
  };
  // Memoised: the resolver asks about the same candidate the guard below already
  // probed, and for an org admin acting outside their membership rows each ask
  // is a real query. One lookup per distinct workspace id per resolve.
  const accessCache = new Map<string, Promise<boolean>>();
  const canAccess = (wsId: string): Promise<boolean> => {
    const hit = accessCache.get(wsId);
    if (hit) return hit;
    const p = canAccessUncached(wsId);
    accessCache.set(wsId, p);
    return p;
  };

  // Active-workspace resolution — the SHARED rule
  // (`@ccp/shared/auth/active-workspace`), used identically by the socket
  // handshake and the Next.js RSC session so the three can never disagree
  // about which workspace a signed-in user is acting in.
  //
  // Only read the stored per-device choice when the cookie didn't settle it:
  // the cookie is present on every browser request, so this extra roundtrip is
  // confined to server-side fetches and post-cookie-wipe recovery.
  const stored =
    cookieCandidate && (await canAccess(cookieCandidate))
      ? null
      : await prisma.session.findUnique({
          where: { id: sessionId },
          select: { activeWorkspaceId: true },
        });
  const activeWorkspaceId = await resolveActiveWorkspaceId({
    memberships: memberships.map((m) => ({ workspaceId: m.workspace.id })),
    cookieCandidate,
    storedWorkspaceId: stored?.activeWorkspaceId ?? null,
    canAccessBeyondMembership: canAccess,
  });
  // Nothing resolvable means "no workspace to act in", and the guard treats
  // that as unauthenticated rather than silently picking someone else's.
  if (!activeWorkspaceId) return null;

  const active = memberships.find((m) => m.workspace.id === activeWorkspaceId);
  // Effective role in the ACTIVE workspace (see ApiSession.role).
  const effectiveRole: Role =
    user.isSuperAdmin || isOrgAdmin ? "admin" : ((active?.role ?? "agent") as Role);

  const session: ApiSession = {
    sessionId,
    userId: user.id,
    organizationId: user.organizationId,
    orgRole: user.orgRole,
    isSuperAdmin: user.isSuperAdmin,
    workspaceId: activeWorkspaceId,
    role: effectiveRole,
    workspaceMemberships: memberships.map((m) => ({
      workspaceId: m.workspace.id,
      name: m.workspace.name,
      role: m.role as Role,
    })),
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl ?? null,
    orgStatus: (user.organization?.status ?? "active") as OrgStatus,
    emailVerified: user.emailVerified,
    rolePermissions: active?.workspace.rolePermissions ?? {},
    // Default "team" = unrestricted, matching the column default, so a missing
    // workspace row can never accidentally lock an org out of its own inbox.
    agentConversationVisibility: active?.workspace.agentConversationVisibility ?? "team",
  };
  cacheSet(session);
  if (typeof cookieHeader === "string" && cookieHeader.length > 0) {
    sessionCacheSetByCookie(cookieHeader, user.id, sessionId, activeWorkspaceId);
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
