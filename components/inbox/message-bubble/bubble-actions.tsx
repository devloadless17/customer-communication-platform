"use client";

import {
  AlertCircle,
  CornerUpLeft,
  Forward,
  ListChecks,
  MoreHorizontal,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Message } from "@/lib/types";

export function BubbleActions({
  message,
  canReply,
  canForward,
  canSelect,
  onReply,
  onForward,
  onStartSelect,
}: {
  message: Message;
  canReply: boolean;
  canForward: boolean;
  canSelect: boolean;
  onReply?: (message: Message) => void;
  onForward?: (message: Message) => void;
  onStartSelect?: (message: Message) => void;
}) {
  const hasMenu = (canForward && Boolean(onForward)) || (canSelect && Boolean(onStartSelect));
  if (!(canReply && onReply) && !hasMenu) return null;
  return (
    <div className="flex items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {canReply && onReply && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onReply(message)}
          title="Reply to this message"
          aria-label="Reply to this message"
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <CornerUpLeft className="size-3.5" />
        </Button>
      )}
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="More actions"
              aria-label="More actions"
              className="size-7 text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {canForward && onForward && (
              <DropdownMenuItem onSelect={() => onForward(message)}>
                <Forward className="size-3.5" />
                Forward
              </DropdownMenuItem>
            )}
            {canSelect && onStartSelect && (
              <DropdownMenuItem onSelect={() => onStartSelect(message)}>
                <ListChecks className="size-3.5" />
                Select messages
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function FailedRecovery({
  canRetry,
  onRetry,
  onDismiss,
}: {
  canRetry: boolean;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-destructive">
      <AlertCircle className="size-3" />
      <span>Send failed</span>
      {canRetry && onRetry && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <button
            type="button"
            onClick={onRetry}
            className="font-medium hover:underline"
          >
            Retry
          </button>
        </>
      )}
      {onDismiss && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground hover:underline"
          >
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
