import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

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
  capContentWidth,
}: {
  subSidebar?: React.ReactNode;
  children: React.ReactNode;
  /** Tailwind classes appended to the `<main>` element. Defaults to
   *  `overflow-y-auto`. Pass `min-w-0` for sections that own internal
   *  scroll (e.g. team chat). */
  mainClassName?: string;
  /** Opt-in for "centered content" sections (workflows, templates,
   *  broadcasts list, etc.) whose pages don't manage their own width.
   *  Wraps children in a centered `max-w-[1400px]` track so they don't
   *  stretch edge-to-edge on ultrawide monitors. Default `false` —
   *  full-bleed sections (inbox, team chat, contacts) keep today's
   *  behavior and must NOT set this. Sections that already cap their
   *  own children (settings wraps in `max-w-3xl`) don't need it either. */
  capContentWidth?: boolean;
}) {
  // Both are React.cached and almost always pre-warmed by the (app) parent
  // layout, so these are free cache hits — but parallelize anyway in case
  // SectionShell is ever rendered before the parent layout's awaits resolve
  // (e.g. nested suspense boundary).
  const [{ user, permissions }, team] = await Promise.all([
    getSession(),
    getCurrentTeam(),
  ]);

  return (
    <>
      <MobileShellChrome
        currentUser={user}
        team={{ id: team.id, name: team.name }}
        canManageAvailability={permissions["availability:manage"]}
        canManageWorkflows={canManageUsers(user.role)}
        subSidebar={subSidebar}
      />
      {subSidebar}
      {/* id + tabIndex={-1} is the skip-link target (see the "Skip to content"
          anchor in app/layout.tsx). focus:outline-none so programmatic focus
          from the skip link doesn't paint a ring around the whole pane. */}
      <main
        id="main-content"
        tabIndex={-1}
        className={`min-w-0 flex-1 focus:outline-none ${mainClassName ?? "overflow-y-auto"}`}
      >
        {capContentWidth ? (
          <div className="mx-auto w-full max-w-350">{children}</div>
        ) : (
          children
        )}
      </main>
    </>
  );
}
