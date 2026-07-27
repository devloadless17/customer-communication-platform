import { Injectable, Logger } from "@nestjs/common";
import type { Socket } from "socket.io";

import { auth } from "@/auth/better-auth";
import {
  makeCanAccessBeyondMembership,
  readActiveWorkspaceCookie,
  resolveActiveWorkspaceId,
} from "@ccp/shared/auth/active-workspace";
import type { Role, OrgStatus } from "@ccp/shared/types";

import { DbService } from "../db/db.service";
import {
  sessionCacheGet,
  sessionCacheGetByCookie,
  sessionCacheSet,
  sessionCacheSetByCookie,
} from "../auth/session.guard";

export interface SocketIdentity {
  userId: string;
  workspaceId: string;
  role: Role;
  /** `Team.agentConversationVisibility` — decides whether this socket may join
   *  the team firehose room. See RealtimeGateway.handleConnection. */
  agentConversationVisibility: string;
}

export type SocketAuthResult =
  | { kind: "ok"; identity: SocketIdentity }
  | { kind: "unauthenticated" }
  /**
   * The session is VALID, but the app is gating this user: their organization
   * is pending review / suspended, or they haven't verified their email.
   *
   * Distinct from `unauthenticated` because the CLIENT reacts differently, and
   * conflating them was a real bug. On `unauthenticated` the browser navigates
   * to `/logout`, which DELETES the session — so suspending an organization
   * dumped its members onto a context-free `/login` instead of the `/pending`
   * screen that explains why they're locked out and shows the reason. The API's
   * suspend handler goes out of its way NOT to delete Better Auth sessions for
   * exactly this reason; the socket was undoing that from the other side.
   *
   * The gate itself is unchanged — the socket still refuses to connect, so no
   * realtime data flows. Only the client's reaction differs: stop reconnecting,
   * and let the server-rendered layout route to `/pending` or `/verify`.
   */
  | { kind: "gated" }
  /**
   * Auth backend is degraded (Postgres flap, Better Auth threw). Client
   * receives "auth_unavailable" rather than "unauthenticated" so the browser
   * keeps reconnecting with backoff instead of force-logging the user out.
   */
  | { kind: "unavailable" };

/**
 * Socket.io handshake authentication. Runs on every real connect AND on every
 * recovered reconnect — ws-adapter keeps `skipMiddlewares` at its default
 * (false) so re-auth always runs (closes the deactivation-survival window).
 * The reconnect-storm DB cost is absorbed by the 15s session cache below, not
 * by skipping the handshake.
 *
 * Handshake steps:
 *   1. Forward the cookie header into Better Auth's getSession.
 *   2. Reject if no valid session.
 *   3. Re-check the user's `deactivatedAt` — Better Auth's in-cookie cache
 *      doesn't know about deactivation.
 *   4. Return the trustworthy identity.
 *
 * Cost: one DB hit per handshake. ConnectionStateRecovery means a brief drop
 * doesn't re-handshake, so the cost is per-real-connect, not per-tick.
 */
@Injectable()
export class SocketAuthService {
  private readonly logger = new Logger(SocketAuthService.name);

  constructor(private readonly db: DbService) {}

  async authenticate(socket: Socket): Promise<SocketAuthResult> {
    const cookieHeader = socket.handshake.headers.cookie;
    if (!cookieHeader || cookieHeader.length === 0) {
      return { kind: "unauthenticated" };
    }

    // Fast-path: cookie-hash cache short-circuits Better Auth entirely.
    // Without this, a deploy + 80-agent reconnect = 80 simultaneous Better
    // Auth lookups → Postgres pool starves → `getSession` throws →
    // every connected agent gets logged out. This is the CR1 cascade.
    const cachedFromCookie = sessionCacheGetByCookie(cookieHeader);
    if (cachedFromCookie) {
      // I-10: re-check the org-approval gate on the fast path too. The cached
      // entry carries orgStatus (refreshed at least every 15s), so a
      // suspended/pending org's reconnect is cut over here instead of slipping
      // through because the cookie cache was warm — matching the slow path below
      // and the HTTP SessionGuard, which re-checks orgStatus on every request.
      if (
        !cachedFromCookie.isSuperAdmin &&
        cachedFromCookie.orgStatus !== "active"
      ) {
        return { kind: "gated" };
      }
      // Unverified email — same boundary as the HTTP guard. A socket is a read
      // channel into the whole workspace's realtime feed, so leaving it open
      // while the REST API is closed would be the larger hole of the two.
      if (!cachedFromCookie.isSuperAdmin && !cachedFromCookie.emailVerified) {
        return { kind: "gated" };
      }
      return {
        kind: "ok",
        identity: {
          userId: cachedFromCookie.userId,
          workspaceId: cachedFromCookie.workspaceId,
          role: cachedFromCookie.role,
          agentConversationVisibility: cachedFromCookie.agentConversationVisibility,
        },
      };
    }

    let session: Awaited<ReturnType<typeof auth.api.getSession>>;
    try {
      const headers = new Headers();
      headers.set("cookie", cookieHeader);
      session = await auth.api.getSession({ headers });
    } catch (err) {
      this.logger.warn(
        `socket auth: getSession threw: ${err instanceof Error ? err.message : err}`,
      );
      // Transient: tell the client to retry instead of forcing /logout.
      return { kind: "unavailable" };
    }

    // Only identity comes off the Better Auth payload. Tenant scope is NOT read
    // from it any more: `workspaceId`/`role` used to ride along as Better Auth
    // `additionalFields` mirroring the old User columns, but the active
    // workspace is now a per-request resolution over WorkspaceMember (below),
    // and the role is per-workspace. Trusting the token's copy would also pin a
    // socket to a stale workspace after a switch.
    const userId = session?.user?.id;
    const sessionId = session?.session?.id;
    if (!userId || !sessionId) {
      return { kind: "unauthenticated" };
    }

    // After a Caddy bounce / deploy a whole team's tabs reconnect within
    // seconds; without the cache, every handshake paid an independent
    // `user.findUnique` deactivation check. The HTTP SessionGuard already
    // maintains a 15s snapshot; reuse it so socket handshakes get the same
    // single-DB-hit-per-window economics.
    const cookieCandidate = readActiveWorkspaceCookie(cookieHeader);
    // The snapshot cache is keyed by (userId, workspaceId), so this can only be
    // consulted once we know which workspace THIS handshake wants — i.e. when
    // the `ccp.ws` cookie names one. Without it there is no key, and guessing
    // would be exactly how a socket joins the wrong `ws:` room; that case falls
    // through to the full resolve below. Mirrors the HTTP guard.
    const cached = cookieCandidate ? sessionCacheGet(userId, cookieCandidate) : null;
    if (cached) {
      // I-10: same org-approval re-check on this fast path (see the cookie-cache
      // branch above) so a warm cache can't bypass the gate.
      if (!cached.isSuperAdmin && !cached.emailVerified) {
        return { kind: "gated" };
      }
      if (!cached.isSuperAdmin && cached.orgStatus !== "active") {
        return { kind: "gated" };
      }
      sessionCacheSetByCookie(cookieHeader, userId, sessionId, cached.workspaceId);
      return {
        kind: "ok",
        identity: {
          userId,
          workspaceId: cached.workspaceId,
          role: cached.role,
          agentConversationVisibility: cached.agentConversationVisibility,
        },
      };
    }

    let dbUser;
    try {
      dbUser = await this.db.user.findUnique({
        where: { id: userId },
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
          // Mirrors resolveSession: the socket's active workspace is resolved
          // from the SAME membership set, so an agent's socket can never join a
          // workspace room their HTTP session wouldn't grant.
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
    } catch (err) {
      this.logger.warn(
        `socket auth: user.findUnique threw: ${err instanceof Error ? err.message : err}`,
      );
      return { kind: "unavailable" };
    }
    if (!dbUser) return { kind: "unauthenticated" };
    if (dbUser.deactivatedAt) return { kind: "unauthenticated" };
    // Org-approval gate (mirrors the HTTP SessionGuard). A pending/suspended
    // org's socket is treated as unauthenticated so the client cuts over; the
    // RSC layer has already bounced the tab to /pending. Checked in the slow
    // path only, same as the deactivation check above — a fast-path cache hit
    // means the user passed this check within the 15s window. superAdmins exempt.
    const orgStatus = (dbUser.organization?.status ?? "active") as OrgStatus;
    if (!dbUser.isSuperAdmin && !dbUser.emailVerified) {
      return { kind: "gated" };
    }
    if (!dbUser.isSuperAdmin && orgStatus !== "active") {
      return { kind: "gated" };
    }

    // Same resolution — and the same security-critical org scope — as
    // resolveSession, via the ONE shared rule in
    // `@ccp/shared/auth/active-workspace`. The `ccp.ws` cookie can only SELECT
    // a workspace this user may act in: a membership (fast path), any workspace
    // for a superAdmin, or a workspace IN THEIR OWN ORG for an org admin/owner.
    // The org scope is verified against the DB; trusting `isOrgAdmin` unscoped
    // let any org owner join another tenant's `ws:` room and stream its
    // realtime frames.
    const memberships = dbUser.workspaceMemberships;
    const isOrgAdmin = dbUser.orgRole === "owner" || dbUser.orgRole === "admin";
    const memberWorkspaceIds = new Set(memberships.map((m) => m.workspace.id));

    const canAccess = makeCanAccessBeyondMembership({
      isSuperAdmin: dbUser.isSuperAdmin,
      isOrgAdmin,
      organizationId: dbUser.organizationId,
      memberWorkspaceIds,
      countWorkspaces: (where) => this.db.workspace.count({ where }),
    });

    // The stored per-device choice is consulted here too — it used to be
    // skipped on this path, so a tab whose `ccp.ws` cookie was missing joined
    // `ws:<first membership>` while its HTTP requests ran against the switched
    // workspace, and the whole realtime feed silently belonged to the wrong one.
    const stored =
      cookieCandidate && (await canAccess(cookieCandidate))
        ? null
        : await this.db.session.findUnique({
            where: { id: sessionId },
            select: { activeWorkspaceId: true },
          });
    const activeWorkspaceId = await resolveActiveWorkspaceId({
      memberships: memberships.map((m) => ({ workspaceId: m.workspace.id })),
      cookieCandidate,
      storedWorkspaceId: stored?.activeWorkspaceId ?? null,
      canAccessBeyondMembership: canAccess,
    });
    // Zero resolvable workspaces (removed from all of them, org still active)
    // is a GATE, not a dead session: `unauthenticated` makes the client
    // navigate to /logout, which DELETES a session the HTTP path would have
    // kept — the exact conflation the `gated` kind exists to prevent. The
    // server-rendered layout routes a workspace-less member to the right
    // explanation screen on the reload.
    if (!activeWorkspaceId) return { kind: "gated" };

    const active = memberships.find((m) => m.workspace.id === activeWorkspaceId);
    const effectiveRole: Role =
      dbUser.isSuperAdmin || isOrgAdmin ? "admin" : ((active?.role ?? "agent") as Role);
    const visibility = active?.workspace.agentConversationVisibility ?? "team";

    sessionCacheSet({
      sessionId,
      userId: dbUser.id,
      organizationId: dbUser.organizationId,
      orgRole: dbUser.orgRole,
      isSuperAdmin: dbUser.isSuperAdmin,
      emailVerified: dbUser.emailVerified,
      workspaceId: activeWorkspaceId,
      role: effectiveRole,
      workspaceMemberships: memberships.map((m) => ({
        workspaceId: m.workspace.id,
        name: m.workspace.name,
        role: m.role as Role,
      })),
      name: dbUser.name,
      email: dbUser.email,
      agentConversationVisibility: visibility,
      avatarUrl: dbUser.avatarUrl ?? null,
      orgStatus,
      rolePermissions: active?.workspace.rolePermissions ?? {},
    });
    sessionCacheSetByCookie(cookieHeader, dbUser.id, sessionId, activeWorkspaceId);
    return {
      kind: "ok",
      identity: {
        userId,
        workspaceId: activeWorkspaceId,
        role: effectiveRole,
        agentConversationVisibility: visibility,
      },
    };
  }
}
