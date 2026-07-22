"use client";

import { usePathname } from "next/navigation";
import { Bell, UserCircle2 } from "lucide-react";

import { SubSidebar, SubSidebarItem, SubSidebarSection } from "@/components/layouts/sub-sidebar";

/** Nav for Personal settings. Ungated by design — everyone manages their own. */
export function AccountSubSidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href;

  return (
    <SubSidebar title="Personal settings">
      <SubSidebarSection label="You">
        <SubSidebarItem
          href="/account"
          label="Profile & password"
          leading={<UserCircle2 className="size-4" />}
          active={isActive("/account")}
        />
        <SubSidebarItem
          href="/account/notifications"
          label="Notifications"
          leading={<Bell className="size-4" />}
          active={isActive("/account/notifications")}
        />
      </SubSidebarSection>
    </SubSidebar>
  );
}
