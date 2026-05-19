import { AppRail } from "@/components/layouts/app-rail";
import { ChunkErrorReload } from "@/components/chunk-error-reload";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";
import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";

/**
 * Shared authenticated shell. Wraps every section (inbox, team, contacts,
 * broadcasts, workflows, settings, admin, templates) so the AppRail mounts
 * ONCE on first auth load and stays mounted across every section nav.
 *
 * Why this exists — without it, each section had its own layout that
 * rendered its own AppRail (via SectionShell or directly). Clicking a rail
 * icon to switch sections unmounted the old layout's AppRail, suspended on
 * the new layout's `await getSession() + getCurrentTeam() + section-data`,
 * fell back to loading.tsx (which lacked the rail), then mounted a fresh
 * AppRail. The user perceived a chrome flash → skeleton → final content
 * sequence on every section click. With AppRail hoisted here, the rail is
 * stable and only the inner pane swaps.
 *
 * `CatalogSyncBoundary` mounts here too so a single `team:catalog:changed`
 * listener covers the whole authenticated tree (instead of one per section,
 * which fired duplicate refreshes when sections nested).
 *
 * Mobile chrome (MobileShellChrome) deliberately stays in each section's
 * layout via SectionShell — it needs the per-section subSidebar slot
 * (filters / channel list / settings tree). The remount on section change
 * is invisible on mobile because the hamburger header is tiny and the
 * AppRail isn't visible there anyway.
 */
export default async function AppShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Parallel — both are independent HTTP/DB reads. Sequential awaits here
  // serialized two RTTs on the gating layout for every authenticated page
  // render. Both are React.cached so child layouts re-calling them are
  // free cache hits.
  const [{ user }, team] = await Promise.all([getSession(), getCurrentTeam()]);

  return (
    <CatalogSyncBoundary>
      {/* Detects ChunkLoadError from stale bundle references after a deploy
          and hard-reloads once to pull fresh chunk hashes. Without this, a
          deploy → soft nav → silent route failure leaves the agent stuck. */}
      <ChunkErrorReload />
      <div className="relative flex min-h-svh w-full flex-col bg-background text-foreground md:flex-row">
        <AppRail currentUser={user} team={{ id: team.id, name: team.name }} />
        <div className="flex min-w-0 flex-1 flex-col md:flex-row">{children}</div>
      </div>
    </CatalogSyncBoundary>
  );
}
