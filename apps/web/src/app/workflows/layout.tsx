import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam, listTeamMembers } from "@/lib/api/queries";

import { AppSidebar } from "@/components/layouts/app-sidebar";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";

/**
 * Sidebar shell for /workflows/*. Same pattern as every other section
 * shell (broadcasts / contacts / templates / settings / team / admin) —
 * server component seeds the sidebar with the current team + teammates.
 */
export default async function WorkflowsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await getSession();

  const [team, teammates] = await Promise.all([
    getCurrentTeam(),
    listTeamMembers(),
  ]);

  return (
    <CatalogSyncBoundary>
      <div className="flex min-h-svh bg-background text-foreground">
        <AppSidebar
          currentUser={user}
          team={{ id: team.id, name: team.name }}
          teammates={teammates}
        />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </CatalogSyncBoundary>
  );
}
