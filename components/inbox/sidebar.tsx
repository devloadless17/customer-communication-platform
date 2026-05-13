"use client";

import { useMemo, useTransition } from "react";
import Link from "next/link";
import {
  Inbox,
  AtSign,
  UserPlus,
  CheckCircle2,
  ContactRound,
  Megaphone,
  Settings,
  MessageSquareText,
  ShieldCheck,
  Users,
  LogOut,
  UserCircle2,
  type LucideIcon,
} from "lucide-react";

import { cn, initials } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { signOutAction } from "@/lib/actions/auth";
import { roleLabel } from "@/lib/permissions";
import { closeClientSocket } from "@/lib/socket-client";
import type { ConversationWithRefs, Team, User } from "@/lib/types";

import { SessionStatus } from "./session-status";

export type FilterId = "all" | "mine" | "unassigned" | "closed";

interface FilterDef {
  id: FilterId;
  label: string;
  icon: LucideIcon;
}

const FILTERS: FilterDef[] = [
  { id: "all", label: "All", icon: Inbox },
  { id: "mine", label: "Mine", icon: AtSign },
  { id: "unassigned", label: "Unassigned", icon: UserPlus },
  { id: "closed", label: "Closed", icon: CheckCircle2 },
];

export function Sidebar({
  currentUser,
  team,
  teammates,
  conversations,
  filter,
  onFilterChange,
  connected,
  onlineUserIds,
}: {
  currentUser: User;
  team: Team;
  teammates: User[];
  conversations: ConversationWithRefs[];
  filter: FilterId;
  onFilterChange: (f: FilterId) => void;
  connected: boolean;
  onlineUserIds: Set<string>;
}) {
  const counts = useMemo(() => {
    const c = conversations.map((x) => x.conversation);
    return {
      all: c.filter((x) => x.status !== "closed").length,
      mine: c.filter((x) => x.assignedUserId === currentUser.id && x.status !== "closed").length,
      unassigned: c.filter((x) => x.assignedUserId === null && x.status !== "closed").length,
      closed: c.filter((x) => x.status === "closed").length,
    } satisfies Record<FilterId, number>;
  }, [conversations, currentUser.id]);

  // Pin current user first; alphabetical otherwise. Server already sorted by
  // name, this just keeps "you" at the top so it's findable.
  const orderedTeammates = useMemo(() => {
    const me = teammates.find((u) => u.id === currentUser.id);
    const others = teammates.filter((u) => u.id !== currentUser.id);
    return me ? [me, ...others] : [currentUser, ...others];
  }, [teammates, currentUser]);

  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MessageSquareText className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight">{team.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">WhatsApp · Phase 1</div>
        </div>
      </div>

      <div className="px-3">
        <SessionStatus connected={connected} />
      </div>

      <nav className="mt-3 flex flex-col gap-0.5 px-2">
        {FILTERS.map(({ id, label, icon: Icon }) => {
          const active = filter === id;
          const count = counts[id];
          return (
            <button
              key={id}
              type="button"
              onClick={() => onFilterChange(id)}
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
                  active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                )}
              />
              <span className="flex-1 text-left">{label}</span>
              {count > 0 && (
                <span
                  className={cn(
                    "tabular-nums text-[11px]",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <nav className="mt-3 flex flex-col gap-0.5 px-2">
        <Link
          href="/contacts"
          className="group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ContactRound className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
          <span className="flex-1 text-left">Contacts</span>
        </Link>
        <Link
          href="/broadcasts"
          className="group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Megaphone className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
          <span className="flex-1 text-left">Broadcasts</span>
        </Link>
        <Link
          href="/settings"
          className="group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Settings className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
          <span className="flex-1 text-left">Settings</span>
        </Link>
        {currentUser.role === "superAdmin" && (
          <Link
            href="/admin"
            className="group mt-1 flex h-8 items-center gap-2.5 rounded-md border border-dashed border-amber-500/30 px-2.5 text-sm text-amber-700/80 transition-colors hover:bg-amber-500/10 hover:text-foreground dark:text-amber-300/80"
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
        {orderedTeammates.map((u) => {
          const online = onlineUserIds.has(u.id);
          return (
            <div
              key={u.id}
              className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground"
            >
              <div className="relative">
                <Avatar className="size-5">
                  <AvatarFallback className="text-[9px]">{initials(u.name)}</AvatarFallback>
                </Avatar>
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar transition-colors",
                    online ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                  aria-label={online ? "Online" : "Offline"}
                />
              </div>
              <span className="truncate">{u.name}</span>
              {u.id === currentUser.id && (
                <Badge variant="muted" className="ml-auto px-1.5 py-0 text-[10px]">
                  you
                </Badge>
              )}
            </div>
          );
        })}
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
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Open user menu"
            >
              <Settings className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Settings</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="top" className="min-w-[180px]">
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
            // Drop the socket FIRST. Auth.js's signOut redirect is a soft
            // client-side navigation — the page doesn't unload and the
            // socket would otherwise stay connected as the just-signed-out
            // user, leaving their presence dot lit on every other client.
            closeClientSocket();
            startTransition(() => signOutAction());
          }}
          disabled={pending}
        >
          <LogOut className="size-4 text-muted-foreground" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
