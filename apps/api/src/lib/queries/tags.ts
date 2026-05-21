import { db } from "@/lib/db";
import type { Tag, TagColor } from "@ccp/shared/types";

export async function listTags(teamId: string): Promise<Tag[]> {
  const rows = await db.tag.findMany({
    where: { teamId },
    orderBy: [{ createdAt: "desc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    color: r.color as TagColor,
    createdAt: r.createdAt.toISOString(),
  }));
}
