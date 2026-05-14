import { getSession } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import type { Role } from "@/lib/types";

import { TeamSettings, type TeamUserRow } from "./team-settings";

export const metadata = { title: "Team · Settings" };

export default async function TeamSettingsPage() {
  const { user, teamId } = await getSession();

  const rows = await db.user.findMany({
    where: { teamId },
    orderBy: [{ deactivatedAt: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      deactivatedAt: true,
      createdAt: true,
    },
  });

  const users: TeamUserRow[] = rows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role as Role,
    deactivated: u.deactivatedAt !== null,
    createdAt: u.createdAt.toISOString(),
  }));

  return (
    <TeamSettings
      currentUserId={user.id}
      currentUserRole={user.role}
      users={users}
    />
  );
}
