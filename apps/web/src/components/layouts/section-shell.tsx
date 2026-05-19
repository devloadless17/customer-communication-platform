import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";

import { AppRail } from "@/components/layouts/app-rail";
import { MobileShellChrome } from "@/components/layouts/mobile-shell-chrome";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";

/**
 * Three-column section shell shared by every authenticated section
 * (broadcasts / contacts / settings / team / templates / workflows / admin).
 *
 *   Desktop: [AppRail] [optional sub-sidebar] [main content]
 *   Mobile:  [Mobile header] [main content] + Drawer(AppRail-mobile, sub-sidebar)
 *
 * The per-section data fetching (stages for contacts, role checks for admin,
 * etc.) stays in the calling layout — this only owns shell + chrome.
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
      <div className="flex min-h-svh flex-col bg-background text-foreground md:flex-row">
        <MobileShellChrome
          currentUser={user}
          team={{ id: team.id, name: team.name }}
          subSidebar={subSidebar}
        />
        <AppRail currentUser={user} team={{ id: team.id, name: team.name }} />
        {subSidebar}
        <main
          className={`min-w-0 flex-1 ${mainClassName ?? "overflow-y-auto"}`}
        >
          {children}
        </main>
      </div>
    </CatalogSyncBoundary>
  );
}
