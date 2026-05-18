import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";

import { AppRail } from "@/components/layouts/app-rail";
import { BroadcastsSubSidebar } from "@/components/layouts/section-sub-sidebars";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";

/**
 * Templates lives under the "Outreach" surface — same AppRail + sub-sidebar
 * shape as /broadcasts so navigating between Broadcasts, Audience groups,
 * and Templates doesn't shift the chrome.
 */
export default async function TemplatesLayout({
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
        <BroadcastsSubSidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </CatalogSyncBoundary>
  );
}
