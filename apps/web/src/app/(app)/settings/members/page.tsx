import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { asWorkHours } from "@ccp/shared/work-hours";
import {
  getCurrentTeam,
  getTeamWorkHours,
  listInvites,
  listTeamMembers,
  type InviteListDto,
} from "@/lib/api/queries";

import { MembersSettings, type PendingInviteRow, type TeamUserRow } from "@/features/settings/components/members-settings";

export const metadata = { title: "Members · Settings" };

export default async function TeamSettingsPage() {
  const { user, permissions, orgRole, organizationName } = await getSession();
  const isAdmin = canManageUsers(user.role);
  // Who may set a teammate's status / edit their schedule. Admin-configurable
  // per role (default: admin + manager), so it's read from the resolved
  // capability map rather than inferred from the role.
  const canManageOthersAvailability = permissions["availability:manageOthers"];

  // Team name + members + pending invites in parallel. Pending invites are
  // an admin-only concern — skip the query for agent viewers (they can't
  // see the panel anyway and the endpoint would 403 them).
  const [team, members, pendingInviteRows, teamWorkHours] = await Promise.all([
    getCurrentTeam(),
    listTeamMembers(),
    isAdmin ? listInvites() : Promise.resolve([] as InviteListDto[]),
    getTeamWorkHours(),
  ]);

  const users: TeamUserRow[] = members
    // Match the previous db.user.findMany order (active first, then by creation).
    .slice()
    .sort((a, b) => {
      const aDeactivated = !a.isActive;
      const bDeactivated = !b.isActive;
      if (aDeactivated !== bDeactivated) return aDeactivated ? 1 : -1;
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    })
    .map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      orgRole: u.orgRole,
      deactivated: !u.isActive,
      createdAt: u.createdAt ?? "",
      avatarUrl: u.avatarUrl ?? null,
      availabilityStatus: u.availabilityStatus ?? "available",
      availabilityMessage: u.availabilityMessage ?? null,
      availabilitySource: u.availabilitySource ?? "manual",
      availabilityUntil: u.availabilityUntil ?? null,
      workHoursMode: u.workHoursMode ?? "inherit",
    }));

  const pendingInvites: PendingInviteRow[] = pendingInviteRows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    createdByName: r.createdByName,
  }));

  return (
    <MembersSettings
      currentUserId={user.id}
      currentUserRole={user.role}
      currentUserOrgRole={orgRole}
      workspaceId={user.workspaceId}
      teamName={team.name}
      // The danger zone deletes the whole ORG, so it needs the org's name for
      // its copy and its type-to-confirm — the workspace name it used to show
      // there was the wrong noun on the highest blast-radius action we have.
      organizationName={organizationName}
      users={users}
      pendingInvites={pendingInvites}
      teamWorkHours={asWorkHours(teamWorkHours)}
      canManageOthersAvailability={canManageOthersAvailability}
      isOrgOwner={orgRole === "owner"}
    />
  );
}
