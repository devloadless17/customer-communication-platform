"use client";

import { useEffect, useState } from "react";

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
 */
export function useTeamChannelsList(
  initial: TeamChannelListItemDto[],
  currentUserId: string,
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

  useEffect(() => {
    const socket = getClientSocket();

    const onMessage: Parameters<typeof socket.on<"team:channel:message">>[1] = (payload) => {
      // Replies (preview === null) shouldn't bump the channel preview. The
      // list still cares about reply mentions but we keep that simple for
      // v0 — only top-level mentions bump the mention counter.
      if (payload.preview === null) return;
      setChannels((prev) => {
        const idx = prev.findIndex((ch) => ch.id === payload.channelId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        // Author-of-this-message doesn't get a badge for their own send.
        const isOwnSend = payload.message.authorUserId === currentUserId;
        const mentionsMe = payload.message.mentionedUserIds.includes(currentUserId);
        const next = prev.slice();
        next[idx] = {
          ...existing,
          lastMessageAt: payload.lastMessageAt ?? existing.lastMessageAt,
          lastMessagePreview: payload.preview ?? existing.lastMessagePreview,
          unreadForMe: isOwnSend ? existing.unreadForMe : true,
          unreadMentionCount: mentionsMe
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

    socket.on("team:channel:message", onMessage);
    socket.on("team:channel:read", onRead);
    socket.on("team:catalog:changed", onCatalog);

    return () => {
      socket.off("team:channel:message", onMessage);
      socket.off("team:channel:read", onRead);
      socket.off("team:catalog:changed", onCatalog);
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
