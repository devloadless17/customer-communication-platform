import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";

import { AppRail } from "@/components/layouts/app-rail";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";

/**
 * Team chat shell — just the AppRail. The channel list (the contextual
 * sub-sidebar for this section) is owned by `TeamChatWorkspace` because it
 * carries live socket state (unread badges, member presence). Putting a
 * second channel list in the layout would either duplicate the data or
 * force the workspace to refetch on every channel switch.
 */
export default async function TeamLayout({
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
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </CatalogSyncBoundary>
  );
}
