"use client";

import { useEffect, useMemo, useState } from "react";
import { useSelectedLayoutSegment } from "next/navigation";

import type { ConversationWithRefs, Team, User } from "@/lib/types";
import { useTeamEvents } from "@/hooks/use-team-events";
import { useSocketStatus } from "@/hooks/use-socket-status";
import { usePresence } from "@/hooks/use-presence";

import { Sidebar, type FilterId } from "./sidebar";
import { ConversationList } from "./conversation-list";
import { DevTools } from "./dev-tools";

/**
 * Holds inbox-shell client state (filter + search) and live conversation
 * state via Socket.io. The server layout seeds the initial list; events
 * keep it in sync without refetching.
 */
export function InboxShell({
  currentUser,
  team,
  teammates,
  conversations: initialConversations,
  nextConversationCursor,
  children,
}: {
  currentUser: User;
  team: Team;
  teammates: User[];
  conversations: ConversationWithRefs[];
  nextConversationCursor: string | null;
  children: React.ReactNode;
}) {
  const [filter, setFilter] = useState<FilterId>("all");
  const [search, setSearch] = useState("");

  // The active thread comes from the route segment (/inbox/[conversationId]).
  // Threading it into useTeamEvents lets us suppress the unread-bump for the
  // conversation the user is literally reading.
  const activeConversationId = useSelectedLayoutSegment();
  const { conversations, hasMore, loadingMore, loadMore } = useTeamEvents(
    team.id,
    initialConversations,
    nextConversationCursor,
    activeConversationId,
  );

  const { connected } = useSocketStatus();
  const { onlineUserIds } = usePresence(team.id, currentUser.id);

  // Tab title gets a leading "(N)" while there's unread, so the user notices
  // a new message even when the window is unfocused. Excludes closed threads
  // because they shouldn't pull attention.
  const totalUnread = useMemo(() => {
    return conversations.reduce(
      (acc, c) =>
        acc +
        (c.conversation.status === "closed" ? 0 : c.conversation.unreadCount),
      0,
    );
  }, [conversations]);

  useEffect(() => {
    const base = "Inbox · " + team.name;
    document.title = totalUnread > 0 ? `(${totalUnread}) ${base}` : base;
  }, [totalUnread, team.name]);

  return (
    <div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
      <Sidebar
        currentUser={currentUser}
        team={team}
        teammates={teammates}
        conversations={conversations}
        filter={filter}
        onFilterChange={setFilter}
        connected={connected}
        onlineUserIds={onlineUserIds}
      />
      <div className="flex min-w-0 flex-1">
        <ConversationList
          currentUser={currentUser}
          conversations={conversations}
          filter={filter}
          search={search}
          onSearchChange={setSearch}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
        />
        <main className="flex min-w-0 flex-1 border-l border-border bg-background">
          {children}
        </main>
      </div>
      <DevTools conversations={conversations} currentUser={currentUser} />
    </div>
  );
}
