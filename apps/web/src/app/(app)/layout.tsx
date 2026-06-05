import { cookies } from "next/headers";

import { AppRail } from "@/components/layouts/app-rail";
import { ChunkErrorReload } from "@/components/chunk-error-reload";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";
import { NotificationSoundProvider } from "@/providers/notification-sound-provider";
import { CallProvider } from "@/features/calls/call-provider";
import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";

/** Rail collapse cookie — read server-side so SSR renders the persisted state
 *  (no expand→collapse flash). Default COLLAPSED: only an explicit "false"
 *  (the user expanded it) keeps it open. Written client-side in app-rail.tsx. */
const RAIL_COLLAPSED_COOKIE = "app-rail-collapsed";

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
  const [{ user, permissions }, team, cookieStore] = await Promise.all([
    getSession(),
    getCurrentTeam(),
    cookies(),
  ]);
  const railCollapsed = cookieStore.get(RAIL_COLLAPSED_COOKIE)?.value !== "false";

  return (
    <CatalogSyncBoundary>
      {/* Detects ChunkLoadError from stale bundle references after a deploy
          and hard-reloads once to pull fresh chunk hashes. Without this, a
          deploy → soft nav → silent route failure leaves the agent stuck. */}
      <ChunkErrorReload />
      {/* h-svh + overflow-hidden locks the shell to exactly one viewport so
          the scrollbar lives on `main` (SectionShell's overflow-y-auto), NOT
          the document. With the old min-h-svh, tall pages grew the document
          and the h-svh AppRail/SubSidebar scrolled away, leaving a blank gap
          below them. Inbox/team-chat already self-bound with their own h-svh
          islands, so they're unaffected. Popovers/toasts portal to body, so
          overflow-hidden here doesn't clip overlays. */}
      {/* App-wide notification sounds (new-message ding + the engine that the
          inbox call toast rings through). Wraps AppRail so the user-menu sound
          toggles can read its context. */}
      <NotificationSoundProvider>
        {/* App-wide voice-call layer: the single useCall instance + the
            incoming-call toast / active-call panel, so a call ringing in is
            visible on every page (not just the inbox). */}
        <CallProvider>
          <div className="relative flex h-svh w-full flex-col overflow-hidden bg-background text-foreground md:flex-row">
            <AppRail
              currentUser={user}
              team={{ id: team.id, name: team.name }}
              canManageAvailability={permissions["availability:manage"]}
              initialCollapsed={railCollapsed}
            />
            <div className="flex min-w-0 flex-1 flex-col md:flex-row">{children}</div>
          </div>
        </CallProvider>
      </NotificationSoundProvider>
    </CatalogSyncBoundary>
  );
}
