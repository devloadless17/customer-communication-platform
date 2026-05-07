"use client";

import { useState } from "react";

import type { ConversationWithRefs, Team, User } from "@/lib/types";
import { useTeamEvents } from "@/hooks/use-team-events";

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
  conversations: initialConversations,
  children,
}: {
  currentUser: User;
  team: Team;
  conversations: ConversationWithRefs[];
  children: React.ReactNode;
}) {
  const [filter, setFilter] = useState<FilterId>("all");
  const [search, setSearch] = useState("");
  const conversations = useTeamEvents(team.id, initialConversations);

  return (
    <div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
      <Sidebar
        currentUser={currentUser}
        team={team}
        conversations={conversations}
        filter={filter}
        onFilterChange={setFilter}
      />
      <div className="flex min-w-0 flex-1">
        <ConversationList
          currentUser={currentUser}
          conversations={conversations}
          filter={filter}
          search={search}
          onSearchChange={setSearch}
        />
        <main className="flex min-w-0 flex-1 border-l border-border bg-background">
          {children}
        </main>
      </div>
      <DevTools conversations={conversations} currentUser={currentUser} />
    </div>
  );
}
