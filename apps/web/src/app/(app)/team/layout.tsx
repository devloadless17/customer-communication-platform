import { SectionShell } from "@/components/layouts/section-shell";
import { TeamChatLayoutDataProvider } from "@/features/team-chat/contexts/team-chat-data";
import { listChannelsForUser, listTeamMembers } from "@/lib/api/queries";

/**
 * Team chat shell. The channels list and team roster are fetched HERE
 * (layout level) so that switching between channels — which re-runs
 * /team/[channelId]/page.tsx — does NOT refetch them. Next.js caches
 * layouts across nested route changes; per-channel data stays in the
 * page, channel-agnostic data lives up here.
 *
 * Before this, the page fetched 5 things in parallel on every channel
 * switch (channel meta + messages + pins + channels list + members);
 * now it's 3, ~40% less network on each click.
 *
 * The channel list rendering still lives inside TeamChatWorkspace
 * (which carries live socket state for unread badges + presence) — only
 * the SSR seed moved up here. The workspace reads it via context.
 *
 * `min-w-0` on main lets the workspace own its own internal scroll.
 */
export default async function TeamLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [channels, teamMembers] = await Promise.all([
    listChannelsForUser(),
    listTeamMembers(),
  ]);

  return (
    <SectionShell mainClassName="min-w-0">
      <TeamChatLayoutDataProvider channels={channels} teamMembers={teamMembers}>
        {children}
      </TeamChatLayoutDataProvider>
    </SectionShell>
  );
}
