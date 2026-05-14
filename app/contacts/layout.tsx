import { getSession } from "@/lib/auth/current-user";
import { listTeamMembers } from "@/lib/queries";
import { db } from "@/lib/db";

import { WorkspaceSidebar } from "@/components/layouts/workspace-sidebar";

/**
 * Sidebar shell for /contacts. Server component — gates the session and
 * seeds the sidebar with team + teammates so the nav looks the same
 * everywhere in the app.
 */
export default async function ContactsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, teamId } = await getSession();

  const [team, teammates] = await Promise.all([
    db.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true },
    }),
    listTeamMembers(teamId),
  ]);

  if (!team) {
    throw new Error("team not found");
  }

  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <WorkspaceSidebar
        currentUser={user}
        team={{ id: team.id, name: team.name }}
        teammates={teammates}
      />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
