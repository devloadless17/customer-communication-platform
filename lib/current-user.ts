import "server-only";

import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { User } from "@/lib/types";

/**
 * Server-component helper. Resolves the current authenticated user, or
 * redirects to /login when there's no session.
 *
 * Callers that already pass through middleware (every page under /inbox)
 * can rely on this never returning a guest. The redirect is the
 * defense-in-depth: if middleware is ever bypassed, server components
 * still bounce.
 *
 * The shape (`{ user, teamId }`) is unchanged from the Phase 0 stub so
 * existing callers don't need refactoring.
 */

export interface Session {
  user: User;
  teamId: string;
}

export async function getSession(): Promise<Session> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  // Hydrate from the DB so we always have current name/avatar/role and to
  // catch users that were deactivated in another tab. JWT sessions cache
  // attributes for the token's lifetime; the DB is the source of truth.
  const row = await db.user.findUnique({ where: { id: session.user.id } });
  if (!row || row.deactivatedAt) {
    redirect("/login");
  }

  return {
    user: {
      id: row.id,
      teamId: row.teamId,
      role: row.role,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatarUrl ?? undefined,
    },
    teamId: row.teamId,
  };
}
