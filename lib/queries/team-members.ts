import "server-only";

import { unstable_cache } from "next/cache";

import { db } from "@/lib/db";
import type { User } from "@/lib/types";

import { mapUser } from "./_shared";

/**
 * All teammates — used by the assignment dropdown and sidebar list.
 *
 * Cached because every conversation switch refetches this for the message
 * thread and contact panel, but the underlying row set only changes when an
 * admin invites/removes someone (minutes-to-days apart, not seconds).
 * 60s revalidation keeps the dropdown reasonably fresh without a per-switch
 * round-trip. `revalidateTag(`team:${teamId}:members`)` from the invite /
 * remove flows will eventually be needed for instant propagation.
 */
export const listTeamMembers = unstable_cache(
  async (teamId: string): Promise<User[]> => {
    const rows = await db.user.findMany({ where: { teamId }, orderBy: { name: "asc" } });
    return rows.map(mapUser);
  },
  ["listTeamMembers"],
  { revalidate: 60, tags: ["team-members"] },
);
