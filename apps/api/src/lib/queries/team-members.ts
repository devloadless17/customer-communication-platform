import { db } from "@/lib/db";
import type { User } from "@ccp/shared/types";

import { mapUser } from "./_shared";

export async function listTeamMembers(teamId: string): Promise<User[]> {
  const rows = await db.user.findMany({ where: { teamId }, orderBy: { name: "asc" } });
  return rows.map(mapUser);
}
