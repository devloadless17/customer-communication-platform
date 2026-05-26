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
  listContactStages,
  listConversations,
  listTeamMembers,
} from "@/lib/api/queries";

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
  const [{ user }, stages, teamMembers, conversationsPage, cookieStore] =
    await Promise.all([
      getSession(),
      listContactStages(),
      listTeamMembers(),
      listConversations(),
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
    } else {
      initialFilter = persistedFilter;
    }
  }

  return (
    <InboxFilterProvider initialFilter={initialFilter}>
      <SectionShell
        mainClassName="min-w-0 overflow-hidden"
        subSidebar={
          <InboxSubSidebarLive
            currentUser={user}
            stages={stages}
            teammates={teammates}
            initialConversations={conversationsPage.items}
          />
        }
      >
        {children}
      </SectionShell>
    </InboxFilterProvider>
  );
}
