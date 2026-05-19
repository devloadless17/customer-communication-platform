"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ContactRound,
  Inbox,
  LogOut,
  type LucideIcon,
  Megaphone,
  MessageSquareText,
  Menu,
  Settings as SettingsIcon,
  ShieldCheck,
  UserCircle2,
  Workflow,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Sheet } from "@/components/ui/sheet";
import { MobileSubSidebarProvider } from "@/components/layouts/sub-sidebar";
import { useSignOutOverlay } from "@/components/auth/signout-overlay";
import { roleLabel } from "@ccp/shared/auth/permissions";
import { cn, initials } from "@ccp/shared/utils";
import type { Team, User } from "@ccp/shared/types";

/**
 * Mobile chrome shared by every authenticated section. On desktop (md+)
 * the AppRail and SubSidebar live as fixed columns and this whole tree
 * is `hidden`. Below md, the columns disappear and this renders:
 *
 *   - A sticky top bar with a hamburger trigger + section title.
 *   - A left-slide Sheet containing the primary section nav AND the
 *     section's contextual sub-sidebar (passed in via `subSidebar`).
 *
 * Section title is derived from the pathname so we don't have to thread
 * it from every layout. The trigger lives inside the same component so
 * we don't need a context to wire the button → drawer state.
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: string[];
}

const PRIMARY_ITEMS: NavItem[] = [
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/team", label: "Team chat", icon: MessageSquareText },
  { href: "/contacts", label: "Contacts", icon: ContactRound },
  {
    href: "/broadcasts",
    label: "Broadcasts",
    icon: Megaphone,
    match: ["/templates", "/broadcasts/groups"],
  },
  { href: "/workflows", label: "Workflows", icon: Workflow },
];

function sectionTitle(pathname: string): string {
  if (pathname.startsWith("/inbox")) return "Inbox";
  if (pathname.startsWith("/team")) return "Team chat";
  if (pathname.startsWith("/contacts")) return "Contacts";
  if (pathname.startsWith("/broadcasts")) return "Broadcasts";
  if (pathname.startsWith("/templates")) return "Templates";
  if (pathname.startsWith("/workflows")) return "Workflows";
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/admin")) return "Platform admin";
  return "";
}

export function MobileShellChrome({
  currentUser,
  team,
  subSidebar,
  /** Override the auto-derived section title (rare). */
  title,
  /** Extra slot rendered at the right of the mobile header (filter button, etc). */
  rightSlot,
}: {
  currentUser: User;
  team: Team;
  subSidebar?: ReactNode;
  title?: string;
  rightSlot?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? "";
  // Same signout overlay used by the desktop AppRail — masks the blank
  // window between the /logout hard nav and /login painting.
  const { trigger: signOut, overlay: signOutOverlay } = useSignOutOverlay();

  // Close the drawer when the route changes — without this, navigating
  // via a drawer link leaves it open over the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const items = useMemo<NavItem[]>(() => {
    const out = [...PRIMARY_ITEMS];
    out.push({
      href: "/settings",
      label: "Settings",
      icon: SettingsIcon,
      match: ["/settings", "/settings/workspace"],
    });
    if (currentUser.role === "superAdmin") {
      out.push({ href: "/admin", label: "Platform admin", icon: ShieldCheck });
    }
    return out;
  }, [currentUser.role]);

  const resolvedTitle = title ?? sectionTitle(pathname);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-background/95 px-2 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          className="inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Menu className="size-5" />
        </button>
        <h1 className="truncate text-sm font-semibold">{resolvedTitle}</h1>
        <div className="ml-auto flex items-center gap-1">{rightSlot}</div>
      </header>

      <Sheet
        open={open}
        onOpenChange={setOpen}
        side="left"
        contentClassName="w-[280px] max-w-[85vw]"
        hideCloseButton
      >
        <div className="flex h-full flex-col">
          {/* Team header */}
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <span className="text-sm font-semibold">
                {team.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{team.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {currentUser.name} · {roleLabel(currentUser.role)}
              </div>
            </div>
          </div>

          {/* Primary nav */}
          <nav className="flex flex-col gap-0.5 px-2 py-2">
            {items.map((item) => (
              <MobileNavLink
                key={item.href}
                item={item}
                pathname={pathname}
              />
            ))}
          </nav>

          {/* Optional sub-sidebar content (filters, channel list, etc.).
              The provider tells the inner SubSidebar shell to render in
              drawer mode (full-width, no h-svh). */}
          {subSidebar && (
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
              <MobileSubSidebarProvider>{subSidebar}</MobileSubSidebarProvider>
            </div>
          )}

          {/* Footer */}
          <div className="mt-auto border-t border-border p-2">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Avatar className="size-7">
                <AvatarFallback className="text-[10px]">
                  {initials(currentUser.name)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                <div className="truncate text-foreground">{currentUser.name}</div>
                <div className="truncate">{currentUser.email}</div>
              </div>
            </div>
            <div className="mt-1 flex flex-col gap-0.5">
              <Link
                href="/settings/account"
                className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <UserCircle2 className="size-4" />
                Account
              </Link>
              <button
                type="button"
                onClick={signOut}
                className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <LogOut className="size-4" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </Sheet>
      {signOutOverlay}
    </>
  );
}

function MobileNavLink({
  item,
  pathname,
}: {
  item: NavItem;
  pathname: string;
}) {
  const matchAll = [item.href, ...(item.match ?? [])];
  const active = matchAll.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
      <span className="flex-1 truncate">{item.label}</span>
    </Link>
  );
}
