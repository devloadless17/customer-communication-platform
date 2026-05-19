"use client";

import { useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ContactRound,
  Inbox,
  LogOut,
  type LucideIcon,
  Megaphone,
  MessageSquareText,
  Settings as SettingsIcon,
  ShieldCheck,
  UserCircle2,
  Workflow,
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
import { roleLabel } from "@ccp/shared/auth/permissions";
import { broadcastSignout } from "@/lib/auth/auth-broadcast";
import { closeClientSocket } from "@/lib/socket-client";
import { cn, initials } from "@ccp/shared/utils";
import type { Team, User } from "@ccp/shared/types";

/**
 * Far-left icon-only main nav. Every authenticated page renders this. Pair
 * with a section-specific sub-sidebar (settings / contacts / inbox / etc.)
 * for the contextual nav that lives one column to the right.
 *
 * Items here are the top-level "sections" of the app. Sub-feature navigation
 * (audience groups, templates, snippets, tags, etc.) lives in the sub-sidebars.
 *
 * Optional props:
 *  - connected: realtime dot on the team badge. Only meaningful inside /inbox
 *    today; omit elsewhere and the indicator disappears.
 *  - onlineUserIds: drives the green dot on the user's own avatar.
 */

interface RailItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra route prefixes that should also highlight this item. */
  match?: string[];
}

const PRIMARY_ITEMS: RailItem[] = [
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/team", label: "Team chat", icon: MessageSquareText },
  { href: "/contacts", label: "Contacts", icon: ContactRound },
  {
    href: "/broadcasts",
    label: "Broadcasts",
    icon: Megaphone,
    // Templates + audience groups live conceptually under Broadcasts.
    match: ["/templates", "/broadcasts/groups"],
  },
  { href: "/workflows", label: "Workflows", icon: Workflow },
];

export function AppRail({
  currentUser,
  team,
  connected,
  onlineUserIds,
}: {
  currentUser: User;
  team: Team;
  connected?: boolean;
  onlineUserIds?: Set<string>;
}) {
  const pathname = usePathname() ?? "";
  const isOnline = onlineUserIds?.has(currentUser.id) ?? false;
  const hasPresence = onlineUserIds !== undefined;

  // Settings entry point is always visible (account settings work for any
  // role); per-item permission gates live in SettingsSubSidebar.
  const items = useMemo<RailItem[]>(() => {
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

  return (
    <aside className="hidden h-svh w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar/60 py-3 text-sidebar-foreground md:flex">
      {/* Team badge */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href="/inbox"
            className="relative flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-transform hover:scale-105"
            aria-label={team.name}
          >
            <span className="text-sm font-semibold">
              {team.name.charAt(0).toUpperCase()}
            </span>
            {connected !== undefined && (
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-sidebar transition-colors",
                  connected ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
                aria-label={connected ? "Realtime connected" : "Realtime disconnected"}
              />
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">{team.name}</TooltipContent>
      </Tooltip>

      <div className="mt-4 h-px w-8 bg-sidebar-border" />

      {/* Primary section nav */}
      <nav className="mt-3 flex flex-col items-center gap-1.5">
        {items.map((item) => (
          <RailLink key={item.href} item={item} pathname={pathname} />
        ))}
      </nav>

      {/* Footer: user menu */}
      <div className="mt-auto flex flex-col items-center gap-2 pb-1">
        <UserMenu currentUser={currentUser}>
          <button
            type="button"
            className="relative mt-1 flex cursor-pointer items-center justify-center"
            aria-label="Open account menu"
          >
            <Avatar className="size-8 ring-2 ring-sidebar transition-shadow hover:ring-foreground/20">
              <AvatarFallback className="text-[11px]">
                {initials(currentUser.name)}
              </AvatarFallback>
            </Avatar>
            {hasPresence && (
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-sidebar transition-colors",
                  isOnline ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
                aria-label={isOnline ? "Online" : "Offline"}
              />
            )}
          </button>
        </UserMenu>
      </div>
    </aside>
  );
}

function RailLink({ item, pathname }: { item: RailItem; pathname: string }) {
  const { href, label, icon: Icon, match } = item;
  // /inbox highlights for /inbox/[id], /settings for /settings/workspace, etc.
  // Each extra `match` prefix also lights up the item.
  const matchAll = useMemo(() => [href, ...(match ?? [])], [href, match]);
  const active = matchAll.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
  const isAdmin = href === "/admin";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={href}
          className={cn(
            "group relative flex size-10 items-center justify-center rounded-lg transition-colors",
            isAdmin
              ? cn(
                  "border border-dashed border-amber-500/30",
                  active
                    ? "bg-amber-500/10 text-amber-600 dark:text-amber-300"
                    : "text-amber-700/80 hover:bg-amber-500/10 hover:text-foreground dark:text-amber-300/80",
                )
              : cn(
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                ),
          )}
          aria-current={active ? "page" : undefined}
          aria-label={label}
        >
          <Icon className="size-4.5" />
          {active && !isAdmin && (
            <span className="absolute left-0 top-1.5 h-7 w-0.5 -translate-x-2 rounded-r-full bg-primary" />
          )}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function UserMenu({
  currentUser,
  children,
}: {
  currentUser: User;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="right" className="min-w-52">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="text-sm font-medium">{currentUser.name}</span>
            <span className="text-[11px] font-normal text-muted-foreground">
              {currentUser.email}
            </span>
            <span className="mt-0.5 text-[10px] font-normal text-muted-foreground/80">
              {roleLabel(currentUser.role)}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/workspace">
            <UserCircle2 className="size-4 text-muted-foreground" />
            Account settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <SettingsIcon className="size-4 text-muted-foreground" />
            Workspace settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            // Drop the socket before navigation so other clients see the
            // user go offline immediately. Hard nav avoids the Better Auth
            // cookies-vs-redirect race in server actions.
            broadcastSignout();
            closeClientSocket();
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
