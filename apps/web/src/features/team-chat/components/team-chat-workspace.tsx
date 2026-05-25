"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { useTeamChannelEvents } from "@/features/team-chat/hooks/use-team-channel-events";
import { useTeamChatLayoutData } from "@/features/team-chat/contexts/team-chat-data";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { canPinMessage } from "@ccp/shared/team-chat/permissions";
import type {
  ChannelPinDto,
  TeamChannelDto,
  TeamChannelMessageDto,
} from "@ccp/shared/team-chat/types";
import type { User } from "@ccp/shared/types";

import { ChannelComposer } from "./channel-composer";
import { ChannelHeader } from "./channel-header";
import { ChannelMembersDialog } from "./channel-members-dialog";
import { ChannelSearch } from "./channel-search";
import { ChannelThread } from "./channel-thread";
import { EditChannelDialog, useDeleteChannel } from "./channel-dialogs";

import { PinnedBar } from "./pinned-bar";
import { ThreadPanel } from "./thread-panel";
import { TypingIndicator } from "./typing-indicator";

/**
 * Top-level client component for /team/[channelId]. Orchestrates the active
 * channel only:
 *   - the channel feed + composer
 *   - the optional thread side panel
 *   - the channel header + edit / members / delete dialogs
 *
 * The channel-list sidebar (with live unread badges + presence) and the
 * new-channel / workspace-search dialogs live in /team/layout.tsx now
 * (TeamChannelSidebar), so they stay mounted across channel switches.
 *
 * Server props are the SSR seed; everything else is live socket state.
 */
export function TeamChatWorkspace({
  currentUser,
  initialChannel,
  initialMessages,
  initialNextCursor,
  initialPins,
}: {
  currentUser: User;
  initialChannel: TeamChannelDto;
  initialMessages: TeamChannelMessageDto[];
  initialNextCursor: string | null;
  initialPins: ChannelPinDto[];
}) {
  const router = useRouter();
  const softRefresh = useSoftRefresh();
  // Live channel list + team members come from the /team layout-level context.
  // The channel-list SIDEBAR (rendered in /team/layout.tsx) owns the socket
  // subscription; here we just read the live list — for the "active channel
  // deleted out from under me" redirect below — plus the roster for the
  // @-picker and member-name lookups.
  const { channels, teamMembers } = useTeamChatLayoutData();
  const channelState = useTeamChannelEvents(
    initialChannel.id,
    initialMessages,
    initialNextCursor,
    currentUser.id,
  );

  // Pins: hydrate from SSR, keep in sync via `team:channel:pin:changed`.
  //
  // Reset on channel switch: useEffect (NOT useMemo). useMemo running a
  // setState is a side effect — Strict Mode double-invokes it and the
  // eslint disable was hiding the bug. The effect runs once per channel
  // change; the dep on initialPins reseeds when the SSR payload bumps.
  const [pins, setPins] = useState(initialPins);
  useEffect(() => {
    setPins(initialPins);
  }, [initialPins, initialChannel.id]);

  // Socket-driven pin updates.
  //   - unpin → filter the messageId out of the bar (fast, no fetch)
  //   - pin   → refetch `/pins` to grab the new PinnedItem with author +
  //             pinnedAt + full message DTO. The event payload only carries
  //             { messageId, pinned } so we can't synthesize the row
  //             locally without re-deriving the author/message — refetching
  //             is simpler than threading a full DTO through the event.
  //             Pins are rare events so the extra GET is negligible.
  useEffect(() => {
    const socket = getClientSocket();
    if (!socket) return;
    const channelId = initialChannel.id;
    let cancelled = false;

    const refetchPins = async () => {
      try {
        const res = await fetchWithSessionGuard(
          `/api/team/channels/${channelId}/pins`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { pins: ChannelPinDto[] };
        if (cancelled) return;
        setPins(data.pins);
      } catch {
        // Reconciles on next event or channel re-mount.
      }
    };

    const onPin = (payload: {
      teamId: string;
      channelId: string;
      messageId: string;
      pinned: boolean;
    }) => {
      if (payload.channelId !== channelId) return;
      if (!payload.pinned) {
        setPins((prev) => prev.filter((p) => p.messageId !== payload.messageId));
      } else {
        void refetchPins();
      }
    };

    socket.on("team:channel:pin:changed", onPin);
    return () => {
      cancelled = true;
      socket.off("team:channel:pin:changed", onPin);
    };
  }, [initialChannel.id]);

  // Unpin handler invoked from the PinnedBar row's X button. Optimistically
  // drops the row; the socket event will confirm (no-op since the row is
  // already gone) or — on server error — `refetchPins` reconciles via the
  // next pin event from another tab. We keep the call simple: no toast on
  // success, an error toast on failure with the affected snippet so the
  // admin knows which one didn't go through.
  const unpinFromBar = useCallback(
    async (messageId: string) => {
      const previous = pins;
      setPins((prev) => prev.filter((p) => p.messageId !== messageId));
      try {
        const res = await fetchWithSessionGuard(
          `/api/team/channels/${initialChannel.id}/messages/${messageId}/pin`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          setPins(previous);
          toast.error("Couldn't unpin", { description: `HTTP ${res.status}` });
        }
      } catch {
        setPins(previous);
        toast.error("Couldn't unpin", { description: "Network error" });
      }
    },
    [initialChannel.id, pins],
  );

  const [thread, setThread] = useState<TeamChannelMessageDto | null>(null);
  // Close the thread panel on channel switch. Without this, navigating
  // from channel A (with a thread open) to channel B leaves `thread`
  // pointing at A's root message — `ThreadPanel` then renders with
  // `(channelId=B, rootMessage=fromA)` and `useThreadEvents` fetches
  // a thread that doesn't belong to this channel.
  useEffect(() => {
    setThread(null);
  }, [initialChannel.id]);
  const [showEdit, setShowEdit] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  // Live override on top of `initialChannel.memberCount`. Bumped optimistically
  // when the members dialog adds/removes someone so the header pill updates
  // immediately, and reset when the parent re-renders against a fresher
  // initialChannel.
  const [memberCountOverride, setMemberCountOverride] = useState<number | null>(
    null,
  );
  const [channelSearchOpen, setChannelSearchOpen] = useState(false);
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
  //
  // GUARD: only treat "channel missing from my list" as a deletion when the
  // list is NON-EMPTY. An EMPTY list means "I'm not a member of anything" —
  // e.g. a user whose default-channel membership row was never created (the
  // superadmin-seed gap, fixed in migration
  // 20260525145612_backfill_default_channel_membership). Without this guard,
  // such a user loops: /team → redirect to /team/<general> → workspace sees
  // channels=[] so channelExists=false → router.replace("/team") → repeat.
  // That presented in production as an "infinite page refresh." A real
  // deletion always leaves the user with ≥1 other channel (or zero, in which
  // case /team's own "No channels yet" empty-state is the correct landing —
  // not a loop back through here).
  const channelExists = channels.some((c) => c.id === initialChannel.id);
  useEffect(() => {
    if (channels.length > 0 && !channelExists) router.replace("/team");
  }, [channels.length, channelExists, router]);

  return (
    // The channel-list sidebar lives in /team/layout.tsx (SectionShell slot)
    // now — both the desktop column and the mobile hamburger drawer. This
    // workspace is just the active channel's feed + composer + thread panel.
    <div className="flex h-svh">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelHeader
          channel={initialChannel}
          currentRole={currentUser.role}
          memberCount={memberCountOverride ?? initialChannel.memberCount}
          typingUserIds={channelState.typingUserIds}
          teamMemberNameById={namesById}
          onEdit={() => setShowEdit(true)}
          onDelete={() => {
            void deleteChannel(initialChannel.id, "/team");
          }}
          onOpenSearch={() => setChannelSearchOpen(true)}
          onOpenMembers={() => setShowMembers(true)}
        />
        {showMembers && (
          <ChannelMembersDialog
            channel={initialChannel}
            currentUser={{ id: currentUser.id }}
            currentRole={currentUser.role}
            allTeamMembers={teamMembers}
            onClose={() => setShowMembers(false)}
            onChanged={(n) => setMemberCountOverride(n)}
          />
        )}
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
        <PinnedBar
          pins={pins}
          canPin={canPinMessage(currentUser.role)}
          onUnpin={unpinFromBar}
        />
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

      {showEdit && (
        <EditChannelDialog
          channel={initialChannel}
          onClose={() => setShowEdit(false)}
          onUpdated={(ch) => {
            setShowEdit(false);
            toast.success(`Saved #${ch.name}`);
            softRefresh();
          }}
        />
      )}
      {deleteChannelDialog}
    </div>
  );
}
