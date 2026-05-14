import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { loadActiveUser } from "@/lib/auth/active-user";
import { auth } from "@/lib/auth";
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
 * Wrapped in `React.cache` so layouts + pages + child server components in
 * the same render share one auth() call and one DB hit, instead of each
 * paying the round-trip. Per-request memoization — cache resets between
 * navigations.
 */

export interface Session {
  user: User;
  teamId: string;
}

export const getSession = cache(async (): Promise<Session> => {
  const session = await auth();
  // The ?invalid=1 marker tells middleware to clear the session cookie when
  // it serves /login — otherwise middleware sees the still-valid-looking JWT
  // and bounces back here, producing an infinite redirect that only resolves
  // when the user manually clears cookies. This branch covers JWTs that
  // decode but lack a usable user.id (malformed / schema-mismatched cookies).
  if (!session?.user?.id) {
    redirect("/login?invalid=1");
  }

  // Hydrate from the DB so we always have current name/avatar/role and to
  // catch users that were deactivated in another tab. JWT sessions cache
  // attributes for the token's lifetime; the DB is the source of truth.
  // Same ?invalid=1 marker: the JWT is still cryptographically valid here
  // (middleware let us through), but the underlying user is gone or
  // deactivated. Without the marker, middleware would just bounce us back.
  const row = await loadActiveUser(session.user.id);
  if (!row) {
    redirect("/login?invalid=1");
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
});
