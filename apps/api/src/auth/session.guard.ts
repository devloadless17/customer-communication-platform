import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { auth } from "@/lib/auth/better-auth";
import type { Role } from "@ccp/shared/types";

import { PrismaService } from "../prisma/prisma.service";

/**
 * Shape attached to req.session on success. Mirrors `ApiSession` from
 * [lib/auth/helpers.ts](../../../../../lib/auth/helpers.ts) exactly — same
 * fields, same types — so controllers feel identical to the Next.js
 * handlers they're replacing.
 */
export interface ApiSession {
  userId: string;
  teamId: string;
  role: Role;
  name: string;
  email: string;
}

declare module "express-serve-static-core" {
  interface Request {
    session?: ApiSession;
  }
}

/**
 * Validates the Better Auth session cookie issued by Next.js, then
 * re-checks the underlying user for soft-deletion (deactivatedAt). This is
 * the exact pair of checks done by `requireSession()` in
 * [lib/auth/helpers.ts](../../../../../lib/auth/helpers.ts).
 *
 * We call `auth.api.getSession({ headers })` rather than parsing the cookie
 * directly so cookie signing, expiry, and refresh-window semantics stay in
 * one place (the Better Auth config). Cost: one DB roundtrip for the
 * session row, one for the user — same as the Next.js side.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger(SessionGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const session = await resolveSession(req, this.prisma, this.logger);
    if (!session) throw new UnauthorizedException("unauthorized");
    req.session = session;
    return true;
  }
}

/**
 * Shared resolver: cookie → Better Auth → active-user recheck. Exported so
 * the Socket.io handshake can reuse the exact same logic without re-implementing
 * any of the auth flow.
 */
export async function resolveSession(
  req: Request,
  prisma: PrismaService,
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

  // Deactivation re-check — same reason as lib/auth/helpers.ts:
  // middleware sees only the cookie/JWT, not deactivatedAt. Without this
  // an admin's deactivation is up to 90 days late for API calls.
  const user = await prisma.user.findUnique({
    where: { id: result.user.id },
  });
  if (!user || user.deactivatedAt) return null;

  return {
    userId: user.id,
    teamId: user.teamId,
    role: user.role as Role,
    name: user.name,
    email: user.email,
  };
}
