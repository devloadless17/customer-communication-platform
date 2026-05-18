"use client";

import { usePathname } from "next/navigation";
import {
  FileText,
  Megaphone,
  MessageSquareText,
  ShieldCheck,
  Users2,
  Workflow as WorkflowIcon,
} from "lucide-react";

import type { TeamChannelListItemDto } from "@ccp/shared/team-chat/types";

import {
  SubSidebar,
  SubSidebarItem,
  SubSidebarSection,
} from "./sub-sidebar";

/**
 * Section sub-sidebars without their own dedicated file. Each is small
 * (just a few nav items) — keeping them colocated avoids spawning a file
 * per section. Inbox / Contacts / Settings get their own files because
 * they own more state.
 */

export function BroadcastsSubSidebar() {
  const pathname = usePathname() ?? "";
  const isActive = (href: string) => {
    if (href === "/broadcasts") {
      // /broadcasts/groups should NOT highlight the parent — it has its own row.
      // /templates is a separate route entirely.
      return pathname === "/broadcasts" || /^\/broadcasts\/(?!groups($|\/))/.test(pathname);
    }
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <SubSidebar title="Outreach">
      <SubSidebarSection>
        <SubSidebarItem
          href="/broadcasts"
          label="Broadcasts"
          leading={<Megaphone className="size-4" />}
          active={isActive("/broadcasts")}
        />
        <SubSidebarItem
          href="/broadcasts/groups"
          label="Audience groups"
          leading={<Users2 className="size-4" />}
          active={isActive("/broadcasts/groups")}
        />
        <SubSidebarItem
          href="/templates"
          label="Templates"
          leading={<FileText className="size-4" />}
          active={isActive("/templates")}
        />
      </SubSidebarSection>
    </SubSidebar>
  );
}

export function WorkflowsSubSidebar() {
  return (
    <SubSidebar title="Workflows" subtitle="Triggers and automations">
      <SubSidebarSection>
        <SubSidebarItem
          href="/workflows"
          label="All workflows"
          leading={<WorkflowIcon className="size-4" />}
          active
        />
      </SubSidebarSection>
    </SubSidebar>
  );
}

export function AdminSubSidebar() {
  const pathname = usePathname() ?? "";
  return (
    <SubSidebar title="Platform admin" subtitle="Super-admin only">
      <SubSidebarSection>
        <SubSidebarItem
          href="/admin"
          label="Overview"
          leading={<ShieldCheck className="size-4" />}
          active={pathname === "/admin"}
        />
        <SubSidebarItem
          href="/admin/teams"
          label="Teams"
          leading={<Users2 className="size-4" />}
          active={pathname === "/admin/teams" || pathname.startsWith("/admin/teams/")}
        />
      </SubSidebarSection>
    </SubSidebar>
  );
}

/**
 * Team chat sub-sidebar — channels list. The existing `ChannelList` inside
 * `team-chat-workspace.tsx` already renders a rich channel list with unread
 * counts; we keep that one as the canonical UI. This minimal version is
 * shown when the workspace hasn't mounted yet (loading + sub-routes without
 * a selected channel).
 */
export function TeamChatSubSidebar({
  channels,
  activeChannelId,
}: {
  channels: TeamChannelListItemDto[];
  activeChannelId?: string;
}) {
  return (
    <SubSidebar title="Team chat" subtitle={`${channels.length} channel${channels.length === 1 ? "" : "s"}`}>
      <SubSidebarSection>
        {channels.map((c) => {
          const active = c.id === activeChannelId;
          return (
            <SubSidebarItem
              key={c.id}
              href={`/team/${c.id}`}
              label={c.name}
              leading={<MessageSquareText className="size-3.5" />}
              active={active}
              trailing={
                c.unreadMentionCount > 0 ? (
                  <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground tabular-nums">
                    {c.unreadMentionCount}
                  </span>
                ) : c.unreadForMe ? (
                  <span
                    className="size-1.5 rounded-full bg-primary"
                    aria-label="Unread"
                  />
                ) : null
              }
            />
          );
        })}
      </SubSidebarSection>
    </SubSidebar>
  );
}
