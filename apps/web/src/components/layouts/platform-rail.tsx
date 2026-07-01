"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { roleLabel } from "@ccp/shared/auth/permissions";
import { cn, initials } from "@ccp/shared/utils";
import type { Role } from "@ccp/shared/types";

/**
 * Dedicated navigation rail for the platform (super-admin) shell. Deliberately
 * NOT the customer {@link AppRail} — there's no inbox, contacts, broadcasts, or
 * workflows here. This surface is platform management only: org approvals and
 * analytics. A super-admin never sees the chatting UI.
 *
 * Desktop: fixed left column. Mobile: a top bar with the same links inline.
 */
interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
}

const NAV: NavItem[] = [
  {
    href: "/platform",
    label: "Overview",
    icon: LayoutDashboard,
    isActive: (p) => p === "/platform",
  },
  {
    href: "/platform/organizations",
    label: "Organizations",
    icon: Building2,
    isActive: (p) =>
      p === "/platform/organizations" || p.startsWith("/platform/organizations/"),
  },
];

export function PlatformRail({
  user,
}: {
  user: { name: string; email: string; role: Role; avatarUrl?: string | null };
}) {
  const pathname = usePathname() ?? "";

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-sidebar-border bg-sidebar/40 text-sidebar-foreground md:h-svh md:w-60 md:border-b-0 md:border-r">
      <header className="flex items-center gap-2.5 px-4 py-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ShieldCheck className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight">Platform</div>
          <div className="truncate text-2xs text-muted-foreground">Super admin</div>
        </div>
        {/* Mobile sign-out: below md the rail is a top bar and the desktop
            footer (with avatar + sign-out) is hidden, so a superadmin on a
            phone would otherwise have no way to sign out. Surface it here. */}
        <a
          href="/logout"
          aria-label="Sign out"
          className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
        >
          <LogOut className="size-4" />
        </a>
      </header>

      <nav aria-label="Platform navigation" className="flex gap-1 px-3 pb-3 md:flex-col md:pb-0">
        {NAV.map((item) => {
          const active = item.isActive(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-md px-3 text-sm transition-colors",
                active
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon
                className={cn("size-4 shrink-0", active ? "text-primary" : undefined)}
              />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto hidden items-center gap-2.5 border-t border-sidebar-border px-3 py-3 md:flex">
        <Avatar className="size-8 shrink-0">
          {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={user.name} /> : null}
          <AvatarFallback seed={user.email} className="text-3xs">
            {initials(user.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{user.name}</div>
          <div className="truncate text-2xs text-muted-foreground">
            {roleLabel(user.role)}
          </div>
        </div>
        {/* Full-page nav to /logout (a route handler that clears the session
            cookie — a client fetch can't). Matches the /pending sign-out. */}
        <a
          href="/logout"
          aria-label="Sign out"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9"
        >
          <LogOut className="size-4" />
        </a>
      </div>
    </aside>
  );
}
