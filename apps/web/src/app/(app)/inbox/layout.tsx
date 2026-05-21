import { SectionShell } from "@/components/layouts/section-shell";
import { InboxSubSidebarLive } from "@/components/layouts/inbox-sub-sidebar-live";
import { InboxFilterProvider } from "@/features/inbox/contexts/inbox-filter-context";
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
  const [{ user }, stages, teamMembers, conversationsPage] = await Promise.all([
    getSession(),
    listContactStages(),
    listTeamMembers(),
    listConversations(),
  ]);

  // Active members only for the sidebar roster — deactivated users still ride
  // along in `teamMembers` for historical message attribution in the thread,
  // but shouldn't show as teammates here.
  const teammates = teamMembers.filter((u) => u.isActive);

  return (
    <InboxFilterProvider>
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
