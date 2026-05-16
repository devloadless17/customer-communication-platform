"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { usePresence } from "@/hooks/use-presence";
import { useTeamChannelEvents } from "@/hooks/use-team-channel-events";
import { useTeamChannelsList } from "@/hooks/use-team-channels-events";
import { canPinMessage } from "@/lib/team-chat/permissions";
import type {
  ChannelPinDto,
  TeamChannelDto,
  TeamChannelListItemDto,
  TeamChannelMessageDto,
} from "@/lib/team-chat/types";
import type { User } from "@/lib/types";

import { ChannelComposer } from "./channel-composer";
import { ChannelHeader } from "./channel-header";
import { ChannelList } from "./channel-list";
import { ChannelThread } from "./channel-thread";
import {
  EditChannelDialog,
  NewChannelDialog,
  useDeleteChannel,
} from "./channel-dialogs";
import { PinnedBar } from "./pinned-bar";
import { ThreadPanel } from "./thread-panel";
import { TypingIndicator } from "./typing-indicator";

/**
 * Top-level client component for /team/[channelId]. Orchestrates:
 *   - the channel list sidebar (with live unread badges)
 *   - the active channel feed + composer
 *   - the optional thread side panel
 *   - presence (online dots in the sidebar header)
 *   - new / edit / delete dialogs
 *
 * Server props are the SSR seed; everything else is live socket state.
 */
export function TeamChatWorkspace({
  currentUser,
  teamMembers,
  initialChannel,
  initialChannels,
  initialMessages,
  initialNextCursor,
  initialPins,
}: {
  currentUser: User;
  teamMembers: User[];
  initialChannel: TeamChannelDto;
  initialChannels: TeamChannelListItemDto[];
  initialMessages: TeamChannelMessageDto[];
  initialNextCursor: string | null;
  initialPins: ChannelPinDto[];
}) {
  const router = useRouter();
  const { onlineUserIds } = usePresence(currentUser.teamId, currentUser.id);
  const channels = useTeamChannelsList(initialChannels, currentUser.id);
  const channelState = useTeamChannelEvents(
    initialChannel.id,
    initialMessages,
    initialNextCursor,
  );

  // Pins: hydrate from SSR; we don't yet listen to a pin-changed event for
  // the bar (only for the bubble's chip). Refresh on pin/unpin via a small
  // re-fetch when the socket fires. Keeps the bar correct without a full
  // PinnedItem socket payload.
  const [pins, setPins] = useState(initialPins);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useMemo(() => setPins(initialPins), [initialPins, initialChannel.id]);

  const [thread, setThread] = useState<TeamChannelMessageDto | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const deleteChannel = useDeleteChannel();

  const namesById = useMemo(
    () => new Map(teamMembers.map((u) => [u.id, u.name])),
    [teamMembers],
  );

  // Keep the thread panel in sync with the live message — when the root
  // gets edited / reacted-to / its reply count bumps, we want the panel's
  // header to reflect that without forcing the user to reopen it.
  const liveThreadRoot = useMemo(() => {
    if (!thread) return null;
    return channelState.messages.find((m) => m.id === thread.id) ?? thread;
  }, [thread, channelState.messages]);

  // If the active channel got deleted out from under us (another admin),
  // bounce to /team — which redirects to the default channel.
  if (!channels.some((c) => c.id === initialChannel.id)) {
    router.replace("/team");
  }

  return (
    <div className="flex h-svh">
      <ChannelList
        channels={channels}
        activeChannelId={initialChannel.id}
        currentRole={currentUser.role}
        onlinePresenceCount={onlineUserIds.size}
        onCreate={() => setShowNew(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelHeader
          channel={initialChannel}
          currentRole={currentUser.role}
          memberCount={teamMembers.filter((u) => u.isActive).length}
          typingUserIds={channelState.typingUserIds}
          teamMemberNameById={namesById}
          onEdit={() => setShowEdit(true)}
          onDelete={() => {
            void deleteChannel(initialChannel.id, "/team");
          }}
        />
        <PinnedBar pins={pins} />
        <ChannelThread
          messages={channelState.messages}
          channelId={initialChannel.id}
          currentUser={currentUser}
          canPin={canPinMessage(currentUser.role)}
          hasMoreOlder={channelState.hasMoreOlder}
          onLoadOlder={channelState.loadOlder}
          onOpenThread={(rootId) => {
            const root = channelState.messages.find((m) => m.id === rootId);
            if (root) setThread(root);
          }}
        />
        <div className="border-t border-border">
          <TypingIndicator
            userIds={channelState.typingUserIds}
            namesById={namesById}
            viewerUserId={currentUser.id}
          />
        </div>
        <ChannelComposer
          channelId={initialChannel.id}
          channelName={initialChannel.name}
          currentUser={currentUser}
          teamMembers={teamMembers}
          onOptimisticAdd={channelState.addOptimistic}
          onOptimisticFail={channelState.markOptimisticFailed}
          onOptimisticRemove={channelState.removeOptimistic}
        />
      </div>

      {liveThreadRoot && (
        <ThreadPanel
          channelId={initialChannel.id}
          channelName={initialChannel.name}
          rootMessage={liveThreadRoot}
          currentUser={currentUser}
          teamMembers={teamMembers}
          canPin={canPinMessage(currentUser.role)}
          onClose={() => setThread(null)}
        />
      )}

      {showNew && (
        <NewChannelDialog
          onClose={() => setShowNew(false)}
          onCreated={(ch) => {
            setShowNew(false);
            router.push(`/team/${ch.id}`);
          }}
        />
      )}
      {showEdit && (
        <EditChannelDialog
          channel={initialChannel}
          onClose={() => setShowEdit(false)}
          onUpdated={() => {
            setShowEdit(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
