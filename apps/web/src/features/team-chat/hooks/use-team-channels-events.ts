"use client";

import { useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import type { TeamChannelListItemDto } from "@ccp/shared/team-chat/types";

/**
 * Sidebar-side channel list state. Subscribes to:
 *   - team:channel:message  → bump unreadForMe + preview on the matching channel
 *   - team:channel:read     → if read by ME, clear unreadForMe
 *   - team:catalog:changed/team-channels → refetch the full list (create / rename / delete)
 *
 * Keeping this separate from `useTeamChannelEvents` (which scopes to ONE
 * channel feed) means switching channels doesn't re-run the list-side
 * subscriptions on every click.
 *
 * `activeChannelId` is the channel the user is currently viewing in THIS
 * tab. Inbound messages for that channel must not flip unreadForMe true —
 * the per-channel hook fires `markRead` server-side, but its round-trip
 * leaves a ~100ms window where the sidebar would otherwise show stale
 * unread state. Clicking away during that window left the dot stuck on
 * the just-viewed channel.
 */
export function useTeamChannelsList(
  initial: TeamChannelListItemDto[],
  currentUserId: string,
  activeChannelId: string | null,
): TeamChannelListItemDto[] {
  const [channels, setChannels] = useState(initial);

  // Sync from the server-rendered prop on the first render after a server
  // nav (e.g. switching channels via the URL refreshes server data).
  const [trackedKey, setTrackedKey] = useState(() => signatureOf(initial));
  const incomingKey = signatureOf(initial);
  if (trackedKey !== incomingKey) {
    setTrackedKey(incomingKey);
    setChannels(initial);
  }

  // Ref so socket listeners read the latest active channel without
  // re-binding the effect on every channel switch.
  const activeChannelIdRef = useRef(activeChannelId);
  activeChannelIdRef.current = activeChannelId;

  useEffect(() => {
    const socket = getClientSocket();

    const onMessage: Parameters<typeof socket.on<"team:channel:message">>[1] = (payload) => {
      // Replies (preview === null) shouldn't bump the channel preview. The
      // list still cares about reply mentions but we keep that simple for
      // v0 — only top-level mentions bump the mention counter.
      if (payload.preview === null) return;
      const isActive = payload.channelId === activeChannelIdRef.current;
      setChannels((prev) => {
        const idx = prev.findIndex((ch) => ch.id === payload.channelId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        // Author-of-this-message doesn't get a badge for their own send.
        // Same posture for the channel the user is actively viewing — the
        // per-channel hook fires markRead, no point round-tripping a true→
        // false flip through the sidebar.
        const isOwnSend = payload.message.authorUserId === currentUserId;
        const skipUnreadBump = isOwnSend || isActive;
        const mentionsMe = payload.message.mentionedUserIds.includes(currentUserId);
        const bumpMention = mentionsMe && !isActive;
        const next = prev.slice();
        next[idx] = {
          ...existing,
          lastMessageAt: payload.lastMessageAt ?? existing.lastMessageAt,
          lastMessagePreview: payload.preview ?? existing.lastMessagePreview,
          unreadForMe: skipUnreadBump ? existing.unreadForMe : true,
          unreadMentionCount: bumpMention
            ? existing.unreadMentionCount + 1
            : existing.unreadMentionCount,
        };
        return next;
      });
    };

    const onRead: Parameters<typeof socket.on<"team:channel:read">>[1] = (payload) => {
      if (payload.readByUserId !== currentUserId) return;
      setChannels((prev) => {
        const idx = prev.findIndex((ch) => ch.id === payload.channelId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        // Already-read → bail. A teammate's mark-read AND our own /read POST
        // both fire this; second arrival is a no-op.
        if (!existing.unreadForMe && existing.unreadMentionCount === 0) return prev;
        const next = prev.slice();
        next[idx] = { ...existing, unreadForMe: false, unreadMentionCount: 0 };
        return next;
      });
    };

    const onCatalog: Parameters<typeof socket.on<"team:catalog:changed">>[1] = (payload) => {
      if (payload.scope !== "team-channels") return;
      // Refetch — a create/rename/delete is rare enough that an extra GET
      // is fine, and applying a delta event per scope would triple the
      // surface area for catalog changes.
      void fetchWithSessionGuard("/api/team/channels")
        .then((r) => (r.ok ? r.json() : null))
        .then((res) => {
          if (res?.items) setChannels(res.items as TeamChannelListItemDto[]);
        })
        .catch(() => {});
    };

    const onMembersChanged: Parameters<
      typeof socket.on<"team:channel:members:changed">
    >[1] = (payload) => {
      // Optimistic local prune/add for the affected user — the catalog tick
      // that rides along will trigger a refetch a few ms later, but acting
      // immediately removes the "I was just kicked but I can still see it"
      // window.
      const meAffected = payload.userIds.includes(currentUserId);
      if (!meAffected) return;
      setChannels((prev) => {
        if (payload.action === "removed") {
          return prev.filter((ch) => ch.id !== payload.channelId);
        }
        // For "added", the catalog refetch will populate full DTO fields
        // (unreadForMe, mentionCount). No-op here; we don't have a full DTO
        // for the channel from the event payload.
        return prev;
      });
    };

    socket.on("team:channel:message", onMessage);
    socket.on("team:channel:read", onRead);
    socket.on("team:catalog:changed", onCatalog);
    socket.on("team:channel:members:changed", onMembersChanged);

    return () => {
      socket.off("team:channel:message", onMessage);
      socket.off("team:channel:read", onRead);
      socket.off("team:catalog:changed", onCatalog);
      socket.off("team:channel:members:changed", onMembersChanged);
    };
  }, [currentUserId]);

  return channels;
}

/** Stable string signature for fast equality across server-prop updates. */
function signatureOf(list: TeamChannelListItemDto[]): string {
  return list
    .map((c) => `${c.id}:${c.lastMessageAt}:${c.unreadForMe ? 1 : 0}:${c.unreadMentionCount}`)
    .join("|");
}
