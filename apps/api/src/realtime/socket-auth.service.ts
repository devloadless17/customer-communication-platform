import { Injectable, Logger } from "@nestjs/common";
import type { Socket } from "socket.io";

import { auth } from "@/auth/better-auth";
import type { Role, TeamStatus } from "@ccp/shared/types";

import { DbService } from "../db/db.service";
import {
  sessionCacheGet,
  sessionCacheGetByCookie,
  sessionCacheSet,
  sessionCacheSetByCookie,
} from "../auth/session.guard";

export interface SocketIdentity {
  userId: string;
  teamId: string;
  role: Role;
  /** `Team.agentConversationVisibility` — decides whether this socket may join
   *  the team firehose room. See RealtimeGateway.handleConnection. */
  agentConversationVisibility: string;
}

export type SocketAuthResult =
  | { kind: "ok"; identity: SocketIdentity }
  | { kind: "unauthenticated" }
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
      // entry carries teamStatus (refreshed at least every 15s), so a
      // suspended/pending org's reconnect is cut over here instead of slipping
      // through because the cookie cache was warm — matching the slow path below
      // and the HTTP SessionGuard, which re-checks teamStatus on every request.
      if (
        cachedFromCookie.role !== "superAdmin" &&
        cachedFromCookie.teamStatus !== "active"
      ) {
        return { kind: "unauthenticated" };
      }
      return {
        kind: "ok",
        identity: {
          userId: cachedFromCookie.userId,
          teamId: cachedFromCookie.teamId,
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

    const userId = session?.user?.id;
    const sessionId = session?.session?.id;
    const teamId = (session?.user as { teamId?: string } | undefined)?.teamId;
    const role = (session?.user as { role?: Role } | undefined)?.role;
    if (!userId || !sessionId || !teamId || !role) {
      return { kind: "unauthenticated" };
    }

    // After a Caddy bounce / deploy a whole team's tabs reconnect within
    // seconds; without the cache, every handshake paid an independent
    // `user.findUnique` deactivation check. The HTTP SessionGuard
    // already maintains a 15s per-userId snapshot; reuse it so socket
    // handshakes get the same single-DB-hit-per-window economics.
    const cached = sessionCacheGet(userId);
    if (cached) {
      // I-10: same org-approval re-check on this fast path (see the cookie-cache
      // branch above) so a warm per-userId cache can't bypass the gate.
      if (cached.role !== "superAdmin" && cached.teamStatus !== "active") {
        return { kind: "unauthenticated" };
      }
      sessionCacheSetByCookie(cookieHeader, userId, sessionId);
      return {
        kind: "ok",
        identity: {
          userId,
          teamId: cached.teamId,
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
          teamId: true,
          role: true,
          name: true,
          email: true,
          avatarUrl: true,
          deactivatedAt: true,
          team: {
            select: {
              rolePermissions: true,
              status: true,
              agentConversationVisibility: true,
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
    const teamStatus = (dbUser.team?.status ?? "active") as TeamStatus;
    if (dbUser.role !== "superAdmin" && teamStatus !== "active") {
      return { kind: "unauthenticated" };
    }
    sessionCacheSet(userId, {
      sessionId,
      userId: dbUser.id,
      teamId: dbUser.teamId,
      role: dbUser.role as Role,
      name: dbUser.name,
      email: dbUser.email,
      agentConversationVisibility: dbUser.team?.agentConversationVisibility ?? "team",
      avatarUrl: dbUser.avatarUrl ?? null,
      teamStatus,
      rolePermissions: dbUser.team?.rolePermissions ?? {},
    });
    sessionCacheSetByCookie(cookieHeader, dbUser.id, sessionId);
    return {
      kind: "ok",
      identity: {
        userId,
        teamId: dbUser.teamId,
        role: dbUser.role as Role,
        agentConversationVisibility:
          dbUser.team?.agentConversationVisibility ?? "team",
      },
    };
  }
}
