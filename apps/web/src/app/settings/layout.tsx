import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";

import { AppRail } from "@/components/layouts/app-rail";
import { SettingsSubSidebar } from "@/components/layouts/settings-sub-sidebar";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";

/**
 * Settings shell — AppRail (icon nav) + SettingsSubSidebar (grouped nav) +
 * page content. Every authenticated section follows the same three-column
 * pattern; the sub-sidebar's contents are what change per section.
 */
export default async function SettingsLayout({
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
        <SettingsSubSidebar role={user.role} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-10">{children}</div>
        </main>
      </div>
    </CatalogSyncBoundary>
  );
}
