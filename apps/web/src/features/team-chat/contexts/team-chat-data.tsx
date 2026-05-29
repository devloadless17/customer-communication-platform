"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { useTeamChannelsList } from "@/features/team-chat/hooks/use-team-channels-events";
import type { TeamChannelListItemDto } from "@ccp/shared/team-chat/types";
import type { User } from "@ccp/shared/types";

/**
 * Channel-agnostic data that lives at the /team/layout.tsx level: the LIVE
 * channel list (unread/mention badges kept in sync via sockets) and the team
 * roster.
 *
 * Hoisting them into the layout means they're fetched ONCE on first navigation
 * into /team and reused across all child route changes — channel switches don't
 * refetch them. The provider also runs the channel-list socket subscription
 * (`useTeamChannelsList`) ONCE here, so the two consumers — the channel sidebar
 * (in /team/layout.tsx) and the workspace (the page) — share a single live list
 * instead of each maintaining its own.
 *
 * The active channel id is derived from the pathname so the provider stays
 * route-agnostic (a layout can't read its child segment's params), and the live
 * hook can suppress the unread bump for the channel currently on screen.
 */
interface TeamChatLayoutData {
  channels: TeamChannelListItemDto[];
  teamMembers: User[];
}

const TeamChatLayoutDataContext = createContext<TeamChatLayoutData | null>(
  null,
);

/** `/team/<channelId>` → `<channelId>`; `/team` (pre-redirect) → null. */
function channelIdFromPathname(pathname: string | null): string | null {
  if (!pathname) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "team") return null;
  return segments[1] ?? null;
}

export function TeamChatLayoutDataProvider({
  initialChannels,
  teamMembers,
  currentUserId,
  children,
}: {
  initialChannels: TeamChannelListItemDto[];
  teamMembers: User[];
  currentUserId: string;
  children: ReactNode;
}) {
  const activeChannelId = channelIdFromPathname(usePathname());
  const channels = useTeamChannelsList(initialChannels, currentUserId, activeChannelId);

  // useMemo the context value so identity is stable across renders that
  // didn't change channels OR teamMembers. Previously a plain object
  // literal here re-rendered every consumer (channel sidebar, mentions
  // surface, workspace) on EVERY parent render — and the parent renders
  // on every `usePathname()` change inside `/team/*`. Per re-audit
  // 2026-05-29 finding #1.
  const value = useMemo(() => ({ channels, teamMembers }), [channels, teamMembers]);
  return (
    <TeamChatLayoutDataContext.Provider value={value}>
      {children}
    </TeamChatLayoutDataContext.Provider>
  );
}

/**
 * Read the layout-level snapshot of channels + team members. Throws if
 * called outside the provider — surfaces "you forgot to mount the
 * /team layout" loudly instead of silently passing empty arrays.
 */
export function useTeamChatLayoutData(): TeamChatLayoutData {
  const value = useContext(TeamChatLayoutDataContext);
  if (!value) {
    throw new Error(
      "useTeamChatLayoutData called outside TeamChatLayoutDataProvider — " +
        "the /team/layout.tsx provider must wrap any consumer.",
    );
  }
  return value;
}
