import { getSession } from "@/lib/auth/current-user";
import {
  getCurrentTeam,
  listAudienceGroups,
  listContactStages,
} from "@/lib/api/queries";

import { AppRail } from "@/components/layouts/app-rail";
import { ContactsSubSidebar } from "@/components/layouts/contacts-sub-sidebar";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";

/**
 * Contacts shell — AppRail + ContactsSubSidebar (lifecycle stages + audience
 * groups) + the contacts table. Stages and audience groups are SSR-seeded
 * so the sub-sidebar paints with real data on first load.
 */
export default async function ContactsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await getSession();
  const [team, stages, audienceGroups] = await Promise.all([
    getCurrentTeam(),
    listContactStages(),
    listAudienceGroups(),
  ]);

  return (
    <CatalogSyncBoundary>
      <div className="flex min-h-svh bg-background text-foreground">
        <AppRail currentUser={user} team={{ id: team.id, name: team.name }} />
        <ContactsSubSidebar stages={stages} audienceGroups={audienceGroups} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </CatalogSyncBoundary>
  );
}
