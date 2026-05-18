import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";

import { AppRail } from "@/components/layouts/app-rail";
import { WorkflowsSubSidebar } from "@/components/layouts/section-sub-sidebars";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";

/**
 * Workflows shell — AppRail + a minimal sub-sidebar (just the section
 * header today). The workflows list lives in /workflows itself.
 */
export default async function WorkflowsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await getSession();
  const team = await getCurrentTeam();

  return (
    <CatalogSyncBoundary>
      <div className="flex min-h-svh bg-background text-foreground">
        <AppRail currentUser={user} team={{ id: team.id, name: team.name }} />
        <WorkflowsSubSidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </CatalogSyncBoundary>
  );
}
