"use client";

import {
  Hash,
  Lock,
  LogOut,
  PanelLeft,
  Pencil,
  Search,
  Settings,
  Trash2,
  Users,
} from "lucide-react";

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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@ccp/shared/utils";
import type {
  DirectMessagePeerDto,
  TeamChannelDto,
} from "@ccp/shared/team-chat/types";
import type { Role } from "@ccp/shared/types";

import { TypingIndicator } from "./typing-indicator";

/**
 * Sticky header for the active channel: name + description + typing dots +
 * channel-settings menu (edit, leave, delete). Delete is gated by role AND
 * `!isDefault`.
 *
 * In a DM the whole administrative surface is hidden — there's nothing to
 * rename, no members to manage, nothing to leave or delete. The header
 * becomes the peer's identity instead, and the server backs that up by
 * 404-ing every channel-admin route that targets a DM.
 */
export function ChannelHeader({
  channel,
  currentRole,
  memberCount,
  typingUserIds,
  teamMemberNameById,
  viewerUserId,
  onEdit,
  onDelete,
  onOpenSearch,
  onOpenMembers,
  onLeave,
  dmPeer,
}: {
  channel: TeamChannelDto;
  currentRole: Role;
  memberCount: number;
  typingUserIds: string[];
  teamMemberNameById: Map<string, string>;
  /** The viewing agent — filtered out so they don't see their own name typing. */
  viewerUserId: string;
  onEdit: () => void;
  onDelete: () => void;
  onOpenSearch: () => void;
  /** Opens the channel-members dialog (add / remove people). */
  onOpenMembers: () => void;
  /** Self-leave. Hidden for the default channel and for DMs. */
  onLeave: () => void;
  /** Identity of the other party when this row is a DM; null for channels. */
  dmPeer?: DirectMessagePeerDto | null;
}) {
  const isDm = channel.kind === "dm";
  const canEdit = !isDm && canManageChannel(currentRole);
  const canDelete = !isDm && canDeleteChannel(currentRole) && !channel.isDefault;
  // Anyone can leave any channel except the default one. DMs aren't leavable —
  // leaving would strand the other party in a one-sided room.
  const canLeave = !isDm && !channel.isDefault;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-3 md:gap-3 md:px-4">
      {/* Mobile-only: opens the nav drawer, which carries the channel list. */}
      <button
        type="button"
        onClick={openMobileNav}
        aria-label="Browse channels"
        className="-ml-1 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden pointer-coarse:size-9"
      >
        <PanelLeft className="size-4" />
      </button>
      {isDm ? (
        <Avatar className="size-6 shrink-0">
          {dmPeer?.avatarUrl ? <AvatarImage src={dmPeer.avatarUrl} alt="" /> : null}
          <AvatarFallback className="text-3xs">
            {initials(dmPeer?.name ?? "")}
          </AvatarFallback>
        </Avatar>
      ) : channel.visibility === "private" ? (
        <Lock className="size-4 shrink-0 text-muted-foreground" aria-label="Private channel" />
      ) : (
        <Hash className="size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">
            {isDm ? (dmPeer?.name ?? "Direct message") : channel.name}
          </span>
          {isDm && dmPeer?.isSelf && (
            <span className="rounded-full bg-muted px-1.5 py-0 text-3xs uppercase tracking-wider text-muted-foreground">
              you
            </span>
          )}
          {!isDm && channel.isDefault && (
            <span className="rounded-full bg-muted px-1.5 py-0 text-3xs uppercase tracking-wider text-muted-foreground">
              default
            </span>
          )}
        </div>
        {isDm ? (
          <div className="truncate text-xs text-muted-foreground">
            {dmPeer?.isSelf
              ? "Notes to self"
              : dmPeer?.deactivated
                ? "Deactivated account"
                : "Direct message"}
          </div>
        ) : channel.description ? (
          <div className="truncate text-xs text-muted-foreground">
            {channel.description}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No description</div>
        )}
      </div>
      <TypingIndicator
        userIds={typingUserIds}
        namesById={teamMemberNameById}
        viewerUserId={viewerUserId}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 pointer-coarse:size-9"
            onClick={onOpenSearch}
            aria-label="Search this channel"
          >
            <Search className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Search channel</TooltipContent>
      </Tooltip>
      {!isDm && (
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
      )}
      {(canEdit || canDelete || canLeave) && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 pointer-coarse:size-9"
                  aria-label="Channel settings"
                >
                  <Settings className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Channel settings</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-44">
            {canEdit && (
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="size-4 text-muted-foreground" />
                Edit channel
              </DropdownMenuItem>
            )}
            {canLeave && (
              <DropdownMenuItem onClick={onLeave}>
                <LogOut className="size-4 text-muted-foreground" />
                Leave channel
              </DropdownMenuItem>
            )}
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
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
