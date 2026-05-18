import { Injectable, Logger } from "@nestjs/common";
import type { Socket } from "socket.io";

import { auth } from "@/auth/better-auth";
import type { Role } from "@ccp/shared/types";

import { DbService } from "../db/db.service";
import { sessionCacheGet, sessionCacheSet } from "../auth/session.guard";

export interface SocketIdentity {
  userId: string;
  teamId: string;
  role: Role;
}

/**
 * Socket.io handshake authentication. Runs once per real connect (not once
 * per recovered reconnect — see `skipMiddlewares` in ws-adapter.ts).
 *
 * Mirrors lib/socket/server.ts exactly:
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

  async authenticate(socket: Socket): Promise<SocketIdentity | null> {
    try {
      const headers = new Headers();
      const cookieHeader = socket.handshake.headers.cookie;
      if (cookieHeader) headers.set("cookie", cookieHeader);

      const session = await auth.api.getSession({ headers });
      const userId = session?.user?.id;
      const teamId = (session?.user as { teamId?: string } | undefined)?.teamId;
      const role = (session?.user as { role?: Role } | undefined)?.role;
      if (!userId || !teamId || !role) return null;

      // After a Caddy bounce / deploy a whole team's tabs reconnect within
      // seconds; without the cache, every handshake paid an independent
      // `user.findUnique` deactivation check. The HTTP SessionGuard
      // already maintains a 15s per-userId snapshot; reuse it so socket
      // handshakes get the same single-DB-hit-per-window economics.
      const cached = sessionCacheGet(userId);
      if (cached) {
        return { userId, teamId: cached.teamId, role: cached.role };
      }
      const dbUser = await this.db.user.findUnique({
        where: { id: userId },
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
      if (!dbUser || dbUser.deactivatedAt) return null;
      sessionCacheSet(userId, {
        userId: dbUser.id,
        teamId: dbUser.teamId,
        role: dbUser.role as Role,
        name: dbUser.name,
        email: dbUser.email,
        avatarUrl: dbUser.avatarUrl ?? null,
      });
      return { userId, teamId: dbUser.teamId, role: dbUser.role as Role };
    } catch (err) {
      this.logger.warn(
        `socket auth threw: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}
