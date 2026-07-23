"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { useTeamChannelEvents } from "@/features/team-chat/hooks/use-team-channel-events";
import {
  useTeamChannels,
  useTeamDms,
  useTeamMembers,
} from "@/features/team-chat/contexts/team-chat-data";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { canPinInChannel } from "@ccp/shared/team-chat/permissions";
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
import { ChannelThread, type ChannelThreadScrollControls } from "./channel-thread";
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
  const softRefresh = useSoftRefresh();
  // Live channel list + team members come from the /team layout-level context.
  // The channel-list SIDEBAR (rendered in /team/layout.tsx) owns the socket
  // subscription; here we just read the live list — for the "active channel
  // deleted out from under me" redirect below — plus the roster for the
  // @-picker and member-name lookups.
  // Only the stable roster — the LIVE channel list is read by the null-rendering
  // <ChannelExistenceGuard> below, NOT here, so a channel-badge tick doesn't
  // re-render this whole workspace (feed + composer + virtualizer).
  const teamMembers = useTeamMembers();
  const channelState = useTeamChannelEvents(
    initialChannel.id,
    initialMessages,
    initialNextCursor,
    currentUser.id,
  );

  // Ref-track the live message list so `handleOpenThread` (defined once
  // `setThread` exists below) can stay a STABLE callback — read the list from
  // the ref instead of closing over it.
  const channelMessagesRef = useRef(channelState.messages);
  useEffect(() => {
    channelMessagesRef.current = channelState.messages;
  }, [channelState.messages]);

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
  //   - pin   → synthesize the row from the message already in state plus the
  //             pinnedAt/pinnedBy metadata the frame now carries. Falls back
  //             to refetching `/pins` when the pinned message is OFF the
  //             loaded slice (an older page), which is the one case we can't
  //             build locally.
  // The `connect` refetch below stays as the reconnect convergence path.
  useEffect(() => {
    const socket = getClientSocket();
    if (!socket) return;
    const channelId = initialChannel.id;
    let cancelled = false;

    const refetchPins = async () => {
      try {
        const res = await fetchWithSessionGuard(
          `/api/team-chat/channels/${channelId}/pins`,
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
      workspaceId: string;
      channelId: string;
      messageId: string;
      pinned: boolean;
      pinnedAt: string | null;
      pinnedById: string | null;
      pinnedByName: string | null;
    }) => {
      if (payload.channelId !== channelId) return;
      if (!payload.pinned) {
        setPins((prev) => prev.filter((p) => p.messageId !== payload.messageId));
        return;
      }
      // Synthesize the pin row from the message we already hold + the
      // metadata now carried on the frame — no refetch for the common case.
      const message = channelMessagesRef.current.find(
        (m) => m.id === payload.messageId,
      );
      if (!message || !payload.pinnedAt) {
        // Off-slice (pinned message is in an older page) or a pre-enrichment
        // frame — fall back to the authoritative list.
        void refetchPins();
        return;
      }
      const pinnedAt = payload.pinnedAt;
      setPins((prev) => {
        if (prev.some((p) => p.messageId === payload.messageId)) return prev;
        const next: ChannelPinDto = {
          messageId: payload.messageId,
          pinnedAt,
          pinnedById: payload.pinnedById,
          pinnedByName: payload.pinnedByName,
          message: { ...message, pinned: true },
        };
        // Newest pin first — same order listChannelPins returns, so the bar
        // doesn't reshuffle when a refetch eventually happens.
        return [next, ...prev].sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt));
      });
    };

    socket.on("team:channel:pin:changed", onPin);
    // Converge on reconnect: the pin event is one-shot, the socket recovery
    // window is only 30s, and this workspace never remounts on channel nav —
    // so a pin/unpin made while this tab was offline >30s would be missed and
    // the bar would stay stale until a full page reload. Mirror the
    // onConnect-refetch every other team-chat surface (feed/thread/sidebar) has.
    socket.on("connect", refetchPins);
    return () => {
      cancelled = true;
      socket.off("team:channel:pin:changed", onPin);
      socket.off("connect", refetchPins);
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
          `/api/team-chat/channels/${initialChannel.id}/messages/${messageId}/pin`,
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
  // STABLE thread-open handler. An inline closure passed to <ChannelThread>
  // got a fresh identity every render, which defeated ChannelMessage's `memo`
  // (its comparator checks `onOpenThread` identity) and re-rendered every
  // visible bubble per inbound message (L6). Reads the live list from
  // `channelMessagesRef` so the callback has no message-list dependency.
  const handleOpenThread = useCallback((rootId: string) => {
    const root = channelMessagesRef.current.find((m) => m.id === rootId);
    if (root) setThread(root);
  }, []);
  const [showEdit, setShowEdit] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  // Live override on top of `initialChannel.memberCount`. Bumped optimistically
  // when the members dialog adds/removes someone so the header pill updates
  // immediately.
  const [memberCountOverride, setMemberCountOverride] = useState<number | null>(
    null,
  );
  const [channelSearchOpen, setChannelSearchOpen] = useState(false);
  const [channelSearchQuery, setChannelSearchQuery] = useState("");

  // Everything above that is scoped to ONE channel has to be dropped on a
  // switch. The workspace is rendered without a `key`, so it does NOT remount
  // between /team/A and /team/B — state simply carries over. Left alone, the
  // header pill kept showing channel A's member count on channel B (forever,
  // since nothing else ever writes it), and the in-channel search bar stayed
  // open, still pre-filled with A's query, silently re-running it against B.
  useEffect(() => {
    setMemberCountOverride(null);
    setChannelSearchOpen(false);
    setChannelSearchQuery("");
  }, [initialChannel.id]);

  // `?q=` on the URL turns inline highlight on when the user lands here from a
  // workspace-search result. It is READ ONCE into component state and then
  // stripped from the URL (below, alongside `?jumpTo=`): leaving it there made
  // the highlight survive reloads and back-navigation forever, with no visible
  // way to turn it off. Now it's a dismissible, session-only affordance.
  const searchParams = useSearchParams();
  const [jumpHighlight, setJumpHighlight] = useState<string>("");

  // The query that drives bubble-level `<mark>` highlights. The search-result
  // landing wins when present; otherwise the in-channel search panel's live
  // input drives it (only when the panel is open). Both routes land on the
  // same prop so ChannelMessage's memo only sees one identity change.
  const activeSearchQuery =
    jumpHighlight || (channelSearchOpen ? channelSearchQuery : "") || null;

  /**
   * Scroll the feed to a message and flash a highlight. Cheap path: the
   * message is already in the loaded slice, find it by `data-message-id` and
   * `scrollIntoView`. Slow path: fetch a context window via `loadAround`,
   * which replaces the loaded slice and enters anchored mode; the receiving
   * `messages` state change triggers a re-render and a second rAF locates
   * the now-mounted row.
   */
  // useChatScroll controls published by the feed. jumpToMessage releases
  // stick-to-bottom (and flags the loadAround slice swap benign) BEFORE the
  // slice replaces — otherwise the hook snaps to the anchored window's bottom
  // and cascade-paginates back to live, defeating the jump.
  const scrollControlsRef = useRef<ChannelThreadScrollControls | null>(null);
  const handleScrollControlsReady = useCallback(
    (controls: ChannelThreadScrollControls) => {
      scrollControlsRef.current = controls;
    },
    [],
  );

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
      // Slow path — off-slice. Release stick-to-bottom + flag the loadAround
      // slice swap benign BEFORE it runs, so the hook doesn't snap the new
      // anchored window to its bottom (which cascade-paginates back to live
      // and defeats the jump). Then pull a context window and wait for the row
      // to render. The virtualizer renders in two frames typically; we poll
      // a few rAFs to give it room before giving up.
      scrollControlsRef.current?.releaseStickToBottom();
      scrollControlsRef.current?.markBenignTailUpdate();
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

  // Handle `?jumpTo=<id>` + `?q=` from a workspace-search result. Runs once per
  // distinct id so a re-render with the same query param doesn't re-jump.
  const lastJumpedRef = useRef<string | null>(null);
  useEffect(() => {
    const jumpId = searchParams?.get("jumpTo");
    const q = searchParams?.get("q") ?? "";
    if (!jumpId && !q) return;
    if (jumpId && lastJumpedRef.current !== jumpId) {
      lastJumpedRef.current = jumpId;
      void jumpToMessage(jumpId);
    }
    if (q) setJumpHighlight(q);
    // Strip BOTH params so a refresh doesn't re-trigger the jump and doesn't
    // resurrect the highlight. `history.replaceState` rewrites the URL without
    // a navigation (and without re-running the RSC page).
    const next = new URL(window.location.href);
    next.searchParams.delete("jumpTo");
    next.searchParams.delete("q");
    next.searchParams.delete("n");
    window.history.replaceState(null, "", next.toString());
  }, [searchParams, jumpToMessage]);

  // A search-result highlight belongs to the visit that produced it — drop it
  // as soon as the user moves to another channel. `lastJumpedRef` clears with
  // it: it exists only to stop ONE `?jumpTo=` from re-firing on re-render, and
  // keeping it forever meant re-opening the same search hit a second time was
  // a no-op (URL changed, banner appeared, feed never moved).
  //
  // Guarded on an ACTUAL id change rather than a bare `[initialChannel.id]`
  // dep: effects run in declaration order, so on mount this one fires right
  // after the `?q=` reader above and wiped the highlight the search landing
  // had just set — the banner never appeared at all.
  const highlightChannelRef = useRef(initialChannel.id);
  useEffect(() => {
    if (highlightChannelRef.current === initialChannel.id) return;
    highlightChannelRef.current = initialChannel.id;
    setJumpHighlight("");
    lastJumpedRef.current = null;
  }, [initialChannel.id]);
  const { deleteChannel, confirmDialog: deleteChannelDialog } = useDeleteChannel();

  /**
   * Leave this channel. Reuses the EXISTING self-removal route — the service
   * already permits any role to remove themselves, blocks the default
   * channel, publishes members_changed, and evicts the socket from the
   * channel room. No new endpoint needed.
   */
  const leaveChannel = useCallback(async () => {
    try {
      const res = await fetchWithSessionGuard(
        `/api/team-chat/channels/${initialChannel.id}/members/${currentUser.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(json.detail ?? "Couldn't leave that channel.");
        return;
      }
      toast.success(`Left #${initialChannel.name ?? ""}`);
      // /team redirects to the default channel, which we're always a member
      // of — so this can't land on a channel we just lost access to.
      window.location.assign("/team");
    } catch {
      toast.error("Couldn't leave that channel.");
    }
  }, [initialChannel.id, initialChannel.name, currentUser.id]);

  /**
   * The peer identity for a DM header. Read from the live DM list rather than
   * refetched — the layout already loads it, and the header only needs a
   * name/avatar. Null for channels.
   */
  /**
   * The read receipt FROZEN at channel-open time.
   *
   * Must not be read live: `useTeamChannelEvents` fires markRead() on mount,
   * so a live value would advance to "now" and erase the divider before it
   * ever painted. Re-seeded only when the channel id changes — matching
   * Slack, where the divider stays put for the whole visit.
   */
  const frozenLastReadAtRef = useRef(initialChannel.lastReadAt);
  const [frozenChannelId, setFrozenChannelId] = useState(initialChannel.id);
  if (frozenChannelId !== initialChannel.id) {
    setFrozenChannelId(initialChannel.id);
    frozenLastReadAtRef.current = initialChannel.lastReadAt;
  }
  const frozenLastReadAt = frozenLastReadAtRef.current;

  const dms = useTeamDms();
  const dmPeer = useMemo(() => {
    if (initialChannel.kind !== "dm") return null;
    // Live list first (it tracks renames / avatar changes without a reload),
    // then the server-rendered peer on the channel itself. The fallback is what
    // makes a JUST-created DM paint the right person immediately: the live list
    // comes from the /team LAYOUT, which hasn't refetched yet at that moment, so
    // on its own it rendered a blank avatar titled "Direct message".
    return (
      dms.find((d) => d.id === initialChannel.id)?.peer ??
      initialChannel.peer ??
      null
    );
  }, [dms, initialChannel.id, initialChannel.kind, initialChannel.peer]);

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
  return (
    // The channel-list sidebar lives in /team/layout.tsx (SectionShell slot)
    // now — both the desktop column and the mobile hamburger drawer. This
    // workspace is just the active channel's feed + composer + thread panel.
    <div className="relative flex h-[calc(100svh-3rem)] md:h-svh">
      {/* Owns the "active channel deleted → leave" redirect. A null-rendering
          leaf so subscribing to the live channel list stays OFF this body's
          render path. */}
      <ChannelExistenceGuard channelId={initialChannel.id} />
      {/* Landmark heading for a DM. The route's server component can only see
          `channel.name` (null for every DM), so it hands this case over here
          where the peer is resolved — otherwise heading navigation announced
          the identical "Direct message" for every conversation. */}
      {initialChannel.kind === "dm" && (
        <h1 className="sr-only max-md:hidden">
          {dmPeer ? `Direct message with ${dmPeer.name}` : "Direct message"}
        </h1>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelHeader
          channel={initialChannel}
          currentRole={currentUser.role}
          memberCount={memberCountOverride ?? initialChannel.memberCount}
          onEdit={() => setShowEdit(true)}
          onDelete={() => {
            void deleteChannel(initialChannel.id, "/team");
          }}
          onOpenSearch={() => setChannelSearchOpen(true)}
          onOpenMembers={() => setShowMembers(true)}
          onLeave={() => void leaveChannel()}
          dmPeer={dmPeer}
        />
        {showMembers && (
          <ChannelMembersDialog
            workspaceId={currentUser.workspaceId}
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
        {/* Search-landing highlight is stateful, so it needs a visible exit —
            without one the `<mark>`s just looked like a stuck rendering bug. */}
        {jumpHighlight && !channelSearchOpen && (
          <div className="flex items-center gap-2 border-b border-border bg-warning-bg/40 px-4 py-1.5 text-xs">
            <span className="min-w-0 truncate text-muted-foreground">
              Highlighting matches for{" "}
              <span className="font-medium text-foreground">“{jumpHighlight}”</span>
            </span>
            <button
              type="button"
              onClick={() => setJumpHighlight("")}
              className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-accent"
            >
              Clear
            </button>
          </div>
        )}
        {/* Keyed by channel: the bar's expanded/collapsed default is derived
            from the pin COUNT in a state initializer, and this workspace never
            remounts on a channel switch — so a 1-pin channel's expanded bar
            carried into a 14-pin channel and swallowed the feed. */}
        <PinnedBar
          key={initialChannel.id}
          pins={pins}
          canPin={canPinInChannel(currentUser.role, initialChannel.kind)}
          onUnpin={unpinFromBar}
        />
        <ChannelThread
          messages={channelState.messages}
          channelId={initialChannel.id}
          currentUser={currentUser}
          canPin={canPinInChannel(currentUser.role, initialChannel.kind)}
          hasMoreOlder={channelState.hasMoreOlder}
          onLoadOlder={channelState.loadOlder}
          hasMoreNewer={channelState.hasMoreNewer}
          onLoadNewer={channelState.loadNewer}
          anchored={channelState.anchored}
          pendingLiveCount={channelState.pendingLiveCount}
          onGoToLive={channelState.goToLive}
          searchQuery={activeSearchQuery}
          displayNameById={namesById}
          lastReadAt={frozenLastReadAt}
          isDm={initialChannel.kind === "dm"}
          onOpenThread={handleOpenThread}
          onRetry={channelState.retryOptimistic}
          onDismiss={channelState.removeOptimistic}
          onScrollControlsReady={handleScrollControlsReady}
        />
        <div className="border-t border-border">
          <TypingIndicator
            userIds={channelState.typingUserIds}
            namesById={namesById}
            viewerUserId={currentUser.id}
          />
        </div>
        {/* A DM with someone who has left the team is read-only. This is the
            contract `DirectMessagePeerDto.deactivated` has documented since it
            was introduced ("history stays readable, composer disabled") — it
            just was never wired, so agents could type a handover note into a
            conversation nobody will ever open again. The server rejects the
            send too; this is the affordance, not the enforcement. */}
        {dmPeer?.deactivated ? (
          <div className="border-t border-border px-4 py-3 text-center text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{dmPeer.name}</span>{" "}
            no longer has an account on this team. You can still read this
            conversation, but you can&rsquo;t send new messages.
          </div>
        ) : (
          <ChannelComposer
            channelId={initialChannel.id}
            channelName={initialChannel.name}
            currentUser={currentUser}
            teamMembers={teamMembers}
            onOptimisticAdd={channelState.addOptimistic}
            onOptimisticFail={channelState.markOptimisticFailed}
            onOptimisticConfirm={channelState.confirmOptimistic}
          />
        )}
      </div>

      {liveThreadRoot && (
        <ThreadPanel
          channelId={initialChannel.id}
          channelName={initialChannel.name}
          rootMessage={liveThreadRoot}
          currentUser={currentUser}
          teamMembers={teamMembers}
          canPin={canPinInChannel(currentUser.role, initialChannel.kind)}
          onClose={() => setThread(null)}
        />
      )}

      {showEdit && (
        <EditChannelDialog
          channel={initialChannel}
          currentRole={currentUser.role}
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

/**
 * Null-rendering leaf that owns the "active channel was deleted → leave"
 * redirect. It's the ONLY thing in the workspace subtree that subscribes to the
 * live channel list, so a channel-badge tick re-renders just this (which paints
 * nothing) instead of the feed/composer/virtualizer.
 */
function ChannelExistenceGuard({ channelId }: { channelId: string }) {
  const channels = useTeamChannels();
  // DMs are deliberately excluded from the channel list, so this guard MUST
  // consult the DM list too. Without it, every DM looked "deleted" the moment
  // it opened and the guard bounced the user straight back to /team.
  const dms = useTeamDms();
  const router = useRouter();
  // Only treat "channel missing from my list" as a deletion when the list is
  // NON-EMPTY. An EMPTY list means "I'm not a member of anything" — e.g. a user
  // whose default-channel membership row was never created (superadmin-seed
  // gap, migration 20260525145612_backfill_default_channel_membership). Without
  // this, such a user loops: /team → /team/<general> → sees channels=[] →
  // channelExists=false → replace("/team") → repeat ("infinite page refresh" in
  // prod). A real deletion always leaves ≥1 other channel (or zero, in which
  // case /team's own "No channels yet" empty state is the correct landing).
  const channelExists =
    channels.some((c) => c.id === channelId) || dms.some((d) => d.id === channelId);
  // The emptiness check spans BOTH lists for the same reason: a user with no
  // channels but an open DM must not be treated as "list not loaded yet".
  const knownCount = channels.length + dms.length;

  // GRACE PERIOD before the first eviction check.
  //
  // A just-created DM is navigated to immediately, but this context won't hold
  // it until either the `team:dm:created` refetch or the RSC refresh lands —
  // both in flight. Without the delay the guard sees "channel absent from a
  // non-empty list" and bounces the user straight back to /team, and whether
  // it fires depends on which network round-trip wins. A real deletion is
  // rare and not urgent, so trading instant eviction for a stable open is the
  // right side of that tradeoff.
  const [graceElapsed, setGraceElapsed] = useState(false);
  useEffect(() => {
    setGraceElapsed(false);
    const t = setTimeout(() => setGraceElapsed(true), 2_000);
    return () => clearTimeout(t);
  }, [channelId]);

  useEffect(() => {
    if (!graceElapsed) return;
    if (knownCount > 0 && !channelExists) router.replace("/team");
  }, [graceElapsed, knownCount, channelExists, router]);
  return null;
}
