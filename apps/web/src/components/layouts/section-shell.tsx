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
  title,
}: {
  subSidebar?: React.ReactNode;
  children: React.ReactNode;
  /** Section-level accessible page title. Rendered as a visually-hidden
   *  desktop `<h1>` (`sr-only`) so sections whose desktop content starts at
   *  `<h2>` — or has no heading at all (workflow canvas, team-chat feed) —
   *  still expose a top-level landmark for screen-reader heading nav. Scoped
   *  to desktop via `max-md:hidden` because the mobile chrome
   *  (`MobileShellChrome`) already renders a visible `<h1>` below `md`; this
   *  avoids a duplicate h1 on small screens. Omit for sections whose page
   *  content already renders its own visible `<h1>`. */
  title?: string;
  /** Tailwind classes appended to the `<main>` element. Defaults to
   *  `overflow-y-auto`. Pass `min-w-0` for sections that own internal
   *  scroll (e.g. team chat). */
  mainClassName?: string;
  /** Opt-in for "centered content" sections (workflows, templates,
   *  broadcasts list, etc.) whose pages don't manage their own width.
   *  Wraps children in a centered `max-w-350` track so they don't
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
        canViewReports={permissions["teamActivity:view"]}
        restrictedViewer={
          user.role === "agent" && team.agentConversationVisibility === "assigned"
        }
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
        {/* Desktop-only sr-only h1: the mobile chrome already owns the visible
            h1 below `md`, so scope this to `md+` to avoid a duplicate. */}
        {title ? <h1 className="sr-only max-md:hidden">{title}</h1> : null}
        {capContentWidth ? (
          <div className="mx-auto w-full max-w-350">{children}</div>
        ) : (
          children
        )}
      </main>
    </>
  );
}
