import { getSession } from "@/lib/auth/current-user";
import { listTeamMembers } from "@/lib/queries";
import { db } from "@/lib/db";

import { AppSidebar } from "@/components/layouts/app-sidebar";

/**
 * Sidebar shell for /broadcasts/*. Server component — gates the session
 * and seeds the sidebar with team + teammates so the nav looks the same
 * everywhere in the app.
 */
export default async function BroadcastsLayout({
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
    // Session resolves the team, so this is a degenerate state — guard the
    // type without doing anything fancy.
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
