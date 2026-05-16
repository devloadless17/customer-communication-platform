import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import type { Role } from "@/lib/types";

import { TeamSettings, type PendingInviteRow, type TeamUserRow } from "./team-settings";

export const metadata = { title: "Team · Settings" };

export default async function TeamSettingsPage() {
  const { user, teamId } = await getSession();
  const isAdmin = canManageUsers(user.role);

  // Team name + members + pending invites in parallel. Pending invites are
  // an admin-only concern — skip the query entirely for agent viewers
  // (they can't see the panel anyway and the route would 403 them).
  const [team, rows, pendingInviteRows] = await Promise.all([
    db.team.findUnique({ where: { id: teamId }, select: { name: true } }),
    db.user.findMany({
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
    }),
    isAdmin
      ? db.invite.findMany({
          where: {
            teamId,
            acceptedAt: null,
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            email: true,
            role: true,
            expiresAt: true,
            createdAt: true,
            createdBy: { select: { name: true } },
          },
        })
      : Promise.resolve([] as Array<never>),
  ]);

  const users: TeamUserRow[] = rows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role as Role,
    deactivated: u.deactivatedAt !== null,
    createdAt: u.createdAt.toISOString(),
  }));

  const pendingInvites: PendingInviteRow[] = pendingInviteRows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role as Role,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    createdByName: r.createdBy?.name ?? "Removed user",
  }));

  return (
    <TeamSettings
      currentUserId={user.id}
      currentUserRole={user.role}
      teamName={team?.name ?? "your organization"}
      users={users}
      pendingInvites={pendingInvites}
    />
  );
}
