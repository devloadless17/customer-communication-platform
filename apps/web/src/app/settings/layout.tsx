import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam, listTeamMembers } from "@/lib/api/queries";

import { AppSidebar } from "@/components/layouts/app-sidebar";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";

/**
 * Settings shell. Uses the same `AppSidebar` every other area uses — Account,
 * Team, WhatsApp, API keys, Snippets, and Stages now all live in labeled
 * groups in the main sidebar, so users don't lose the global nav the moment
 * they open settings.
 *
 * The old inline sub-sidebar (Chat / Workspace groups) is gone; navigation
 * happens from the same shell on every page, and a settings landing card
 * grid still exists at /settings for direct deep-links.
 */
export default async function SettingsLayout({
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
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-10">{children}</div>
        </main>
      </div>
    </CatalogSyncBoundary>
  );
}
