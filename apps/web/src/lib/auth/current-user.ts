import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { loadActiveUser } from "@/lib/auth/active-user";
import { getCurrentSession } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  ACTIVE_WORKSPACE_COOKIE,
  makeCanAccessBeyondMembership,
  resolveActiveWorkspaceId,
} from "@ccp/shared/auth/active-workspace";
import { resolvePermissions } from "@ccp/shared/auth/permissions";
import type { Capability } from "@ccp/shared/auth/permissions";
import type { OrgRole, OrgStatus, Role, User, UserAvailabilityStatus } from "@ccp/shared/types";
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
   * The org this user belongs to. Needed wherever a decision is about the
   * TENANT rather than the active workspace — the platform pages gate
   * "is this my own organization?" on it, because comparing workspace ids
   * mistakes a sibling workspace of your own org for someone else's.
   */
  organizationId: string;
  /**
   * Org-level role (owner/admin/member), distinct from `user.role`, which is
   * the *effective workspace* role. Deleting the organization is owner-only,
   * so the UI has to gate on this rather than on workspace-admin.
   */
  orgRole: OrgRole;
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

  // Unverified signup → the code screen, not the app.
  //
  // This is a ROUTING decision, not the security boundary: the API's
  // `resolveSession` independently refuses an unverified session, so an
  // attacker skipping the browser gains nothing. Without this the user would
  // technically be "logged in" and see every panel fail with 403 instead of
  // being told what to do.
  //
  // superAdmins are exempt for the same reason as in the API gate — the
  // platform operator is seeded, not self-registered.
  // (Not carried on the returned DTO: past this point every user is either
  // verified or a superAdmin, so a field that is always true would only invite
  // a redundant second check downstream.)
  if (!row.isSuperAdmin && !row.emailVerified) {
    redirect("/verify");
  }

  // Active workspace — the SAME rule the API's `resolveSession` and the socket
  // handshake use (`@ccp/shared/auth/active-workspace`), fed with the SAME
  // inputs: the `ccp.ws` cookie, then this device's stored choice, then the
  // first membership.
  //
  // This used to be a bare `workspaceMemberships[0]`, on the belief that an RSC
  // can't read request cookies. It can — `cookies()` works here exactly as it
  // does in the (app) layout. The consequence of getting it wrong was a render
  // split across two tenants: the rail and `/api/workspace` (cookie-aware) said
  // workspace B while `workspaceId`, the effective role and the whole
  // capability map still described workspace A. Presence frames were filtered
  // against the wrong id and simply vanished; admin-only UI was gated on the
  // wrong workspace's role.
  //
  // The beyond-membership escape (org owner/admin in their OWN org, superAdmin
  // anywhere — both DB/list-VERIFIED, so the browser never widens its own
  // scope) is applied here for the same reason: the switcher below offers an
  // org admin every org workspace and `setActive` accepts the switch, so a
  // resolver WITHOUT the escape re-created the exact split-tenant render this
  // comment describes — the API said workspace B while every page rendered
  // workspace A. Same rule, same four callers, one definition.
  const isOrgAdmin = row.orgRole === "owner" || row.orgRole === "admin";
  const orgWorkspaceIds = new Set((row.organization?.workspaces ?? []).map((w) => w.id));
  const canAccess = makeCanAccessBeyondMembership({
    isSuperAdmin: row.isSuperAdmin,
    isOrgAdmin,
    organizationId: row.organizationId,
    memberWorkspaceIds: new Set(row.workspaceMemberships.map((m) => m.workspace.id)),
    countWorkspaces: async (where) => {
      // Org-scoped probes answer from the already-loaded org workspace list —
      // no extra query. Only a superAdmin probing OUTSIDE their org (rare;
      // platform surfaces) pays a DB roundtrip.
      if (where.organizationId === row.organizationId) {
        return orgWorkspaceIds.has(where.id) ? 1 : 0;
      }
      return db.workspace.count({ where });
    },
  });
  const cookieStore = await cookies();
  const activeWorkspaceId = await resolveActiveWorkspaceId({
    memberships: row.workspaceMemberships.map((m) => ({ workspaceId: m.workspace.id })),
    cookieCandidate: cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null,
    storedWorkspaceId:
      row.sessions.find((s) => s.id === session.session.id)?.activeWorkspaceId ?? null,
    canAccessBeyondMembership: canAccess,
    // Zero-membership org owner (they removed themselves from every
    // workspace): without a fallback this resolves null and the redirect
    // below clears the cookie, so the next login loops straight back here.
    // Answered from the already-loaded org workspace list — no extra query —
    // and still DB/list-verified through `canAccess`.
    beyondMembershipFallbacks: isOrgAdmin
      ? (row.organization?.workspaces ?? []).map((w) => w.id).slice(0, 1)
      : [],
  });
  // No workspace to act in = unauthenticated, exactly like the API guard's
  // null → 401. This used to fall through as `?? ""` and render the whole app
  // tree against an EMPTY tenant scope.
  if (!activeWorkspaceId) {
    redirect("/logout");
  }
  // No `?? workspaceMemberships[0]` fallback: in the beyond-membership case
  // there IS no membership row, and falling back applied a DIFFERENT
  // workspace's rolePermissions to this one. undefined is correct — the
  // effective role resolves to "admin" below, and resolvePermissions ignores
  // the per-workspace config for admins.
  const activeMembership = row.workspaceMemberships.find(
    (m) => m.workspace.id === activeWorkspaceId,
  );
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
    organizationId: row.organizationId,
    orgRole: row.orgRole as OrgRole,
    orgStatus: (row.organization?.status ?? "active") as OrgStatus,
    permissions: resolvePermissions(effectiveRole, activeMembership?.workspace.rolePermissions ?? {}),
    organizationName: row.organization?.name ?? "",
    // Every workspace this person may OPEN, which for an org owner/admin is the
    // whole organization — not just the ones they hold a membership row in.
    // `GET /api/workspaces` applies the same rule; if this list were narrower
    // the rail would omit a workspace the Organization page offers to open, and
    // an org admin sitting in a non-membership workspace would see no entry
    // marked active.
    workspaces: isOrgAdmin
      ? row.organization.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          // No membership row → they are here by org authority, which resolves
          // to admin everywhere in the org.
          role: (row.workspaceMemberships.find((m) => m.workspace.id === w.id)?.role ??
            "admin") as Role,
        }))
      : row.workspaceMemberships.map((m) => ({
          id: m.workspace.id,
          name: m.workspace.name,
          role: m.role as Role,
        })),
  };
});
