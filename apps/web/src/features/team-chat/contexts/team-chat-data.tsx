"use client";

import { createContext, useContext, type ReactNode } from "react";
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
 * SPLIT INTO TWO CONTEXTS (perf, world-class audit 2026-07-06): the LIVE
 * `channels` array gets a NEW identity on essentially every team-wide message
 * (an unread / lastMessage bump anywhere), whereas the `teamMembers` roster is
 * stable for the session. The workspace BODY (feed + composer + scroll +
 * virtualizer) needs only the roster; if it subscribed to the combined value it
 * re-rendered on every message. So members and channels are separate contexts —
 * a members consumer never re-renders because a channel badge ticked. The one
 * place the workspace needs channels (the "active channel was deleted → leave"
 * redirect) is isolated in a null-rendering guard so it stays off the body's
 * render path.
 *
 * The active channel id is derived from the pathname so the provider stays
 * route-agnostic (a layout can't read its child segment's params), and the live
 * hook can suppress the unread bump for the channel currently on screen.
 */

const TeamMembersContext = createContext<User[] | null>(null);
const TeamChannelsContext = createContext<TeamChannelListItemDto[] | null>(null);

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

  // Two providers, not one memoized object: `teamMembers` is the (stable) server
  // prop so its Provider value is referentially stable across the pathname/
  // channel re-renders that churn `channels` — members consumers bail.
  return (
    <TeamMembersContext.Provider value={teamMembers}>
      <TeamChannelsContext.Provider value={channels}>
        {children}
      </TeamChannelsContext.Provider>
    </TeamMembersContext.Provider>
  );
}

/**
 * The stable team roster. Read this from anything that doesn't need the live
 * channel list — it never changes because a channel's unread badge ticked.
 */
export function useTeamMembers(): User[] {
  const value = useContext(TeamMembersContext);
  if (!value) {
    throw new Error(
      "useTeamMembers called outside TeamChatLayoutDataProvider — " +
        "the /team/layout.tsx provider must wrap any consumer.",
    );
  }
  return value;
}

/**
 * The LIVE channel list (unread/mention badges via sockets). Subscribing here
 * re-renders on every channel-list change, so read it ONLY where you render the
 * list itself (the sidebar) or genuinely need channel existence.
 */
export function useTeamChannels(): TeamChannelListItemDto[] {
  const value = useContext(TeamChannelsContext);
  if (!value) {
    throw new Error(
      "useTeamChannels called outside TeamChatLayoutDataProvider — " +
        "the /team/layout.tsx provider must wrap any consumer.",
    );
  }
  return value;
}
