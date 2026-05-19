"use client";

import { createContext, useContext, type ReactNode } from "react";

import type {
  TeamChannelListItemDto,
} from "@ccp/shared/team-chat/types";
import type { User } from "@ccp/shared/types";

/**
 * Channel-agnostic data that lives at the /team/layout.tsx level.
 *
 * Before this, /team/[channelId]/page.tsx fetched the full channel list
 * AND the team roster on every channel switch, even though neither
 * changes when the user clicks a different channel. Hoisting them into
 * the layout means the layout fetches them ONCE on first navigation
 * into /team and reuses them across all child route changes — channel
 * switches drop from 5 parallel fetches to 3.
 *
 * The context is the bridge: the layout is a server component that
 * fetches, this client provider takes them as props, the workspace
 * reads them via {@link useTeamChatLayoutData}.
 */
interface TeamChatLayoutData {
  channels: TeamChannelListItemDto[];
  teamMembers: User[];
}

const TeamChatLayoutDataContext = createContext<TeamChatLayoutData | null>(
  null,
);

export function TeamChatLayoutDataProvider({
  channels,
  teamMembers,
  children,
}: {
  channels: TeamChannelListItemDto[];
  teamMembers: User[];
  children: ReactNode;
}) {
  // Plain object — identity changes on every render. That's intentional:
  // when the layout re-renders (rare; only on hard navigation back into
  // /team), consumers see the fresh snapshot. Channel switches don't
  // re-render the layout, so consumers see the same identity across
  // child route changes.
  return (
    <TeamChatLayoutDataContext.Provider value={{ channels, teamMembers }}>
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
