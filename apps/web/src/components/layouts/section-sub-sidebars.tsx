"use client";

import { usePathname } from "next/navigation";
import {
  FileText,
  Megaphone,
  ShieldCheck,
  Users2,
  Workflow as WorkflowIcon,
} from "lucide-react";

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
          label="Organizations"
          leading={<ShieldCheck className="size-4" />}
          active={pathname === "/admin" || pathname.startsWith("/admin/teams/")}
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
