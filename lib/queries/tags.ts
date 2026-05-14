import "server-only";

import { unstable_cache } from "next/cache";

import { db } from "@/lib/db";
import type { Tag, TagColor } from "@/lib/types";

/**
 * Cached: same rationale as `listTeamMembers`. Tag catalog rarely changes —
 * admin creates a tag and that's it. 60s revalidation.
 */
export const listTags = unstable_cache(
  async (teamId: string): Promise<Tag[]> => {
    const rows = await db.tag.findMany({
      where: { teamId },
      orderBy: [{ name: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      teamId: r.teamId,
      name: r.name,
      color: r.color as TagColor,
    }));
  },
  ["listTags"],
  { revalidate: 60, tags: ["tags"] },
);
