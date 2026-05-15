import { getSession } from "@/lib/auth/current-user";
import { listTeamMembers } from "@/lib/queries";
import { db } from "@/lib/db";

import { AppSidebar } from "@/components/layouts/app-sidebar";

/**
 * Sidebar shell for /automations/*. Mirrors broadcasts/contacts layouts so
 * the chrome is identical everywhere.
 */
export default async function AutomationsLayout({
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
      <AppSidebar
        currentUser={user}
        team={{ id: team.id, name: team.name }}
        teammates={teammates}
      />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
