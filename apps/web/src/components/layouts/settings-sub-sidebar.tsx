"use client";

import { usePathname } from "next/navigation";
import {
  Bell,
  Layers,
  ListChecks,
  MessageSquare,
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
    // One noun per page: each sidebar label matches the destination page's own
    // h1 so "open Team" / "open Stages" resolve unambiguously. The sidebar
    // title is the generic section name, not a page name.
    <SubSidebar title="Settings">
      <SubSidebarSection label="User role settings">
        <SubSidebarItem
          href="/settings/workspace"
          label="Account"
          leading={<UserCircle2 className="size-4" />}
          active={isActive("/settings/workspace") || isActive("/settings/account")}
        />
        <SubSidebarItem
          href="/settings/team"
          label="Team"
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
      </SubSidebarSection>

      {isAdmin && (
        <SubSidebarSection label="Apps">
          <SubSidebarItem
            href="/settings/whatsapp"
            label="WhatsApp"
            leading={<MessageSquare className="size-4" />}
            active={isActive("/settings/whatsapp")}
          />
          <SubSidebarItem
            href="/settings/integrations"
            label="Integrations"
            leading={<Plug className="size-4" />}
            active={isActive("/settings/integrations")}
          />
        </SubSidebarSection>
      )}

      <SubSidebarSection label="Inbox settings">
        {canStages && (
          <SubSidebarItem
            href="/settings/stages"
            label="Stages"
            leading={<Layers className="size-4" />}
            active={isActive("/settings/stages")}
          />
        )}
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
        {canFields && (
          <SubSidebarItem
            href="/settings/contact-fields"
            label="Contact fields"
            leading={<ListChecks className="size-4" />}
            active={isActive("/settings/contact-fields")}
          />
        )}
        {/* Notification sounds — personal + per-device, so NO capability gate
            (everyone manages their own). Moved here from the AppRail user
            menu. */}
        <SubSidebarItem
          href="/settings/notifications"
          label="Notifications"
          leading={<Bell className="size-4" />}
          active={isActive("/settings/notifications")}
        />
      </SubSidebarSection>
    </SubSidebar>
  );
}
