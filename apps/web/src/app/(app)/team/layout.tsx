import { SectionShell } from "@/components/layouts/section-shell";
import { TeamChatLayoutDataProvider } from "@/features/team-chat/contexts/team-chat-data";
import { TeamChannelSidebar } from "@/features/team-chat/components/team-channel-sidebar";
import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries";
import { TeamTitleBadge } from "@/features/team-chat/components/team-title-badge";
import {
  listChannelsForUser,
  listDirectMessagesForUser,
  listTeamMembers,
} from "@/lib/api/queries";

/**
 * Team chat shell. The channel list + team roster are fetched HERE (layout
 * level) and seeded into a LIVE provider, so switching channels — which
 * re-runs /team/[channelId]/page.tsx — doesn't refetch them and the
 * channel-list socket subscription runs once for the whole section.
 *
 * The channel-list sidebar is rendered in the `SectionShell` sub-sidebar slot
 * (not inside the workspace), so it paints instantly on a rail click and stays
 * mounted across channel switches and the `/team` → default-channel redirect —
 * only the feed (the page) streams in behind `loading.tsx`.
 *
 * The provider wraps SectionShell (not just `{children}`) so BOTH the sidebar
 * slot and the workspace read the same live channel list.
 *
 * `min-w-0` on main lets the workspace own its own internal scroll.
 */
export default async function TeamLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [{ user }, team, channels, dms, teamMembers] = await Promise.all([
    getSession(),
    getCurrentTeam(),
    listChannelsForUser(),
    listDirectMessagesForUser(),
    listTeamMembers(),
  ]);

  return (
    <TeamChatLayoutDataProvider
      initialChannels={channels}
      initialDms={dms}
      teamMembers={teamMembers}
      currentUserId={user.id}
    >
      {/* Owns document.title for this route — see the component's docblock
          for why exactly one owner per route matters. */}
      <TeamTitleBadge teamName={team.name} />
      <SectionShell mainClassName="min-w-0" subSidebar={<TeamChannelSidebar currentUser={user} />}>
        {children}
      </SectionShell>
    </TeamChatLayoutDataProvider>
  );
}
