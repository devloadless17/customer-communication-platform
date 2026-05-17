import { Injectable, Logger } from "@nestjs/common";
import type { Socket } from "socket.io";

import { auth } from "@/lib/auth/better-auth";
import type { Role } from "@ccp/shared/types";

import { PrismaService } from "../prisma/prisma.service";

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

  constructor(private readonly prisma: PrismaService) {}

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

      const dbUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { deactivatedAt: true },
      });
      if (!dbUser || dbUser.deactivatedAt) return null;

      return { userId, teamId, role };
    } catch (err) {
      this.logger.warn(
        `socket auth threw: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }
}
