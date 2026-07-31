import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppRail } from "@/components/layouts/app-rail";
import { ChunkErrorReload } from "@/components/chunk-error-reload";
import { CatalogSyncBoundary } from "@/providers/catalog-sync-boundary";
import { NotificationSoundProvider } from "@/providers/notification-sound-provider";
import { TeamChatNotificationsProvider } from "@/providers/team-chat-notifications";
import {
  listChannelAccountDirectory,
  listDirectMessagesForUser,
  type ChannelAccountDirectoryEntry,
} from "@/lib/api/queries";
import { soft } from "@/lib/api/soft";
import { ChannelAccountsProvider } from "@/features/channels/contexts/channel-accounts-context";
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
  // getSession() first (React.cached → child layouts reuse it for free) so we
  // can apply the two access gates BEFORE fetching any team-scoped data.
  const { user, permissions, orgStatus, workspaces, organizationName } = await getSession();

  // Super-admins live in the (platform) shell — a separate, management-only
  // surface with no inbox / contacts / workflows. Bounce them out of the
  // customer app entirely.
  if (user.isSuperAdmin) redirect("/platform");

  // Org-approval gate. A `pending` org (awaiting super-admin review) or a
  // `suspended` org (access revoked) can't use the app — route to the status
  // screen, which lives OUTSIDE this (app) group so there's no redirect loop.
  // Reading status off the session (not /api/workspace, which is now org-gated)
  // is what keeps this redirect working for a locked-out org.
  if (orgStatus !== "active") redirect("/pending");

  // Now safe to fetch team-scoped chrome. Parallel — independent reads, both
  // React.cached so child layouts re-calling them are free cache hits.
  const [team, cookieStore, dms, channelAccountsOrNull] = await Promise.all([
    getCurrentTeam(),
    cookies(),
    // Seeds the DM-alert set. A DM is inherently addressed to you, so ANY
    // message in one should alert — but `team:channel:activity` can't tell a
    // DM from a channel, so the client needs the id set to branch on.
    // Best-effort: a failure just means DM dings wait until /team is visited.
    soft("dm-alert seed", [], () => listDirectMessagesForUser()),
    // Which accounts this workspace has on each channel. Seeded HERE rather
    // than in the inbox layout because the call layer below sits above the
    // inbox — an inbox-scoped provider is invisible to the incoming-call toast,
    // which is exactly where an agent needs to know which business identity is
    // being called. `cache()`d, so the inbox re-reading it is free.
    //
    // `null` is the FAILURE sentinel: soft() returns the fallback on error, and
    // a surface that lets an operator pick a sending account must not present
    // "we couldn't load your numbers" as "you have one number".
    soft<ChannelAccountDirectoryEntry[] | null>("channel-account directory", null, () =>
      listChannelAccountDirectory(),
    ),
  ]);
  const dmChannelIds = new Set(dms.map((d) => d.id));
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
        {/* Team-chat @-mention / DM alerts. Null-rendering; lives here (not in
            /team/layout) so a mention reaches you on any page. */}
        <TeamChatNotificationsProvider
          currentUserId={user.id}
          dmChannelIds={dmChannelIds}
        />
        {/* App-wide voice-call layer: the single useCall instance + the
            incoming-call toast / active-call panel, so a call ringing in is
            visible on every page (not just the inbox). */}
        {/* OUTSIDE CallProvider on purpose: the incoming-call toast and the
            live-call panel both need to name the account being called, and a
            provider mounted below them cannot be read from inside. */}
        <ChannelAccountsProvider
          accounts={channelAccountsOrNull ?? []}
          failed={channelAccountsOrNull === null}
        >
        <CallProvider canReceiveCalls={permissions["calls:receive"]}>
          <div className="relative flex h-svh w-full flex-col overflow-hidden bg-background text-foreground md:flex-row">
            <AppRail
              currentUser={user}
              team={{ id: team.id, name: team.name }}
              workspaces={workspaces}
              organizationName={organizationName}
              canManageAvailability={permissions["availability:manage"]}
              canViewReports={permissions["teamActivity:view"]}
              initialCollapsed={railCollapsed}
            />
            <div className="flex min-w-0 flex-1 flex-col md:flex-row">{children}</div>
          </div>
        </CallProvider>
        </ChannelAccountsProvider>
      </NotificationSoundProvider>
    </CatalogSyncBoundary>
  );
}
