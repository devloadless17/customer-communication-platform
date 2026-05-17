"use client";

import Link from "next/link";
import { Hash, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TeamChannelListItemDto } from "@ccp/shared/team-chat/types";
import type { Role } from "@ccp/shared/types";
import { cn } from "@ccp/shared/utils";

import { canCreateChannel } from "@ccp/shared/team-chat/permissions";

/**
 * Left column inside /team. Lists every channel with unread + mention
 * badges. The "new channel" button is gated by role.
 */
export function ChannelList({
  channels,
  activeChannelId,
  currentRole,
  onlinePresenceCount,
  onCreate,
}: {
  channels: TeamChannelListItemDto[];
  activeChannelId: string;
  currentRole: Role;
  onlinePresenceCount: number;
  onCreate: () => void;
}) {
  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div>
          <div className="text-sm font-semibold">Team chat</div>
          <div className="text-[11px] text-muted-foreground">
            {onlinePresenceCount} online
          </div>
        </div>
        {canCreateChannel(currentRole) && (
          <Button
            size="icon"
            variant="ghost"
            onClick={onCreate}
            className="size-7"
            aria-label="Create channel"
          >
            <Plus className="size-4" />
          </Button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          Channels
        </div>
        <div className="flex flex-col gap-0.5">
          {channels.map((c) => {
            const active = c.id === activeChannelId;
            return (
              <Link
                key={c.id}
                href={`/team/${c.id}`}
                className={cn(
                  "group flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors",
                  active
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Hash
                  className={cn(
                    "size-3.5 shrink-0",
                    active ? "text-primary" : "text-muted-foreground",
                  )}
                />
                <span
                  className={cn(
                    "flex-1 truncate",
                    c.unreadForMe && !active && "font-semibold text-foreground",
                  )}
                >
                  {c.name}
                </span>
                {c.unreadMentionCount > 0 && (
                  <Badge
                    variant="default"
                    className="h-4 min-w-4 rounded-full bg-red-500 px-1 text-[10px]"
                  >
                    {c.unreadMentionCount}
                  </Badge>
                )}
                {c.unreadMentionCount === 0 && c.unreadForMe && !active && (
                  <span className="size-1.5 rounded-full bg-primary" />
                )}
              </Link>
            );
          })}
          {channels.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No channels yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
