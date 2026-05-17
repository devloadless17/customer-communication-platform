"use client";

import { memo, useState } from "react";
import {
  CheckCircle2,
  Edit3,
  MessageSquareText,
  MoreHorizontal,
  Pin,
  PinOff,
  SmilePlus,
  Trash2,
  X,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { toast } from "@/lib/toast";
import { canEditMessage } from "@ccp/shared/team-chat/permissions";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";
import { LocalTime } from "@/components/local-time";
import type { User } from "@ccp/shared/types";
import { cn, formatMessageTime, initials } from "@ccp/shared/utils";

import { BodyRenderer } from "./body-renderer";
import { ReactionPicker } from "./reaction-picker";

/**
 * Single message bubble. Renders:
 *   - avatar + author name + timestamp + (edited) label
 *   - body (with mention chips)
 *   - media attachment when present
 *   - reaction chips row
 *   - hover toolbar: react / reply in thread / pin (perms) / edit (author + window) / delete (perms)
 *
 * Receives callbacks instead of dispatching directly so the same bubble
 * works for both the channel feed and the thread side panel.
 */
function ChannelMessageImpl({
  message,
  currentUser,
  channelId,
  canPin,
  canDelete,
  isThreadReply,
  onOpenThread,
}: {
  message: TeamChannelMessageDto;
  currentUser: User;
  channelId: string;
  canPin: boolean;
  /** True if THIS user is allowed to delete THIS message. */
  canDelete: boolean;
  /** True when this bubble lives inside the thread panel — hides the
   *  "Reply in thread" action so threads can't nest. */
  isThreadReply: boolean;
  /**
   * Opens the thread side panel for this message. Signature takes
   * `rootMessageId` so the parent passes a STABLE function reference (not a
   * fresh closure per row), which is what makes the surrounding `memo()`
   * wrapper actually skip re-renders for unchanged bubbles.
   */
  onOpenThread?: (rootMessageId: string) => void;
}) {
  const [showReactions, setShowReactions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const canEdit = canEditMessage(message.authorUserId, currentUser.id, message.createdAt);
  const isOwn = message.authorUserId === currentUser.id;
  const authorName = message.authorName ?? "Removed user";

  const toggleReaction = async (emoji: string) => {
    setShowReactions(false);
    try {
      await fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages/${message.id}/reactions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emoji }),
        },
      );
    } catch {
      // Server is authoritative — the next reaction:changed event reconciles.
    }
  };

  const togglePin = async () => {
    try {
      await fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages/${message.id}/pin`,
        { method: message.pinned ? "DELETE" : "POST" },
      );
    } catch {}
  };

  const submitDelete = async () => {
    const ok = await confirm({
      title: "Delete this message?",
      description: "This can't be undone. Teammates will stop seeing it on their next refresh.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages/${message.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        toast.error("Couldn't delete message", { description: `HTTP ${res.status}` });
      }
    } catch {
      toast.error("Couldn't delete message", { description: "Network error" });
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    const next = draft.trim();
    if (!next || next === message.body) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages/${message.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: next }),
        },
      );
      if (res.ok) setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "group relative flex gap-3 px-4 py-1.5 transition-colors hover:bg-muted/40",
        message.pinned && !isThreadReply && "bg-amber-50/40 dark:bg-amber-950/10",
        message.pending && "opacity-60",
        message.failed && "bg-red-50 dark:bg-red-950/20",
      )}
    >
      <Avatar className="mt-0.5 size-9 shrink-0">
        {message.authorAvatarUrl ? (
          <AvatarImage src={message.authorAvatarUrl} alt={authorName} />
        ) : null}
        <AvatarFallback className="text-xs">{initials(authorName)}</AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{authorName}</span>
          <LocalTime
            iso={message.createdAt}
            format={formatMessageTime}
            className="text-[11px] text-muted-foreground"
          />
          {message.editedAt && (
            <span className="text-[11px] text-muted-foreground">(edited)</span>
          )}
          {message.pinned && !isThreadReply && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Pin className="size-3 text-amber-600" />
              </TooltipTrigger>
              <TooltipContent>Pinned to this channel</TooltipContent>
            </Tooltip>
          )}
        </div>

        {editing ? (
          <div className="mt-1 space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              rows={Math.min(8, Math.max(2, draft.split("\n").length))}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(message.body);
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  void submitEdit();
                }
              }}
            />
            <div className="flex items-center gap-2 text-xs">
              <Button size="sm" onClick={() => void submitEdit()} disabled={busy}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setDraft(message.body);
                }}
              >
                Cancel
              </Button>
              <span className="text-muted-foreground">Esc to cancel · ⌘↵ to save</span>
            </div>
          </div>
        ) : (
          <div className="mt-0.5">
            <BodyRenderer body={message.body} highlightUserId={currentUser.id} />
            {message.media && <MediaAttachment media={message.media} />}
          </div>
        )}

        {message.reactions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {message.reactions.map((r) => {
              const mine = r.userIds.includes(currentUser.id);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={() => void toggleReaction(r.emoji)}
                  className={cn(
                    "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                    mine
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border bg-muted/50 hover:bg-muted",
                  )}
                  title={`${r.userIds.length} ${r.userIds.length === 1 ? "reaction" : "reactions"}`}
                >
                  <span className="text-sm leading-none">{r.emoji}</span>
                  <span className="font-medium">{r.userIds.length}</span>
                </button>
              );
            })}
          </div>
        )}

        {!isThreadReply && message.threadReplyCount > 0 && (
          <button
            type="button"
            onClick={() => onOpenThread?.(message.id)}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-primary transition-colors hover:bg-accent"
          >
            <MessageSquareText className="size-3.5" />
            <span className="font-semibold">{message.threadReplyCount}</span>
            <span className="text-muted-foreground">
              {message.threadReplyCount === 1 ? "reply" : "replies"}
            </span>
          </button>
        )}

        {message.failed && (
          <div className="mt-1 flex items-center gap-2 text-xs text-red-600">
            <X className="size-3" />
            Failed to send. Try again.
          </div>
        )}
        {message.pending && (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <CheckCircle2 className="size-3 opacity-40" />
            Sending…
          </div>
        )}
      </div>

      {!editing && !message.pending && !message.failed && (
        <div
          className="absolute -top-3 right-4 flex items-center gap-0.5 rounded-md border border-border bg-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
          onMouseLeave={() => setShowReactions(false)}
        >
          {showReactions && (
            <ReactionPicker
              align="right"
              onPick={(e) => void toggleReaction(e)}
            />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setShowReactions((s) => !s)}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <SmilePlus className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add reaction</TooltipContent>
          </Tooltip>
          {!isThreadReply && onOpenThread && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onOpenThread(message.id)}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <MessageSquareText className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Reply in thread</TooltipContent>
            </Tooltip>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {canPin && !isThreadReply && (
                <DropdownMenuItem onClick={() => void togglePin()}>
                  {message.pinned ? (
                    <>
                      <PinOff className="size-4 text-muted-foreground" />
                      Unpin from channel
                    </>
                  ) : (
                    <>
                      <Pin className="size-4 text-muted-foreground" />
                      Pin to channel
                    </>
                  )}
                </DropdownMenuItem>
              )}
              {canEdit && isOwn && (
                <DropdownMenuItem onClick={() => setEditing(true)}>
                  <Edit3 className="size-4 text-muted-foreground" />
                  Edit message
                </DropdownMenuItem>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600 focus:text-red-600"
                    onClick={() => void submitDelete()}
                  >
                    <Trash2 className="size-4" />
                    Delete message
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

/**
 * Memo with a content-aware comparator.
 *
 * Why: every `team:channel:message` event in this team's room triggers a
 * setMessages on `useTeamChannelEvents`. Without memo, every visible
 * bubble re-renders even though only one row's data actually changed.
 * On a 200-message channel feed under steady inbound traffic, that's
 * ~200 needless renders per message arrival.
 *
 * Fast path: when the hook's findIndex+slice setMessages preserves stable
 * object identity for unchanged rows (use-team-channel-events.ts after
 * session 7's audit), `prev.message === next.message` short-circuits the
 * whole comparison in microseconds.
 *
 * Slow path: hits the field-by-field check only when the message object
 * identity changed — which happens only for the touched row.
 */
function reactionsEqual(
  a: TeamChannelMessageDto["reactions"],
  b: TeamChannelMessageDto["reactions"],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ar = a[i]!;
    const br = b[i]!;
    if (ar.emoji !== br.emoji) return false;
    if (ar.userIds.length !== br.userIds.length) return false;
    for (let j = 0; j < ar.userIds.length; j++) {
      if (ar.userIds[j] !== br.userIds[j]) return false;
    }
  }
  return true;
}

export const ChannelMessage = memo(
  ChannelMessageImpl,
  (prev, next) => {
    // The cheap path that catches ~all unchanged rows.
    if (
      prev.message === next.message &&
      prev.currentUser === next.currentUser &&
      prev.channelId === next.channelId &&
      prev.canPin === next.canPin &&
      prev.canDelete === next.canDelete &&
      prev.isThreadReply === next.isThreadReply &&
      prev.onOpenThread === next.onOpenThread
    ) {
      return true;
    }
    // Fallback: identity mismatch on message (the touched row) — only the
    // fields that actually drive the rendered output need to be compared.
    if (
      prev.currentUser !== next.currentUser ||
      prev.channelId !== next.channelId ||
      prev.canPin !== next.canPin ||
      prev.canDelete !== next.canDelete ||
      prev.isThreadReply !== next.isThreadReply ||
      prev.onOpenThread !== next.onOpenThread
    ) {
      return false;
    }
    const a = prev.message;
    const b = next.message;
    return (
      a.id === b.id &&
      a.body === b.body &&
      a.editedAt === b.editedAt &&
      a.pinned === b.pinned &&
      a.threadReplyCount === b.threadReplyCount &&
      a.threadLastReplyAt === b.threadLastReplyAt &&
      a.pending === b.pending &&
      a.failed === b.failed &&
      a.media === b.media &&
      a.authorAvatarUrl === b.authorAvatarUrl &&
      a.authorName === b.authorName &&
      reactionsEqual(a.reactions, b.reactions)
    );
  },
);

function MediaAttachment({ media }: { media: NonNullable<TeamChannelMessageDto["media"]> }) {
  if (media.kind === "image" || media.kind === "sticker") {
    return (
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1.5 block max-w-sm overflow-hidden rounded-lg border border-border"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media.url}
          alt={media.caption ?? media.filename ?? "attachment"}
          className="max-h-64 w-auto object-contain"
        />
      </a>
    );
  }
  if (media.kind === "video") {
    return (
      <video controls className="mt-1.5 max-h-72 max-w-sm rounded-lg border border-border">
        <source src={media.url} type={media.mimeType} />
      </video>
    );
  }
  if (media.kind === "audio") {
    return (
      <audio controls className="mt-1.5 w-full max-w-sm">
        <source src={media.url} type={media.mimeType} />
      </audio>
    );
  }
  // document / fallback — render as a download link.
  return (
    <a
      href={media.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 inline-flex max-w-sm items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs hover:bg-muted"
    >
      <span className="truncate font-medium">{media.filename ?? "Attachment"}</span>
      <span className="text-muted-foreground">
        {Math.max(1, Math.round(media.sizeBytes / 1024))} KB
      </span>
    </a>
  );
}
