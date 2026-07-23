import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { loadActiveUser } from "@/lib/auth/active-user";
import { getCurrentSession } from "@/lib/auth";
import { resolvePermissions } from "@ccp/shared/auth/permissions";
import type { Capability } from "@ccp/shared/auth/permissions";
import type { OrgStatus, Role, User, UserAvailabilityStatus } from "@ccp/shared/types";
import type { AvailabilitySource } from "@ccp/shared/work-hours";

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
  workspaceId: string;
  /**
   * Org-approval status of the user's team. The (app) layout reads this to
   * gate pending/suspended orgs to /pending. Carried on the session (loaded in
   * the same `loadActiveUser` query) so the gate never depends on the org-gated
   * /api/workspace call. superAdmins are exempt from the gate regardless.
   */
  orgStatus: OrgStatus;
  /**
   * Effective per-capability map for this user's role, with the team admin's
   * overrides already applied. Pass the relevant boolean down to client
   * components to hide/disable gated actions. UI gating is UX only — the
   * NestJS guards are the real enforcement.
   */
  permissions: Record<Capability, boolean>;
  /**
   * Every workspace this user may act in, for the rail switcher. Comes off the
   * same `loadActiveUser` query, so rendering the switcher costs no extra read.
   */
  workspaces: Array<{ id: string; name: string; role: Role }>;
  /** The organization above those workspaces — the switcher's header, and the
   *  thing Organization settings is about. */
  organizationName: string;
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

  // Mirrors the API's resolveSession: an org owner/admin (and a platform
  // superAdmin) is implicitly admin in every workspace; otherwise the role
  // comes from the membership row for the active workspace. RSC has no request
  // cookie access here, so it falls back to the first membership — the API is
  // the authority for a switched workspace.
  const isOrgAdmin = row.orgRole === "owner" || row.orgRole === "admin";
  const activeMembership = row.workspaceMemberships[0];
  const activeWorkspaceId = activeMembership?.workspace.id ?? "";
  const effectiveRole: Role =
    row.isSuperAdmin || isOrgAdmin ? "admin" : ((activeMembership?.role ?? "agent") as Role);

  return {
    user: {
      id: row.id,
      workspaceId: activeWorkspaceId,
      role: effectiveRole,
      isSuperAdmin: row.isSuperAdmin,
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
      // Same terse rule as the API mapper: only when it isn't the default.
      ...(row.availabilitySource && row.availabilitySource !== "manual"
        ? { availabilitySource: row.availabilitySource as AvailabilitySource }
        : {}),
      ...(row.availabilityOverrideUntil
        ? { availabilityUntil: row.availabilityOverrideUntil.toISOString() }
        : {}),
    },
    workspaceId: activeWorkspaceId,
    orgStatus: (row.organization?.status ?? "active") as OrgStatus,
    permissions: resolvePermissions(effectiveRole, activeMembership?.workspace.rolePermissions ?? {}),
    organizationName: row.organization?.name ?? "",
    workspaces: row.workspaceMemberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.role as Role,
    })),
  };
});
