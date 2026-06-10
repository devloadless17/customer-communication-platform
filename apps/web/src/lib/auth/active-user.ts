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
      teamId: true,
      role: true,
      name: true,
      email: true,
      avatarUrl: true,
      deactivatedAt: true,
      availabilityStatus: true,
      availabilityMessage: true,
      // `status` powers the org-approval gate in (app)/layout.tsx. Loaded here
      // (alongside rolePermissions) so the gate never has to call the now
      // org-gated /api/team endpoint for a pending/suspended org.
      team: { select: { rolePermissions: true, status: true } },
    },
  });
  if (!user || user.deactivatedAt) return null;
  return user;
});
