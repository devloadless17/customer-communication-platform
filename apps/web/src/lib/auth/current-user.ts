import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { loadActiveUser } from "@/lib/auth/active-user";
import { getCurrentSession } from "@/lib/auth";
import { resolvePermissions } from "@ccp/shared/auth/permissions";
import type { Capability } from "@ccp/shared/auth/permissions";
import type { TeamStatus, User, UserAvailabilityStatus } from "@ccp/shared/types";

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
  /**
   * Org-approval status of the user's team. The (app) layout reads this to
   * gate pending/suspended orgs to /pending. Carried on the session (loaded in
   * the same `loadActiveUser` query) so the gate never depends on the org-gated
   * /api/team call. superAdmins are exempt from the gate regardless.
   */
  teamStatus: TeamStatus;
  /**
   * Effective per-capability map for this user's role, with the team admin's
   * overrides already applied. Pass the relevant boolean down to client
   * components to hide/disable gated actions. UI gating is UX only — the
   * NestJS guards are the real enforcement.
   */
  permissions: Record<Capability, boolean>;
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
      // `loadActiveUser` already gated on deactivatedAt === null, so any row
      // that reaches here is active. Spelled out so the type lines up with
      // `User`.
      isActive: true,
      ...(row.availabilityStatus
        ? {
            availabilityStatus: row.availabilityStatus as UserAvailabilityStatus,
          }
        : {}),
      ...(row.availabilityMessage
        ? { availabilityMessage: row.availabilityMessage }
        : {}),
    },
    teamId: row.teamId,
    teamStatus: (row.team?.status ?? "active") as TeamStatus,
    permissions: resolvePermissions(row.role, row.team?.rolePermissions ?? {}),
  };
});
