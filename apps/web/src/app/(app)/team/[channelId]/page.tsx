import { notFound } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import {
  getChannelById,
  listChannelMessages,
  listChannelPins,
} from "@/lib/api/queries";

import { TeamChatWorkspace } from "@/features/team-chat/components/team-chat-workspace";

/**
 * Channel view. Server-renders the initial slice of per-channel data:
 *   - active channel meta
 *   - the active channel's latest message page
 *   - pins
 *
 * Channel-AGNOSTIC data (channels list + team members for @ picker)
 * lives in /team/layout.tsx and reaches the workspace via context — so
 * switching channels only re-runs these three per-channel fetches,
 * not the full 5 it used to. See the layout's doc-comment for the
 * rationale.
 */
export default async function ChannelPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}) {
  const { user } = await getSession();
  const { channelId } = await params;

  const [channel, page, pins] = await Promise.all([
    getChannelById(channelId),
    listChannelMessages(channelId),
    listChannelPins(channelId),
  ]);

  if (!channel) {
    notFound();
  }

  return (
    <>
      {/* The chat feed's channel header is a `<span>`, not a heading, so the
          desktop view has no top-level landmark (the mobile chrome owns the h1
          below `md`). Expose one for SR heading nav; scoped to desktop to avoid
          a duplicate mobile h1. */}
      <h1 className="sr-only max-md:hidden">{channel.name}</h1>
      <TeamChatWorkspace
        currentUser={user}
        initialChannel={channel}
        initialMessages={page.items}
        initialNextCursor={page.nextCursor}
        initialPins={pins}
      />
    </>
  );
}
