"use client";

import { Hash, Pencil, Trash2, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
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
}: {
  channel: TeamChannelDto;
  currentRole: Role;
  memberCount: number;
  typingUserIds: string[];
  teamMemberNameById: Map<string, string>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const canEdit = canManageChannel(currentRole);
  const canDelete = canDeleteChannel(currentRole) && !channel.isDefault;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-4 py-3">
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
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Users className="size-3.5" />
            <span>{memberCount}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>Team members</TooltipContent>
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
