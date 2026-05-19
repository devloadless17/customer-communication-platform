"use client";

import { usePathname } from "next/navigation";
import {
  KeyRound,
  Layers,
  ListChecks,
  MessageSquare,
  Plug,
  Sparkles,
  Tag as TagIcon,
  UserCircle2,
  Users,
} from "lucide-react";

import {
  canManageContactFields,
  canManageStages,
  canManageUsers,
} from "@ccp/shared/auth/permissions";
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
export function SettingsSubSidebar({ role }: { role: Role }) {
  const pathname = usePathname() ?? "";
  const isAdmin = canManageUsers(role);
  const canStages = canManageStages(role);
  const canFields = canManageContactFields(role);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  return (
    <SubSidebar title="Workspace settings">
      <SubSidebarSection label="User role settings">
        <SubSidebarItem
          href="/settings/workspace"
          label="User settings"
          leading={<UserCircle2 className="size-4" />}
          active={isActive("/settings/workspace") || isActive("/settings/account")}
        />
        <SubSidebarItem
          href="/settings/team"
          label="Team settings"
          leading={<Users className="size-4" />}
          active={isActive("/settings/team")}
        />
      </SubSidebarSection>

      {isAdmin && (
        <SubSidebarSection label="Apps">
          <SubSidebarItem
            href="/settings/whatsapp"
            label="Channels"
            leading={<MessageSquare className="size-4" />}
            active={isActive("/settings/whatsapp")}
          />
          <SubSidebarItem
            href="/settings/integrations"
            label="Integrations"
            leading={<Plug className="size-4" />}
            active={isActive("/settings/integrations")}
          />
          <SubSidebarItem
            href="/settings/api-keys"
            label="API keys"
            leading={<KeyRound className="size-4" />}
            active={isActive("/settings/api-keys")}
          />
        </SubSidebarSection>
      )}

      <SubSidebarSection label="Inbox settings">
        {canStages && (
          <SubSidebarItem
            href="/settings/stages"
            label="Lifecycle"
            leading={<Layers className="size-4" />}
            active={isActive("/settings/stages")}
          />
        )}
        <SubSidebarItem
          href="/settings/snippets"
          label="Snippets"
          leading={<Sparkles className="size-4" />}
          active={isActive("/settings/snippets")}
        />
        <SubSidebarItem
          href="/settings/tags"
          label="Tags"
          leading={<TagIcon className="size-4" />}
          active={isActive("/settings/tags")}
        />
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
