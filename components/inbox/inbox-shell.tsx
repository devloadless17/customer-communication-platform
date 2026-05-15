"use client";

import { useEffect, useMemo, useState } from "react";
import { useSelectedLayoutSegment } from "next/navigation";

import type {
  ContactStage,
  ConversationWithRefs,
  SnippetItem,
  Team,
  User,
} from "@/lib/types";
import { useTeamEvents } from "@/hooks/use-team-events";
import { useSocketStatus } from "@/hooks/use-socket-status";
import { usePresence } from "@/hooks/use-presence";
import { useCatalogSync } from "@/hooks/use-catalog-sync";
import { useConversationSearch } from "@/hooks/use-conversation-search";

import { AppSidebar } from "@/components/layouts/app-sidebar";
import { ConnectionBanner } from "./connection-banner";
import { ConversationList } from "./conversation-list";
import { DevTools } from "./dev-tools";
import { InboxControls, type Filter } from "./inbox-controls";
import { SnippetsProvider } from "./snippets-context";

/**
 * Holds inbox-shell client state (filter + search) and live conversation
 * state via Socket.io. The server layout seeds the initial list; events
 * keep it in sync without refetching.
 *
 * Renders the same `AppSidebar` every other area uses, then injects the
 * inbox-only filter buttons + stages section into its `inboxControls` slot
 * so they appear nested under "Inbox" without breaking sidebar consistency.
 */
export function InboxShell({
  currentUser,
  team,
  teammates,
  conversations: initialConversations,
  nextConversationCursor,
  snippets,
  stages,
  children,
}: {
  currentUser: User;
  team: Team;
  teammates: User[];
  conversations: ConversationWithRefs[];
  nextConversationCursor: string | null;
  snippets: SnippetItem[];
  stages: ContactStage[];
  children: React.ReactNode;
}) {
  const [filter, setFilter] = useState<Filter>({ kind: "preset", id: "all" });
  const [search, setSearch] = useState("");

  // The active thread comes from the route segment (/inbox/[conversationId]).
  // Threading it into useTeamEvents lets us suppress the unread-bump for the
  // conversation the user is literally reading.
  const activeConversationId = useSelectedLayoutSegment();
  const live = useTeamEvents(
    team.id,
    initialConversations,
    nextConversationCursor,
    activeConversationId,
  );

  // When search is non-empty, the conversation list switches to server-side
  // matches so contacts buried below the loaded slice are findable. The live
  // list keeps updating in the background; clearing search restores it.
  const searchState = useConversationSearch(search);

  const conversationList = searchState.active ? searchState.results : live.conversations;
  const hasMore = searchState.active
    ? searchState.nextCursor !== null
    : live.hasMore;
  const loadingMore = searchState.active ? searchState.loadingMore : live.loadingMore;
  const loadMore = searchState.active ? searchState.loadMore : live.loadMore;

  const { connected } = useSocketStatus();
  const { onlineUserIds } = usePresence(team.id, currentUser.id);
  // Re-run server components on any teammate-driven catalog mutation
  // (stages / tags / contact fields / automations / members). One global
  // listener covers the inbox layout's stage filter, the panel's tag /
  // field rows, etc. — no per-component plumbing.
  useCatalogSync();

  // Tab title gets a leading "(N)" while there's unread, so the user notices
  // a new message even when the window is unfocused. Excludes closed threads
  // because they shouldn't pull attention. Always reads from the live list —
  // a partial search result shouldn't change the total.
  const totalUnread = useMemo(() => {
    return live.conversations.reduce(
      (acc, c) =>
        acc +
        (c.conversation.status === "closed" ? 0 : c.conversation.unreadCount),
      0,
    );
  }, [live.conversations]);

  useEffect(() => {
    const base = "Inbox · " + team.name;
    document.title = totalUnread > 0 ? `(${totalUnread}) ${base}` : base;
  }, [totalUnread, team.name]);

  return (
    <SnippetsProvider snippets={snippets}>
      <div className="relative flex h-svh w-full overflow-hidden bg-background text-foreground">
        <ConnectionBanner />
        <AppSidebar
          currentUser={currentUser}
          team={team}
          teammates={teammates}
          connected={connected}
          onlineUserIds={onlineUserIds}
          inboxControls={
            <InboxControls
              currentUser={currentUser}
              conversations={live.conversations}
              stages={stages}
              filter={filter}
              onFilterChange={setFilter}
            />
          }
        />
        <div className="flex min-w-0 flex-1">
          <ConversationList
            currentUser={currentUser}
            conversations={conversationList}
            stages={stages}
            filter={filter}
            search={search}
            onSearchChange={setSearch}
            searching={searchState.active && searchState.loading}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
          />
          <main className="flex min-w-0 flex-1 border-l border-border bg-background">
            {children}
          </main>
        </div>
        <DevTools conversations={live.conversations} currentUser={currentUser} />
      </div>
    </SnippetsProvider>
  );
}
