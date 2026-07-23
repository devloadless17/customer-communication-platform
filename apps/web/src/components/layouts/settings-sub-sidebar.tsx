"use client";

import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bot,
  Flag,
  Layers,
  ListChecks,
  Ticket as TicketIcon,
  Share2,
  MessagesSquare,
  Plug,
  ShieldCheck,
  Sparkles,
  Tag as TagIcon,
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
  const canMessageFlags = permissions["messageFlags:manage"];
  const canAiAssistant = permissions["aiAssistant:manage"];

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  return (
    // Groups mirror the single /settings landing exactly: My account / Team &
    // Groups mirror the tenancy model: everything here configures THIS
    // workspace. Personal settings moved to /account and company-level settings
    // to /organization, so this sidebar no longer mixes three different scopes
    // under one heading. Each label matches its page's own h1 so "open Stages"
    // resolves unambiguously.
    <SubSidebar title="Workspace settings">
      <SubSidebarSection label="People & teams">
        <SubSidebarItem
          href="/settings/team"
          label="Members"
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
        {isAdmin && (
          <SubSidebarItem
            href="/settings/assignment"
            label="Teams & routing"
            leading={<Share2 className="size-4" />}
            active={isActive("/settings/assignment")}
          />
        )}
        {permissions["teamActivity:view"] && (
          <SubSidebarItem
            href="/settings/activity"
            label="Activity"
            leading={<BarChart3 className="size-4" />}
            active={isActive("/settings/activity")}
          />
        )}
      </SubSidebarSection>

      {isAdmin && (
        <SubSidebarSection label="Channels & apps">
          <SubSidebarItem
            href="/settings/channels"
            label="Channels"
            leading={<MessagesSquare className="size-4" />}
            // Lit for the catalog and every channel connect sub-page it links to.
            active={
              isActive("/settings/channels") ||
              isActive("/settings/meta") ||
              isActive("/settings/whatsapp") ||
              isActive("/settings/messenger") ||
              isActive("/settings/instagram")
            }
          />
          <SubSidebarItem
            href="/settings/integrations"
            label="Integrations"
            leading={<Plug className="size-4" />}
            active={isActive("/settings/integrations")}
          />
        </SubSidebarSection>
      )}

      <SubSidebarSection label="Inbox">
        {canAiAssistant && (
          <SubSidebarItem
            href="/settings/ai-assistant"
            label="AI Assistant"
            leading={<Bot className="size-4" />}
            active={isActive("/settings/ai-assistant")}
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
        {canMessageFlags && (
          <SubSidebarItem
            href="/settings/message-flags"
            label="Message flags"
            leading={<Flag className="size-4" />}
            active={isActive("/settings/message-flags")}
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

      {/* Tickets are their own domain, not "conversation config": a ticket is
          the unit of WORK on a conversation, with its own lifecycle, SLA and
          board. Burying its settings under Inbox implied it was a per-message
          setting like tags. Admin-gated on the ROLE — every /api/workspace/tickets
          route is @RequireRole("admin"), so a capability gate would send a
          manager to the error boundary. */}
      {isAdmin && (
        <SubSidebarSection label="Tickets">
          <SubSidebarItem
            href="/settings/tickets"
            label="Ticket settings"
            leading={<TicketIcon className="size-4" />}
            active={isActive("/settings/tickets")}
          />
        </SubSidebarSection>
      )}
    </SubSidebar>
  );
}
