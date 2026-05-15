import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { loadActiveUser } from "@/lib/auth/active-user";
import { getCurrentSession } from "@/lib/auth";
import type { User } from "@/lib/types";

/**
 * Server-component helper. Resolves the current authenticated user, or
 * bounces through /logout (which clears the session cookie and redirects
 * to /login) when there's no valid session.
 *
 * Why /logout instead of plain redirect("/login"): server components can't
 * mutate cookies. If the session row is gone but the cookie is still
 * present, a direct /login redirect leaves the cookie in place — the next
 * navigation re-enters this function, which redirects again, in a loop
 * that only the browser can break by clearing storage. Routing through
 * /logout (a route handler that CAN mutate cookies) clears the session
 * and stops the loop in one trip.
 *
 * Wrapped in `React.cache` so layouts + pages + child server components in
 * the same render share one auth check and one DB hit, instead of each
 * paying the round-trip. Per-request memoization — cache resets between
 * navigations.
 */

export interface Session {
  user: User;
  teamId: string;
}

export const getSession = cache(async (): Promise<Session> => {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    redirect("/logout");
  }

  // Hydrate from the DB so we always have current name/avatar/role and to
  // catch users that were deactivated in another tab. Better Auth's session
  // payload (and the cookieCache) are the framework's view; the User row
  // is the domain truth for `deactivatedAt`.
  const row = await loadActiveUser(session.user.id);
  if (!row) {
    redirect("/logout");
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
