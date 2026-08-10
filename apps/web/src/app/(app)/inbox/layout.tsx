import { cookies } from "next/headers";

import { SectionShell } from "@/components/layouts/section-shell";
import { InboxSubSidebarLive } from "@/components/layouts/inbox-sub-sidebar-live";
import { InboxFilterProvider } from "@/features/inbox/contexts/inbox-filter-context";
// Pure SSR-safe primitives (no "use client") — imported directly from the
// non-client sibling so server components can call parseInboxFilter without
// crashing on "Attempted to call X() from the server but X is on the client."
import {
  INBOX_FILTER_COOKIE,
  parseInboxFilter,
} from "@/features/inbox/contexts/inbox-filter";
import type { Filter } from "@/features/inbox/components/inbox-controls";
import { getSession } from "@/lib/auth/current-user";
import {
  listContactFieldDefinitions,
  listContactStages,
  listConversations,
  listInboxViews,
  listTags,
  listTeamMembers,
} from "@/lib/api/queries";
import { InboxViewsProvider } from "@/features/inbox/contexts/inbox-views-context";

/**
 * Inbox shell. The sub-sidebar (presets / stages / teammates) is rendered HERE
 * at the layout level — via SectionShell — so it paints immediately on a rail
 * click and stays mounted while the page (`InboxShell`: conversation list +
 * thread) streams in behind `loading.tsx`. Before this, the entire inbox lived
 * in the page island, so the whole right-of-rail region flashed a skeleton on
 * every entry. Now only the conversation list + thread skeleton, exactly like
 * Contacts / Broadcasts / Settings.
 *
 * `InboxFilterProvider` wraps both the sub-sidebar slot and `{children}`, so
 * the active filter is one source of truth shared across the layout/page
 * boundary (see the provider's doc-comment for why this isn't a URL param).
 *
 * Data fetched here (stages, teammates, conversations) is also fetched by the
 * page; both `listContactStages` / `listTeamMembers` / `listConversations` are
 * `React.cache`d, so the page's calls are free per-render cache hits — no
 * double DB round-trip.
 */
export default async function InboxLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [
    { user, permissions },
    stages,
    teamMembers,
    conversationsPage,
    savedViews,
    tags,
    fieldDefinitions,
    cookieStore,
  ] = await Promise.all([
    getSession(),
    listContactStages(),
    listTeamMembers(),
    listConversations(),
    listInboxViews(),
    listTags(),
    // Select-field catalog for the view builder's field criteria + the view
    // summaries. `React.cache`d like its siblings.
    listContactFieldDefinitions(),
    // NOTE: the channel-account directory is seeded by the APP layout, above
    // this one — the call layer sits above the inbox and needs it too. It is
    // `cache()`d, so nothing here pays for that move.
    cookies(),
  ]);

  // Active members only for the sidebar roster — deactivated users still ride
  // along in `teamMembers` for historical message attribution in the thread,
  // but shouldn't show as teammates here.
  const teammates = teamMembers.filter((u) => u.isActive);

  // Restore the agent's last-used filter (preset OR stage) so a hard refresh
  // doesn't snap them back to "All open". Persisted as a cookie by the
  // provider's setFilter — the SSR-seeded value drives the very first paint
  // so the sub-sidebar + conversation list render the correct view from
  // frame zero (no flash from "All open" → restored filter).
  //
  // Defensive validation: drop a stage id that no longer maps to a live
  // stage (stage deleted on another tab / device). Falls back to default.
  const persistedFilter = parseInboxFilter(cookieStore.get(INBOX_FILTER_COOKIE)?.value);
  let initialFilter: Filter | undefined;
  if (persistedFilter) {
    if (persistedFilter.kind === "stage") {
      const stageExists = stages.some((s) => s.id === persistedFilter.stageId);
      if (stageExists) initialFilter = persistedFilter;
    } else if (persistedFilter.kind === "view") {
      // Same defensive check as a stage id, and it matters MORE here: a shared
      // view can be deleted, or un-shared, by someone else. A stale id would
      // make every conversation-list request 404 with no way for the agent to
      // recover except clearing cookies.
      const viewExists = savedViews.some((v) => v.id === persistedFilter.viewId);
      if (viewExists) initialFilter = persistedFilter;
    } else {
      initialFilter = persistedFilter;
    }
  }

  return (
    <InboxFilterProvider initialFilter={initialFilter}>
      <InboxViewsProvider initialViews={savedViews}>
        <SectionShell
          mainClassName="min-w-0 overflow-hidden"
          subSidebar={
            <InboxSubSidebarLive
              currentUser={user}
              stages={stages}
              tags={tags}
              fieldDefinitions={fieldDefinitions}
              teammates={teammates}
              initialConversations={conversationsPage.items}
              canManageSharedViews={permissions["inboxViews:manageShared"]}
            />
          }
        >
          {children}
        </SectionShell>
      </InboxViewsProvider>
    </InboxFilterProvider>
  );
}
