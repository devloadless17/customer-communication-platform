import { notFound } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import {
  getChannelById,
  getPublicChannelPreview,
  listChannelMessages,
  listChannelPins,
} from "@/lib/api/queries";

import { JoinChannelCard } from "@/features/team-chat/components/join-channel-card";
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

  // Channel FIRST, alone: a non-member 404s here, and the message/pin fetches
  // would 404 too — so they can't be part of the same Promise.all or a
  // legitimate "public channel I haven't joined" would throw before we get a
  // chance to offer the join card.
  const channel = await getChannelById(channelId).catch(() => null);

  if (!channel) {
    // Not a member. If it's a PUBLIC channel, offer to join instead of dead-
    // ending — otherwise (private, DM, or genuinely missing) 404 exactly as
    // before, which is what keeps a private channel's existence undisclosed.
    const preview = await getPublicChannelPreview(channelId).catch(() => null);
    if (preview) return <JoinChannelCard channel={preview} />;
    notFound();
  }

  const [page, pins] = await Promise.all([
    listChannelMessages(channelId),
    listChannelPins(channelId),
  ]);

  return (
    <>
      {/* The chat feed's channel header is a `<span>`, not a heading, so the
          desktop view has no top-level landmark (the mobile chrome owns the h1
          below `md`). Expose one for SR heading nav; scoped to desktop to avoid
          a duplicate mobile h1.
          DMs are handled by the workspace instead — a DM has no `name`, and
          every one of them rendering the literal heading "Direct message" made
          heading navigation useless the moment you had more than one open. The
          workspace knows the peer; this server component does not. */}
      {channel.name ? (
        <h1 className="sr-only max-md:hidden">{channel.name}</h1>
      ) : null}
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
