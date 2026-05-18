import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";

import { AppRail } from "@/components/layouts/app-rail";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";

/**
 * Three-column section shell shared by every authenticated section
 * (broadcasts / contacts / settings / team / templates / workflows / admin).
 *
 *   [AppRail] [optional sub-sidebar] [main content]
 *
 * The previous per-section layouts each re-implemented the same 6-line
 * shell with their own session + team fetch — this collapses all of that
 * into one component. Per-section data fetching (stages for contacts,
 * role checks for admin, etc.) stays in the calling layout.
 */
export async function SectionShell({
  subSidebar,
  children,
  mainClassName,
}: {
  subSidebar?: React.ReactNode;
  children: React.ReactNode;
  /** Tailwind classes appended to the `<main>` element. Defaults to
   *  `overflow-y-auto`. Pass `min-w-0` for sections that own internal
   *  scroll (e.g. team chat). */
  mainClassName?: string;
}) {
  const { user } = await getSession();
  const team = await getCurrentTeam();

  return (
    <CatalogSyncBoundary>
      <div className="flex min-h-svh bg-background text-foreground">
        <AppRail currentUser={user} team={{ id: team.id, name: team.name }} />
        {subSidebar}
        <main className={`flex-1 ${mainClassName ?? "overflow-y-auto"}`}>
          {children}
        </main>
      </div>
    </CatalogSyncBoundary>
  );
}
