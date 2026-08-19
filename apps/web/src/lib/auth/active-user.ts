import "server-only";

import { cache } from "react";

import { db } from "@/lib/db";

/**
 * Per-request loader for the current user, with the deactivation check
 * baked in. Used by `getSession()` in lib/auth/current-user.ts to hydrate
 * the session payload that pages + layouts render against.
 *
 * Why this exists: the signed cookie is the only thing the edge proxy sees,
 * and it doesn't know about `deactivatedAt`. Without re-checking the DB, an
 * admin who deactivates a user has to wait up to 90 days for the cookie to
 * expire. This loader closes that gap.
 *
 * Wrapped in `React.cache` so layouts + pages + nested server components in
 * the same render share one DB hit. Cache resets between requests.
 *
 * Narrow select: only the fields `getSession()` actually returns to the
 * client tree. Keeps row size predictable and stops a wide `findUnique`
 * from dragging in any new columns added to the User table later.
 */
export const loadActiveUser = cache(async (userId: string) => {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      organizationId: true,
      orgRole: true,
      isSuperAdmin: true,
      name: true,
      email: true,
      avatarUrl: true,
      deactivatedAt: true,
      // Drives the /verify bounce in getSession(). The API's session guard is
      // the real gate; this only decides where the browser lands so an
      // unverified user sees the code screen instead of a wall of 403s.
      emailVerified: true,
      availabilityStatus: true,
      availabilityMessage: true,
      // Schedule provenance, so the availability picker can explain an
      // automatic status ("Outside working hours", "set by an admin") on the
      // FIRST paint. Without these the context line only appeared once a socket
      // frame happened to arrive — i.e. never, on a quiet page.
      availabilitySource: true,
      availabilityOverrideUntil: true,
      // `status` powers the org-approval gate in (app)/layout.tsx. Loaded here
      // (alongside rolePermissions) so the gate never has to call the now
      // org-gated /api/workspace endpoint for a pending/suspended org.
      //
      // `workspaces` is the switcher's list for an ORG OWNER/ADMIN, who may open
      // any workspace in their org regardless of membership. Ordered to match
      // the API's `GET /api/workspaces` so the two render the same sequence —
      // and filtered the same way: a workspace claimed for deletion is
      // mid-drain, and this list also answers the org-scoped beyond-membership
      // probe in current-user.ts, which must not resolve one.
      organization: {
        select: {
          status: true,
          name: true,
          workspaces: {
            where: { deletingAt: null },
            orderBy: { createdAt: "asc" },
            select: { id: true, name: true },
          },
        },
      },
      // Active workspace + effective role come from membership now (mirrors the
      // API resolveSession); ordered so the fallback pick is deterministic.
      workspaceMemberships: {
        orderBy: { createdAt: "asc" },
        select: {
          role: true,
          workspace: { select: { id: true, name: true, rolePermissions: true } },
        },
      },
      // Every live session's stored active workspace. `getSession` needs THIS
      // DEVICE's, keyed by the Better Auth session token it already holds — it
      // is the fallback when the `ccp.ws` cookie is missing, exactly as
      // `resolveSession` does on the API side. Sessions are per-device and few
      // (one row per active sign-in), so carrying them costs a tiny join rather
      // than a second query on every render.
      sessions: {
        where: { expiresAt: { gt: new Date() } },
        select: { id: true, activeWorkspaceId: true },
      },
    },
  });
  if (!user || user.deactivatedAt) return null;
  return user;
});
