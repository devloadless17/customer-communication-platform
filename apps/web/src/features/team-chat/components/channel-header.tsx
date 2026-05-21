"use client";

import { Hash, PanelLeft, Pencil, Search, Trash2, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { openMobileNav } from "@/components/layouts/mobile-shell-chrome";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  canDeleteChannel,
  canManageChannel,
} from "@ccp/shared/team-chat/permissions";
import type { TeamChannelDto } from "@ccp/shared/team-chat/types";
import type { Role } from "@ccp/shared/types";

import { TypingIndicator } from "./typing-indicator";

/**
 * Sticky header for the active channel: name + description + typing dots +
 * menu (edit, delete). Delete is gated by role AND `!isDefault`.
 */
export function ChannelHeader({
  channel,
  currentRole,
  memberCount,
  typingUserIds,
  teamMemberNameById,
  onEdit,
  onDelete,
  onOpenSearch,
  onOpenMembers,
}: {
  channel: TeamChannelDto;
  currentRole: Role;
  memberCount: number;
  typingUserIds: string[];
  teamMemberNameById: Map<string, string>;
  onEdit: () => void;
  onDelete: () => void;
  onOpenSearch: () => void;
  /** Opens the channel-members dialog (add / remove people). */
  onOpenMembers: () => void;
}) {
  const canEdit = canManageChannel(currentRole);
  const canDelete = canDeleteChannel(currentRole) && !channel.isDefault;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-3 md:gap-3 md:px-4">
      {/* Mobile-only: opens the nav drawer, which carries the channel list. */}
      <button
        type="button"
        onClick={openMobileNav}
        aria-label="Browse channels"
        className="-ml-1 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
      >
        <PanelLeft className="size-4" />
      </button>
      <Hash className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{channel.name}</span>
          {channel.isDefault && (
            <span className="rounded-full bg-muted px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
              default
            </span>
          )}
        </div>
        {channel.description ? (
          <div className="truncate text-xs text-muted-foreground">
            {channel.description}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No description</div>
        )}
      </div>
      <TypingIndicator userIds={typingUserIds} namesById={teamMemberNameById} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={onOpenSearch}
            aria-label="Search this channel"
          >
            <Search className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Search channel</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpenMembers}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Channel members"
          >
            <Users className="size-3.5" />
            <span className="tabular-nums">{memberCount}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Channel members</TooltipContent>
      </Tooltip>
      {(canEdit || canDelete) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-8">
              Manage
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {canEdit && (
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="size-4 text-muted-foreground" />
                Edit channel
              </DropdownMenuItem>
            )}
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-red-600 focus:text-red-600"
                  onClick={onDelete}
                >
                  <Trash2 className="size-4" />
                  Delete channel
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
