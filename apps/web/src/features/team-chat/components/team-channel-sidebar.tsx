"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import dynamic from "next/dynamic";

import { usePresence } from "@/hooks/use-presence";
import { useIsMobileSubSidebar } from "@/components/layouts/sub-sidebar";
import { useTeamChannels } from "@/features/team-chat/contexts/team-chat-data";
import type { User } from "@ccp/shared/types";

import { ChannelList } from "./channel-list";
import { NewChannelDialog } from "./channel-dialogs";

// Workspace-wide message search — heavy (its own debounced fetcher + result
// chrome) and only opened on demand, so keep it out of the initial bundle.
const WorkspaceSearchDialog = dynamic(
  () => import("./workspace-search-dialog").then((m) => m.WorkspaceSearchDialog),
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
  const activeChannelId = channelIdFromPathname(usePathname());
  const { onlineUserIds } = usePresence(currentUser.teamId, currentUser.id);

  const [showNew, setShowNew] = useState(false);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);

  return (
    <>
      {/* Desktop: fixed column hidden below md (mobile uses the hamburger
          drawer copy of this same component, where `mobile` is true). */}
      <div className={mobile ? "flex h-full w-full" : "hidden h-svh md:flex"}>
        <ChannelList
          channels={channels}
          activeChannelId={activeChannelId ?? ""}
          currentRole={currentUser.role}
          onlinePresenceCount={onlineUserIds.size}
          onCreate={() => setShowNew(true)}
          onOpenWorkspaceSearch={() => setWorkspaceSearchOpen(true)}
        />
      </div>

      {showNew && (
        <NewChannelDialog
          onClose={() => setShowNew(false)}
          onCreated={(ch) => {
            setShowNew(false);
            router.push(`/team/${ch.id}`);
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
