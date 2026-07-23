"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import type { TeamChannelListItemDto } from "@ccp/shared/team-chat/types";

/**
 * Sidebar-side channel list state. Subscribes to:
 *   - team:channel:activity → (TEAM room) bump unreadForMe + mention counter +
 *                             lastMessageAt for ANY channel, including ones this
 *                             tab isn't subscribed to. This is the sole driver
 *                             of the badge state — it reaches every channel
 *                             uniformly, unlike the channel-room frame below.
 *   - team:channel:message  → (CHANNEL room, only the active/subscribed channel)
 *                             update lastMessagePreview only. Carries the body,
 *                             which the team-room activity frame deliberately
 *                             omits for confidentiality; badge bumps are NOT
 *                             done here (that would double-count vs activity).
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
/**
 * Generalized over the DTO so the CHANNEL sidebar and the DM sidebar are two
 * instances of the same hook rather than two copies of this logic. Every frame
 * handled below already reaches DM members correctly — `emitChannelScoped`
 * fans activity/read to each member's `user:` room, and a DM is just a
 * two-member private channel — so nothing here needed DM-specific branching.
 *
 * Duplicating these ~200 lines for DMs would have guaranteed the two surfaces
 * eventually disagreed about what "unread" means.
 *
 * @param refetchUrl the endpoint that returns `{ items }` for THIS surface
 *                   (`/api/workspace/channels` or `/api/workspace/channels/dms`).
 * @param extraRefetchEvents socket events that should trigger a refetch on top
 *                   of the shared ones — the DM list passes `team:dm:created`.
 */
/**
 * Stable empty default. A default parameter is re-evaluated on EVERY call, so
 * `= []` handed the effect a fresh array identity per render and re-bound all
 * six socket listeners each time the provider re-rendered — which it does on
 * every activity frame.
 */
const NO_EXTRA_EVENTS: readonly "team:dm:created"[] = [];

export function useTeamChannelsList<T extends TeamChannelListItemDto>(
  initial: T[],
  currentUserId: string,
  activeChannelId: string | null,
  refetchUrl = "/api/workspace/channels",
  extraRefetchEvents: readonly "team:dm:created"[] = NO_EXTRA_EVENTS,
): T[] {
  const [channels, setChannels] = useState(initial);

  // Sync from the server-rendered prop on the first render after a server
  // nav (e.g. switching channels via the URL refreshes server data).
  const [trackedKey, setTrackedKey] = useState(() => signatureOf(initial));
  // Memoized — `signatureOf` is an O(n) concat over every channel; without this
  // it re-ran on every provider render (which happens on each activity frame).
  const incomingKey = useMemo(() => signatureOf(initial), [initial]);
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

    // TEAM-room frame — the badge driver. Reaches every channel (not just the
    // subscribed one), so the sidebar dot + mention counter update live no
    // matter which channel the tab currently has open.
    const onActivity: Parameters<typeof socket.on<"team:channel:activity">>[1] = (payload) => {
      const isActive = payload.channelId === activeChannelIdRef.current;
      setChannels((prev) => {
        const idx = prev.findIndex((ch) => ch.id === payload.channelId);
        if (idx === -1) return prev; // not a member of this channel → ignore
        const existing = prev[idx]!;
        // Author-of-this-message doesn't get a badge for their own send. Same
        // posture for the channel the user is actively viewing — the per-channel
        // hook fires markRead, no point round-tripping a true→false flip through
        // the sidebar. Replies never bump the unread dot (mention-only).
        const isOwnSend = payload.authorUserId === currentUserId;
        const skipUnreadBump = isOwnSend || isActive || payload.isReply;
        const mentionsMe = payload.mentionedUserIds.includes(currentUserId);
        const bumpMention = mentionsMe && !isActive && !isOwnSend;
        const nextLastMessageAt = payload.lastMessageAt ?? existing.lastMessageAt;
        const nextUnread = skipUnreadBump ? existing.unreadForMe : true;
        const nextMentionCount = bumpMention
          ? existing.unreadMentionCount + 1
          : existing.unreadMentionCount;
        // Nothing changed (e.g. own send to a channel with nothing to bump) →
        // bail to avoid a needless re-render of the whole sidebar list.
        if (
          nextLastMessageAt === existing.lastMessageAt &&
          nextUnread === existing.unreadForMe &&
          nextMentionCount === existing.unreadMentionCount
        ) {
          return prev;
        }
        const next = prev.slice();
        next[idx] = {
          ...existing,
          lastMessageAt: nextLastMessageAt,
          unreadForMe: nextUnread,
          unreadMentionCount: nextMentionCount,
        };
        return next;
      });
    };

    // CHANNEL-room frame — only reaches the subscribed/active channel and
    // carries the body. Updates the preview text ONLY; the badge state is owned
    // by onActivity above (the team-room frame) to avoid double-counting.
    const onMessage: Parameters<typeof socket.on<"team:channel:message">>[1] = (payload) => {
      // Replies (preview === null) don't surface in the channel-list preview.
      if (payload.preview === null) return;
      setChannels((prev) => {
        const idx = prev.findIndex((ch) => ch.id === payload.channelId);
        if (idx === -1) return prev;
        const existing = prev[idx]!;
        if (
          existing.lastMessagePreview === payload.preview &&
          (payload.lastMessageAt ?? existing.lastMessageAt) === existing.lastMessageAt
        ) {
          return prev;
        }
        const next = prev.slice();
        next[idx] = {
          ...existing,
          lastMessageAt: payload.lastMessageAt ?? existing.lastMessageAt,
          lastMessagePreview: payload.preview ?? existing.lastMessagePreview,
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

    const refetchChannels = () => {
      void fetchWithSessionGuard(refetchUrl)
        .then((r) => (r.ok ? r.json() : null))
        .then((res) => {
          if (res?.items) setChannels(res.items as T[]);
        })
        .catch(() => {});
    };

    const onCatalog: Parameters<typeof socket.on<"team:catalog:changed">>[1] = (payload) => {
      if (payload.scope !== "team-channels") return;
      // Refetch — a create/rename/delete is rare enough that an extra GET
      // is fine, and applying a delta event per scope would triple the
      // surface area for catalog changes.
      refetchChannels();
    };

    // Reconnect recovery. This sidebar applies live deltas (message/read/
    // members) but has no other convergence path, so a socket drop longer than
    // the 30s connection-state-recovery window silently misses every frame —
    // most importantly a teammate's read clearing an unread dot, or a new
    // channel created while we were offline. On (re)connect, refetch the full
    // list so the badges/previews converge to server truth. (`connect` fires
    // only on a genuine (re)connection; a redundant fetch on a cold first
    // connect is harmless and rare.)
    const onConnect = () => refetchChannels();

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

    socket.on("team:channel:activity", onActivity);
    socket.on("team:channel:message", onMessage);
    socket.on("team:channel:read", onRead);
    socket.on("team:catalog:changed", onCatalog);
    socket.on("team:channel:members:changed", onMembersChanged);
    socket.on("connect", onConnect);
    // The DM list passes `team:dm:created` here: a brand-new DM has no row to
    // patch, so the only correct response is to refetch the (membership-
    // filtered) list. That's also why the frame itself carries no peer data.
    for (const evt of extraRefetchEvents) socket.on(evt, refetchChannels);

    return () => {
      socket.off("team:channel:activity", onActivity);
      socket.off("team:channel:message", onMessage);
      socket.off("team:channel:read", onRead);
      socket.off("team:catalog:changed", onCatalog);
      socket.off("team:channel:members:changed", onMembersChanged);
      socket.off("connect", onConnect);
      for (const evt of extraRefetchEvents) socket.off(evt, refetchChannels);
    };
    // `extraRefetchEvents` is a module-level constant at every call site, so
    // it's referentially stable and safe in the dep array.
  }, [currentUserId, refetchUrl, extraRefetchEvents]);

  return channels;
}

/** Stable string signature for fast equality across server-prop updates. */
function signatureOf(list: readonly TeamChannelListItemDto[]): string {
  return list
    .map((c) => `${c.id}:${c.lastMessageAt}:${c.unreadForMe ? 1 : 0}:${c.unreadMentionCount}`)
    .join("|");
}
