"use client";

import { memo } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PresenceDot } from "@/components/presence-dot";
import { cn, initials } from "@ccp/shared/utils";
import type { UserAvailabilityStatus } from "@ccp/shared/types";
import type { TeamDmListItemDto } from "@ccp/shared/team-chat/types";

/**
 * The "Direct messages" section of the team-chat sidebar.
 *
 * Sorted by recency (server-side), unlike channels which sort by name — a DM
 * list is a recency list; you look for the conversation you were just in.
 *
 * NOT virtualized, deliberately: a person has a handful of DMs, not hundreds,
 * and virtualizing would force the presence `Set` through a memo boundary that
 * changes identity on every presence frame (see the per-row boolean below).
 * The channel list virtualizes because a team can genuinely have 200 channels.
 */
export function DmList({
  dms,
  activeChannelId,
  onSelect,
  onlineUserIds,
  availabilityByUserId,
  onStartDm,
}: {
  dms: TeamDmListItemDto[];
  activeChannelId: string;
  /** Optimistic selection — fires on click, before the route commits. */
  onSelect: (channelId: string) => void;
  onlineUserIds: Set<string>;
  availabilityByUserId?: Record<string, { status: UserAvailabilityStatus }>;
  onStartDm: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <div className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
          Direct messages
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-5"
          onClick={onStartDm}
          aria-label="New direct message"
          title="New direct message"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      {dms.length === 0 ? (
        <div className="px-4 pb-2 text-xs text-muted-foreground">
          No direct messages yet.
        </div>
      ) : (
        <div className="px-2 pb-3">
          {dms.map((dm) => (
            <DmRow
              key={dm.id}
              dm={dm}
              active={dm.id === activeChannelId}
              onSelect={onSelect}
              // Resolve to a per-row BOOLEAN here rather than passing the Set
              // down: the Set gets a new identity on every presence frame,
              // which would defeat DmRow's memo and re-render every row.
              online={dm.peer.userId ? onlineUserIds.has(dm.peer.userId) : false}
              availability={
                dm.peer.userId
                  ? (availabilityByUserId?.[dm.peer.userId]?.status ?? null)
                  : null
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

const DmRow = memo(function DmRow({
  dm,
  active,
  online,
  availability,
  onSelect,
}: {
  dm: TeamDmListItemDto;
  active: boolean;
  online: boolean;
  availability: UserAvailabilityStatus | null;
  onSelect: (channelId: string) => void;
}) {
  const { peer } = dm;
  const label = peer.isSelf ? `${peer.name} (you)` : peer.name;

  return (
    <Link
      href={`/team/${dm.id}`}
      onClick={() => onSelect(dm.id)}
      className={cn(
        "group flex h-9 items-center gap-2 rounded-md px-2 text-sm transition-colors",
        active
          ? "border-l-2 border-primary bg-primary/15 pl-1 font-semibold text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <span className="relative shrink-0">
        <Avatar className="size-5">
          {peer.avatarUrl ? <AvatarImage src={peer.avatarUrl} alt="" /> : null}
          <AvatarFallback className="text-3xs">{initials(peer.name)}</AvatarFallback>
        </Avatar>
        {/* No presence dot for the notes-to-self row — "am I online" is noise,
            and none for a hard-deleted peer, who has no identity to report. */}
        {!peer.isSelf && peer.userId ? (
          <PresenceDot
            online={online}
            availability={availability}
            className="absolute -bottom-0.5 -right-0.5"
          />
        ) : null}
      </span>

      <span
        className={cn(
          "flex-1 truncate",
          dm.unreadForMe && !active && "font-semibold text-foreground",
          peer.deactivated && "italic opacity-70",
        )}
      >
        {label}
      </span>

      {dm.unreadMentionCount > 0 && (
        <Badge
          variant="default"
          className="h-4 min-w-4 rounded-full bg-destructive px-1 text-3xs text-destructive-foreground"
        >
          {dm.unreadMentionCount}
        </Badge>
      )}
      {dm.unreadMentionCount === 0 && dm.unreadForMe && !active && (
        <span className="size-1.5 rounded-full bg-primary" />
      )}
    </Link>
  );
});
