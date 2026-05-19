import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";

import { MobileShellChrome } from "@/components/layouts/mobile-shell-chrome";

/**
 * Per-section shell — renders the contextual sub-sidebar + main content.
 * The far-left AppRail and CatalogSyncBoundary live one level up in
 * `app/(app)/layout.tsx`, so they stay mounted across section nav.
 *
 * `getSession()` / `getCurrentTeam()` here are React.cached, so re-calling
 * them in the same render tree as the parent layout is a no-op DB hit.
 * They're needed for the mobile chrome's user + team display.
 *
 *   Desktop: [(app rail from parent layout)] [optional sub-sidebar] [main]
 *   Mobile:  [Mobile header (this file)] [main] + Drawer(primary nav, sub-sidebar)
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
  // Both are React.cached and almost always pre-warmed by the (app) parent
  // layout, so these are free cache hits — but parallelize anyway in case
  // SectionShell is ever rendered before the parent layout's awaits resolve
  // (e.g. nested suspense boundary).
  const [{ user }, team] = await Promise.all([getSession(), getCurrentTeam()]);

  return (
    <>
      <MobileShellChrome
        currentUser={user}
        team={{ id: team.id, name: team.name }}
        subSidebar={subSidebar}
      />
      {subSidebar}
      <main className={`min-w-0 flex-1 ${mainClassName ?? "overflow-y-auto"}`}>
        {children}
      </main>
    </>
  );
}
