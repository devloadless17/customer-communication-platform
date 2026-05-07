"use client";

import { useMemo } from "react";
import {
  Inbox,
  AtSign,
  UserPlus,
  CheckCircle2,
  Settings,
  MessageSquareText,
  type LucideIcon,
} from "lucide-react";

import { cn, initials } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  conversations,
  filter,
  onFilterChange,
}: {
  currentUser: User;
  team: Team;
  conversations: ConversationWithRefs[];
  filter: FilterId;
  onFilterChange: (f: FilterId) => void;
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

  const teammates = useMemo(() => {
    const seen = new Set<string>();
    const list: User[] = [currentUser];
    seen.add(currentUser.id);
    for (const { assignedUser } of conversations) {
      if (assignedUser && !seen.has(assignedUser.id)) {
        list.push(assignedUser);
        seen.add(assignedUser.id);
      }
    }
    return list;
  }, [conversations, currentUser]);

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
        <SessionStatus connected />
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

      <div className="mt-6 px-4 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Teammates
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        {teammates.map((u, i) => (
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
                  "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar",
                  i === 0 ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
              />
            </div>
            <span className="truncate">{u.name}</span>
            {u.id === currentUser.id && (
              <Badge variant="muted" className="ml-auto px-1.5 py-0 text-[10px]">
                you
              </Badge>
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
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Settings className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Settings</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
