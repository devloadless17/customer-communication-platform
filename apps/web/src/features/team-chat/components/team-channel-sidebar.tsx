"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import dynamic from "next/dynamic";

import { usePresence } from "@/hooks/use-presence";
import { useIsMobileSubSidebar } from "@/components/layouts/sub-sidebar";
import {
  useTeamChannels,
  useTeamDms,
  useTeamMembers,
} from "@/features/team-chat/contexts/team-chat-data";
import type { User } from "@ccp/shared/types";

import { ChannelList } from "./channel-list";
import { NewChannelDialog } from "./channel-dialogs";
import { DmList } from "./dm-list";
import { markDmOpenedLocally } from "@/providers/team-chat-notifications";

// Workspace-wide message search — heavy (its own debounced fetcher + result
// chrome) and only opened on demand, so keep it out of the initial bundle.
const WorkspaceSearchDialog = dynamic(
  () => import("./workspace-search-dialog").then((m) => m.WorkspaceSearchDialog),
  { ssr: false },
);

// Same reasoning: both are on-demand dialogs with their own fetchers.
const BrowseChannelsDialog = dynamic(
  () => import("./browse-channels-dialog").then((m) => m.BrowseChannelsDialog),
  { ssr: false },
);
const NewDmDialog = dynamic(
  () => import("./new-dm-dialog").then((m) => m.NewDmDialog),
  { ssr: false },
);

/** `/team/<channelId>` → `<channelId>`; `/team` → null. */
function channelIdFromPathname(pathname: string | null): string | null {
  if (!pathname) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "team") return null;
  return segments[1] ?? null;
}

/**
 * Channel-list sidebar, mounted at the /team LAYOUT level (via SectionShell)
 * so it paints instantly on a rail click and stays put across channel switches
 * AND the `/team → /team/[default]` redirect — only the feed (the page) streams
 * in behind `loading.tsx`. Previously the list lived inside the workspace (the
 * page island), so the whole region blocked on navigation.
 *
 * Self-sufficient: live channels come from the layout-level context (one shared
 * subscription), the active channel is derived from the pathname, presence is
 * owned here, and it carries its own New-channel + Workspace-search dialogs
 * (the only two the list triggers). Edit / members / delete stay on the
 * channel header in the workspace.
 */
export function TeamChannelSidebar({ currentUser }: { currentUser: User }) {
  const router = useRouter();
  const mobile = useIsMobileSubSidebar();
  const channels = useTeamChannels();
  const dms = useTeamDms();
  const teamMembers = useTeamMembers();
  const activeChannelId = channelIdFromPathname(usePathname());
  const { onlineUserIds, availabilityByUserId } = usePresence(
    currentUser.teamId,
    currentUser.id,
  );

  const [showNew, setShowNew] = useState(false);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);

  return (
    <>
      {/* Desktop: fixed column hidden below md (mobile uses the hamburger
          drawer copy of this same component, where `mobile` is true). */}
      <div className={mobile ? "flex h-full w-full" : "hidden h-svh md:flex"}>
        <ChannelList
          channels={channels}
          activeChannelId={activeChannelId ?? ""}
          onlinePresenceCount={onlineUserIds.size}
          onCreate={() => setShowNew(true)}
          onOpenWorkspaceSearch={() => setWorkspaceSearchOpen(true)}
          onBrowse={() => setBrowseOpen(true)}
          dmSection={
            <DmList
              dms={dms}
              activeChannelId={activeChannelId ?? ""}
              onlineUserIds={onlineUserIds}
              availabilityByUserId={availabilityByUserId}
              onStartDm={() => setNewDmOpen(true)}
            />
          }
        />
      </div>

      {showNew && (
        <NewChannelDialog
          currentRole={currentUser.role}
          onClose={() => setShowNew(false)}
          onCreated={(ch) => {
            setShowNew(false);
            router.push(`/team/${ch.id}`);
          }}
        />
      )}
      {browseOpen && <BrowseChannelsDialog onClose={() => setBrowseOpen(false)} />}
      {newDmOpen && (
        <NewDmDialog
          teamMembers={teamMembers}
          currentUserId={currentUser.id}
          onlineUserIds={onlineUserIds}
          onClose={() => setNewDmOpen(false)}
          onOpened={(ch) => {
            setNewDmOpen(false);
            // Suppress the `team:dm:created` self-toast — that frame reaches
            // BOTH participants and carries no author to filter on.
            markDmOpenedLocally(ch.id);
            router.push(`/team/${ch.id}`);
            // The DM may be brand-new; refresh so the layout's server-side DM
            // list includes it even if the socket frame is missed.
            router.refresh();
          }}
        />
      )}
      <WorkspaceSearchDialog
        open={workspaceSearchOpen}
        onClose={() => setWorkspaceSearchOpen(false)}
      />
    </>
  );
}
