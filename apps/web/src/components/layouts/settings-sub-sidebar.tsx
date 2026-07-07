"use client";

import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bell,
  Camera,
  Layers,
  ListChecks,
  MessageSquare,
  MessagesSquare,
  Plug,
  ShieldCheck,
  Sparkles,
  Tag as TagIcon,
  UserCircle2,
  Users,
} from "lucide-react";

import { canManageUsers } from "@ccp/shared/auth/permissions";
import type { Capability } from "@ccp/shared/auth/permissions";
import type { Role } from "@ccp/shared/types";

import {
  SubSidebar,
  SubSidebarItem,
  SubSidebarSection,
} from "./sub-sidebar";

/**
 * Settings sub-sidebar — grouped nav for the workspace settings area.
 *
 * Sections mirror the product spec (General / User role / Apps / Inbox
 * settings / Data settings). Items that don't have a page today are
 * intentionally omitted; admin-only links are gated per `role`.
 */
export function SettingsSubSidebar({
  role,
  permissions,
}: {
  role: Role;
  permissions: Record<Capability, boolean>;
}) {
  const pathname = usePathname() ?? "";
  const isAdmin = canManageUsers(role);
  const canStages = permissions["stages:manage"];
  const canFields = permissions["contactFields:manage"];
  const canSnippets = permissions["snippets:manage"];
  const canTags = permissions["tags:manage"];

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  return (
    // Groups mirror the single /settings landing exactly: My account / Team &
    // roles / Channels & integrations / Conversation config. Each label matches
    // the destination page's own h1 so "open Stages" resolves unambiguously.
    <SubSidebar title="Settings">
      <SubSidebarSection label="My account">
        <SubSidebarItem
          href="/settings/account"
          label="Account"
          leading={<UserCircle2 className="size-4" />}
          // /settings/workspace is the legacy account landing (now redirects
          // to /settings) — keep it lit so the redirect hop still highlights.
          active={isActive("/settings/account") || isActive("/settings/workspace")}
        />
        {/* Notification sounds — personal + per-device, so NO capability gate
            (everyone manages their own). */}
        <SubSidebarItem
          href="/settings/notifications"
          label="Notifications"
          leading={<Bell className="size-4" />}
          active={isActive("/settings/notifications")}
        />
      </SubSidebarSection>

      <SubSidebarSection label="Team & roles">
        <SubSidebarItem
          href="/settings/team"
          label="Team members"
          leading={<Users className="size-4" />}
          active={isActive("/settings/team")}
        />
        {isAdmin && (
          <SubSidebarItem
            href="/settings/permissions"
            label="Role permissions"
            leading={<ShieldCheck className="size-4" />}
            active={isActive("/settings/permissions")}
          />
        )}
        {permissions["teamActivity:view"] && (
          <SubSidebarItem
            href="/settings/activity"
            label="Team activity"
            leading={<BarChart3 className="size-4" />}
            active={isActive("/settings/activity")}
          />
        )}
      </SubSidebarSection>

      {isAdmin && (
        <SubSidebarSection label="Channels & integrations">
          <SubSidebarItem
            href="/settings/whatsapp"
            label="WhatsApp"
            leading={<MessageSquare className="size-4" />}
            active={isActive("/settings/whatsapp")}
          />
          <SubSidebarItem
            href="/settings/messenger"
            label="Messenger"
            leading={<MessagesSquare className="size-4" />}
            active={isActive("/settings/messenger")}
          />
          <SubSidebarItem
            href="/settings/instagram"
            label="Instagram"
            leading={<Camera className="size-4" />}
            active={isActive("/settings/instagram")}
          />
          <SubSidebarItem
            href="/settings/integrations"
            label="Integrations"
            leading={<Plug className="size-4" />}
            active={isActive("/settings/integrations")}
          />
        </SubSidebarSection>
      )}

      <SubSidebarSection label="Conversation config">
        {canSnippets && (
          <SubSidebarItem
            href="/settings/snippets"
            label="Snippets"
            leading={<Sparkles className="size-4" />}
            active={isActive("/settings/snippets")}
          />
        )}
        {canTags && (
          <SubSidebarItem
            href="/settings/tags"
            label="Tags"
            leading={<TagIcon className="size-4" />}
            active={isActive("/settings/tags")}
          />
        )}
        {canStages && (
          <SubSidebarItem
            href="/settings/stages"
            label="Stages"
            leading={<Layers className="size-4" />}
            active={isActive("/settings/stages")}
          />
        )}
        {canFields && (
          <SubSidebarItem
            href="/settings/contact-fields"
            label="Contact fields"
            leading={<ListChecks className="size-4" />}
            active={isActive("/settings/contact-fields")}
          />
        )}
      </SubSidebarSection>
    </SubSidebar>
  );
}
