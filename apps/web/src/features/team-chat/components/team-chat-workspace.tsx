"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { usePresence } from "@/hooks/use-presence";
import { useTeamChannelEvents } from "@/features/team-chat/hooks/use-team-channel-events";
import { useTeamChannelsList } from "@/features/team-chat/hooks/use-team-channels-events";
import { toast } from "@/lib/toast";
import { canPinMessage } from "@ccp/shared/team-chat/permissions";
import type {
  ChannelPinDto,
  TeamChannelDto,
  TeamChannelListItemDto,
  TeamChannelMessageDto,
} from "@ccp/shared/team-chat/types";
import type { User } from "@ccp/shared/types";

import { ChannelComposer } from "./channel-composer";
import { ChannelHeader } from "./channel-header";
import { ChannelList } from "./channel-list";
import { ChannelSearch } from "./channel-search";
import { ChannelThread } from "./channel-thread";
import {
  EditChannelDialog,
  NewChannelDialog,
  useDeleteChannel,
} from "./channel-dialogs";
import dynamic from "next/dynamic";

import { PinnedBar } from "./pinned-bar";
import { ThreadPanel } from "./thread-panel";
import { TypingIndicator } from "./typing-indicator";
// Workspace search ships its own debounced fetcher + result-card chrome;
// only renders when the user opens it from the cmd-k shortcut. SSR-off.
const WorkspaceSearchDialog = dynamic(
  () => import("./workspace-search-dialog").then((m) => m.WorkspaceSearchDialog),
  { ssr: false },
);

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
    currentUser.id,
  );

  // Pins: hydrate from SSR; we don't yet listen to a pin-changed event for
  // the bar (only for the bubble's chip). Refresh on pin/unpin via a small
  // re-fetch when the socket fires. Keeps the bar correct without a full
  // PinnedItem socket payload.
  //
  // Reset on channel switch: useEffect (NOT useMemo). useMemo running a
  // setState is a side effect — Strict Mode double-invokes it and the
  // eslint disable was hiding the bug. The effect runs once per channel
  // change; the dep on initialPins reseeds when the SSR payload bumps.
  const [pins, setPins] = useState(initialPins);
  useEffect(() => {
    setPins(initialPins);
  }, [initialPins, initialChannel.id]);

  const [thread, setThread] = useState<TeamChannelMessageDto | null>(null);
  // Close the thread panel on channel switch. Without this, navigating
  // from channel A (with a thread open) to channel B leaves `thread`
  // pointing at A's root message — `ThreadPanel` then renders with
  // `(channelId=B, rootMessage=fromA)` and `useThreadEvents` fetches
  // a thread that doesn't belong to this channel.
  useEffect(() => {
    setThread(null);
  }, [initialChannel.id]);
  const [showNew, setShowNew] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [channelSearchOpen, setChannelSearchOpen] = useState(false);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [channelSearchQuery, setChannelSearchQuery] = useState("");

  // `?q=` on the URL keeps inline highlight active when the user lands here
  // from a workspace-search result. Mirrors what `channel-search.tsx` would
  // set if the user opened in-channel search inside this channel.
  const searchParams = useSearchParams();
  const urlSearchQuery = searchParams?.get("q") ?? "";

  // The query that drives bubble-level `<mark>` highlights. URL-supplied
  // `?q=` wins when present; otherwise the in-channel search panel's live
  // input drives it (only when the panel is open). Both routes land on the
  // same prop so ChannelMessage's memo only sees one identity change.
  const activeSearchQuery =
    urlSearchQuery || (channelSearchOpen ? channelSearchQuery : "") || null;

  /**
   * Scroll the feed to a message and flash a highlight. Cheap path: the
   * message is already in the loaded slice, find it by `data-message-id` and
   * `scrollIntoView`. Slow path: fetch a context window via `loadAround`,
   * which replaces the loaded slice and enters anchored mode; the receiving
   * `messages` state change triggers a re-render and a second rAF locates
   * the now-mounted row.
   */
  // Ref-tracked so a rapid jump-to-message sequence can cancel the prior
  // flash timer instead of stomping classNames mid-fade.
  const flashTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, []);
  const flashHighlight = useCallback((el: HTMLElement) => {
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
    el.classList.add("ring-2", "ring-primary", "ring-offset-2", "transition-shadow");
    flashTimerRef.current = window.setTimeout(() => {
      el.classList.remove("ring-2", "ring-primary", "ring-offset-2", "transition-shadow");
      flashTimerRef.current = null;
    }, 1500);
  }, []);

  const jumpToMessage = useCallback(
    async (id: string) => {
      // Fast path — already mounted somewhere in the virtualized window.
      const findAndScroll = () =>
        document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
      const direct = findAndScroll();
      if (direct) {
        direct.scrollIntoView({ behavior: "smooth", block: "center" });
        flashHighlight(direct);
        return;
      }
      // Slow path — off-slice. Pull a context window then wait for the row
      // to render. The virtualizer renders in two frames typically; we poll
      // a few rAFs to give it room before giving up.
      const ok = await channelState.loadAround(id);
      if (!ok) return;
      const tryScroll = (attempts: number) => {
        const el = findAndScroll();
        if (el) {
          el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
          flashHighlight(el);
          return;
        }
        if (attempts <= 0) return;
        requestAnimationFrame(() => tryScroll(attempts - 1));
      };
      requestAnimationFrame(() => tryScroll(5));
    },
    [channelState, flashHighlight],
  );

  // Handle `?jumpTo=<id>` from a workspace-search result. Runs once per
  // distinct id so a re-render with the same query param doesn't re-jump.
  const lastJumpedRef = useRef<string | null>(null);
  useEffect(() => {
    const jumpId = searchParams?.get("jumpTo");
    if (!jumpId || lastJumpedRef.current === jumpId) return;
    lastJumpedRef.current = jumpId;
    void jumpToMessage(jumpId);
    // Clean the URL so a refresh doesn't re-trigger and a back-button visit
    // doesn't replay the jump. `router.replace` without the params resets
    // history without a navigation.
    const next = new URL(window.location.href);
    next.searchParams.delete("jumpTo");
    // Keep `?q=` so the inline highlight stays active until the user clears.
    window.history.replaceState(null, "", next.toString());
  }, [searchParams, jumpToMessage]);
  const { deleteChannel, confirmDialog: deleteChannelDialog } = useDeleteChannel();

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
  // bounce to /team — which redirects to the default channel. Runs as a
  // post-commit effect so React doesn't warn about setState/router calls
  // during render.
  const channelExists = channels.some((c) => c.id === initialChannel.id);
  useEffect(() => {
    if (!channelExists) router.replace("/team");
  }, [channelExists, router]);

  return (
    <div className="flex h-svh">
      <ChannelList
        channels={channels}
        activeChannelId={initialChannel.id}
        currentRole={currentUser.role}
        onlinePresenceCount={onlineUserIds.size}
        onCreate={() => setShowNew(true)}
        onOpenWorkspaceSearch={() => setWorkspaceSearchOpen(true)}
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
          onOpenSearch={() => setChannelSearchOpen(true)}
        />
        {channelSearchOpen && (
          <ChannelSearch
            channelId={initialChannel.id}
            onQueryChange={setChannelSearchQuery}
            onClose={() => {
              setChannelSearchOpen(false);
              setChannelSearchQuery("");
            }}
            onJumpTo={jumpToMessage}
          />
        )}
        <PinnedBar pins={pins} />
        <ChannelThread
          messages={channelState.messages}
          channelId={initialChannel.id}
          currentUser={currentUser}
          canPin={canPinMessage(currentUser.role)}
          hasMoreOlder={channelState.hasMoreOlder}
          onLoadOlder={channelState.loadOlder}
          hasMoreNewer={channelState.hasMoreNewer}
          onLoadNewer={channelState.loadNewer}
          anchored={channelState.anchored}
          pendingLiveCount={channelState.pendingLiveCount}
          onGoToLive={channelState.goToLive}
          searchQuery={activeSearchQuery}
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
          onUpdated={(ch) => {
            setShowEdit(false);
            toast.success(`Saved #${ch.name}`);
            router.refresh();
          }}
        />
      )}
      {deleteChannelDialog}
      <WorkspaceSearchDialog
        open={workspaceSearchOpen}
        onClose={() => setWorkspaceSearchOpen(false)}
      />
    </div>
  );
}
