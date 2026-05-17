import "server-only";

import { cache } from "react";

import { db } from "@/lib/db";

/**
 * Per-request loader for the current user, with the deactivation check
 * baked in. Used by both server-component (`getSession`) and API-route
 * (`requireSession`) entry points.
 *
 * Why this exists: the JWT is the only thing middleware sees, and it
 * doesn't know about `deactivatedAt`. Without re-checking the DB, an
 * admin who deactivates a user has to wait up to 14 days for the user's
 * cookie to expire. This loader closes that gap.
 *
 * Wrapped in `React.cache` so multiple callers in the same render share
 * one DB hit. Cache resets between requests.
 */
export const loadActiveUser = cache(async (userId: string) => {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.deactivatedAt) return null;
  return user;
});
