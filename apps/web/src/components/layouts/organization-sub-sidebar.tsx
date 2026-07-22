"use client";

import { usePathname } from "next/navigation";
import { Building2, LayoutGrid, Users } from "lucide-react";

import { SubSidebar, SubSidebarItem, SubSidebarSection } from "@/components/layouts/sub-sidebar";

/**
 * Nav for the Organization section.
 *
 * Deliberately SHORT. A "Billing" group and a "Security" entry would match the
 * shape of comparable products, but neither exists in this platform yet — and a
 * nav link to a page that can't do anything is worse than an absent one. They
 * get added the day the feature does.
 */
export function OrganizationSubSidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href;

  return (
    <SubSidebar title="Organization settings">
      <SubSidebarSection label="Account">
        <SubSidebarItem
          href="/organization"
          label="Account info"
          leading={<Building2 className="size-4" />}
          active={isActive("/organization")}
        />
        <SubSidebarItem
          href="/organization/members"
          label="Admin settings"
          leading={<Users className="size-4" />}
          active={isActive("/organization/members")}
        />
        <SubSidebarItem
          href="/organization/workspaces"
          label="Workspaces"
          leading={<LayoutGrid className="size-4" />}
          active={isActive("/organization/workspaces")}
        />
      </SubSidebarSection>
    </SubSidebar>
  );
}
