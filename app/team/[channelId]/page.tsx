import { notFound } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { listTeamMembers } from "@/lib/queries";
import {
  getChannelById,
  listChannelMessages,
  listChannelPins,
  listChannelsForUser,
} from "@/lib/team-chat/queries";

import { TeamChatWorkspace } from "@/components/team-chat/team-chat-workspace";

/**
 * Channel view. Server-renders the initial slice of:
 *   - sidebar channel list (so it paints with badges on first frame)
 *   - the active channel's latest message page
 *   - pins
 *   - team roster (for the @ picker)
 *
 * Switching channels uses a soft client nav inside the workspace — no
 * server round-trip per click; the URL still moves so refresh / share /
 * back work naturally.
 */
export default async function ChannelPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}) {
  const { user, teamId } = await getSession();
  const { channelId } = await params;

  const [channel, channels, page, pins, teamMembers] = await Promise.all([
    getChannelById(channelId, teamId),
    listChannelsForUser(teamId, user.id),
    listChannelMessages(channelId, teamId),
    listChannelPins(channelId, teamId),
    listTeamMembers(teamId),
  ]);

  if (!channel) {
    notFound();
  }

  return (
    <TeamChatWorkspace
      currentUser={user}
      teamMembers={teamMembers}
      initialChannel={channel}
      initialChannels={channels}
      initialMessages={page.items}
      initialNextCursor={page.nextCursor}
      initialPins={pins}
    />
  );
}
