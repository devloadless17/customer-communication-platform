"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ContactRound,
  FileText,
  Inbox,
  LogOut,
  type LucideIcon,
  Megaphone,
  MessageSquareText,
  Settings,
  ShieldCheck,
  UserCircle2,
  Users,
  Zap,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { roleLabel } from "@/lib/auth/permissions";
import { closeClientSocket } from "@/lib/socket/client";
import { cn, initials } from "@/lib/utils";
import type { Team, User } from "@/lib/types";

/**
 * Slim, non-inbox sidebar shared by the /broadcasts and /contacts shells.
 *
 * Mirrors the look of the inbox sidebar but drops the inbox-specific filters
 * (All / Mine / Unassigned / Closed) and live conversation counts — those
 * only make sense in the inbox itself. The active nav item is highlighted
 * by URL prefix so the same component reuses across both pages.
 */

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/contacts", label: "Contacts", icon: ContactRound },
  { href: "/broadcasts", label: "Broadcasts", icon: Megaphone },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/automations", label: "Automations", icon: Zap },
];

export function WorkspaceSidebar({
  currentUser,
  team,
  teammates,
}: {
  currentUser: User;
  team: Team;
  teammates: User[];
}) {
  const pathname = usePathname() ?? "";

  // Pin the current user at the top of the teammates list so it's findable.
  const orderedTeammates = (() => {
    const me = teammates.find((u) => u.id === currentUser.id);
    const others = teammates.filter((u) => u.id !== currentUser.id);
    return me ? [me, ...others] : [currentUser, ...others];
  })();

  return (
    <aside className="flex h-svh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MessageSquareText className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight">{team.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">WhatsApp · Phase 1</div>
        </div>
      </div>

      <nav className="mt-2 flex flex-col gap-0.5 px-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          // Active = exact match OR a sub-path. /broadcasts matches both
          // /broadcasts AND /broadcasts/new, /broadcasts/<id>.
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                active
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground",
              )}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  active
                    ? "text-primary"
                    : "text-muted-foreground group-hover:text-foreground",
                )}
              />
              <span className="flex-1 text-left">{label}</span>
            </Link>
          );
        })}
        {/* Platform admin entry — only superAdmins see it. Sits below the
            regular org nav so it reads as "extra capability" rather than
            another peer-level page. */}
        {currentUser.role === "superAdmin" && (
          <Link
            href="/admin"
            className={cn(
              "group mt-1 flex h-8 items-center gap-2.5 rounded-md border border-dashed border-amber-500/30 px-2.5 text-sm transition-colors",
              "hover:bg-amber-500/10 hover:text-foreground",
              pathname === "/admin" || pathname.startsWith("/admin/")
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 font-medium"
                : "text-amber-700/80 dark:text-amber-300/80",
            )}
          >
            <ShieldCheck className="size-4 shrink-0 text-amber-500" />
            <span className="flex-1 text-left">Platform admin</span>
          </Link>
        )}
      </nav>

      <div className="mt-6 px-4 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Teammates
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        {orderedTeammates.map((u) => (
          <div
            key={u.id}
            className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground"
          >
            <Avatar className="size-5">
              <AvatarFallback className="text-[9px]">{initials(u.name)}</AvatarFallback>
            </Avatar>
            <span className="truncate">{u.name}</span>
            {u.id === currentUser.id && (
              <span className="ml-auto rounded-full bg-muted/40 px-1.5 py-0 text-[10px] text-muted-foreground">
                you
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-auto flex items-center gap-2 border-t border-sidebar-border px-3 py-3">
        <Avatar className="size-8">
          <AvatarFallback>{initials(currentUser.name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{currentUser.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{currentUser.email}</div>
        </div>
        <UserMenu currentUser={currentUser} />
      </div>
    </aside>
  );
}

function UserMenu({ currentUser }: { currentUser: User }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Open user menu"
            >
              <Settings className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="top" className="min-w-45">
        <DropdownMenuLabel>{roleLabel(currentUser.role)}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/account">
            <UserCircle2 className="size-4 text-muted-foreground" />
            Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings/team">
            <Users className="size-4 text-muted-foreground" />
            Team
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            // Drop the socket BEFORE signing out so the just-signed-out
            // user's presence dot doesn't linger on every other client.
            closeClientSocket();
            // Hard navigation to the /logout route handler — see the
            // matching comment in components/inbox/sidebar.tsx for why
            // we avoid the server-action signout path.
            window.location.assign("/logout");
          }}
        >
          <LogOut className="size-4 text-muted-foreground" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
