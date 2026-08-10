"use client";

import type {
  ContactFieldDefinition,
  ContactStage,
  ConversationWithRefs,
  Tag,
  User,
} from "@ccp/shared/types";

import { usePresence } from "@/hooks/use-presence";
import { useInboxFilter } from "@/features/inbox/contexts/inbox-filter-context";
import { InboxSubSidebar } from "./inbox-sub-sidebar";

/**
 * Layout-level wrapper around {@link InboxSubSidebar}. Mounted by
 * `/inbox/layout.tsx` (via SectionShell) so the inbox sub-sidebar paints
 * instantly on navigation and stays put while the conversation list + thread
 * (the page island) stream in behind the inbox `loading.tsx` skeleton —
 * matching how every other section's sub-sidebar behaves.
 *
 * Self-sufficient by design: it owns presence and reads the shared filter
 * from context, so it has NO dependency on the page island. The preset/stage
 * count badges come from `useConversationCounts()` inside `InboxSubSidebar`
 * (live server truth); `initialConversations` is only the first-paint count
 * fallback shown for the ~1 RTT before that hook's first response lands.
 */
export function InboxSubSidebarLive({
  currentUser,
  stages,
  tags,
  fieldDefinitions,
  teammates,
  initialConversations,
  canManageSharedViews,
}: {
  currentUser: User;
  stages: ContactStage[];
  /** Tag catalog — the saved-view builder filters on it. */
  tags: Tag[];
  /** Contact field catalog — the saved-view builder's select-field criteria. */
  fieldDefinitions: ContactFieldDefinition[];
  teammates: User[];
  initialConversations: ConversationWithRefs[];
  /** Resolved server-side from `inboxViews:manageShared`; decides whether the
   *  builder offers the "share with the workspace" toggle. */
  canManageSharedViews: boolean;
}) {
  const { filter, setFilter } = useInboxFilter();
  // Drives the green/grey presence dots next to each teammate, and keeps this
  // user visible as online to others while they sit in the inbox (the
  // sub-sidebar is always mounted on /inbox, so the join persists).
  const { onlineUserIds, availabilityByUserId, availabilitySeeded } = usePresence(
    currentUser.workspaceId,
    currentUser.id,
  );

  return (
    <InboxSubSidebar
      currentUser={currentUser}
      conversations={initialConversations}
      stages={stages}
      tags={tags}
      fieldDefinitions={fieldDefinitions}
      teammates={teammates}
      canManageSharedViews={canManageSharedViews}
      onlineUserIds={onlineUserIds}
      availabilityByUserId={availabilityByUserId}
      availabilitySeeded={availabilitySeeded}
      filter={filter}
      onFilterChange={setFilter}
    />
  );
}
