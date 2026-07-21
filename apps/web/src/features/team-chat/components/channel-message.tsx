"use client";

import { memo, useState } from "react";
import {
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
import { dispatchLocalSocketEvent } from "@/lib/socket-client";
import { toast } from "@/lib/toast";
import { canEditMessage } from "@ccp/shared/team-chat/permissions";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";
import { LocalTime } from "@/components/local-time";
import type { User } from "@ccp/shared/types";
import { cn, initials } from "@ccp/shared/utils";

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
/**
 * "You, Sara Kim and 3 others reacted with 👍".
 *
 * The viewer always sorts first and reads as "You" — that's the fact people
 * actually scan for ("did I already react?"). Caps the name list so a
 * 40-person reaction doesn't produce an unreadable tooltip.
 */
const MAX_NAMED_REACTORS = 5;

function describeReactors(
  userIds: string[],
  viewerUserId: string,
  displayNameById: Map<string, string> | undefined,
  emoji: string,
): string {
  const ordered = userIds.includes(viewerUserId)
    ? [viewerUserId, ...userIds.filter((id) => id !== viewerUserId)]
    : userIds;
  const names = ordered.map((id) =>
    id === viewerUserId ? "You" : (displayNameById?.get(id) ?? "Someone"),
  );

  const shown = names.slice(0, MAX_NAMED_REACTORS);
  const rest = names.length - shown.length;

  let who: string;
  if (shown.length === 1) who = shown[0]!;
  else if (rest > 0) who = `${shown.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
  else who = `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;

  return `${who} reacted with ${emoji}`;
}

function ChannelMessageImpl({
  message,
  currentUser,
  channelId,
  canPin,
  canDelete,
  isThreadReply,
  isContinuation = false,
  onOpenThread,
  onRetry,
  onDismiss,
  searchQuery,
  displayNameById,
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
   * This message continues a same-author run started by the one above, so the
   * avatar/name/timestamp header is suppressed and the row tightens up. The
   * timestamp reappears on hover in the gutter where the avatar would be.
   */
  isContinuation?: boolean;
  /**
   * Retry sending a FAILED optimistic message (re-POSTs body + clientTempId,
   * flips back to pending). Only wired for the channel feed / thread panel;
   * undefined for read-only contexts (e.g. the thread root header). Text-only
   * — the failed-state UI hides Retry when the message carried media.
   */
  onRetry?: (clientTempId: string) => void;
  /** Dismiss (remove) a FAILED optimistic message from the local list. */
  onDismiss?: (clientTempId: string) => void;
  /**
   * Opens the thread side panel for this message. Signature takes
   * `rootMessageId` so the parent passes a STABLE function reference (not a
   * fresh closure per row), which is what makes the surrounding `memo()`
   * wrapper actually skip re-renders for unchanged bubbles.
   */
  onOpenThread?: (rootMessageId: string) => void;
  /**
   * Active in-channel search query. When non-null, BodyRenderer highlights
   * case-insensitive matches inside the bubble with `<mark>`. Null = no
   * highlight. Pass-through; memo skips on stable-null identity.
   */
  searchQuery?: string | null;
  /**
   * Canonical userId → name roster map. Forwarded to BodyRenderer so mention
   * chips render the authoritative name (not the author-supplied label).
   * Stable identity (memoized in the parent) so the memo comparator skips.
   */
  displayNameById?: Map<string, string>;
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
    // Optimistic: compute the next userIds list (toggle current user in or
    // out) and dispatch the same socket frame the server will broadcast, tagged
    // `optimistic: true`. Version is `Date.now()` at click time so consecutive
    // re-toggles each advance the version and apply instantly (a fixed low
    // version would no-op every re-toggle until the round-trip). The version
    // guard now applies ONLY to optimistic frames, so a client clock ahead of
    // the server can no longer make this frame out-rank — and discard — the
    // authoritative server frame (the bug this `optimistic` flag fixes).
    const existing = message.reactions.find((r) => r.emoji === emoji);
    const priorUserIds = existing?.userIds ?? [];
    const has = priorUserIds.includes(currentUser.id);
    const nextUserIds = has
      ? priorUserIds.filter((id) => id !== currentUser.id)
      : [...priorUserIds, currentUser.id];
    const emit = (userIds: string[]) =>
      dispatchLocalSocketEvent("team:channel:reaction:changed", {
        teamId: currentUser.teamId,
        channelId,
        messageId: message.id,
        emoji,
        userIds,
        version: Date.now(),
        // Mark as client-predicted: the version guard applies ONLY to optimistic
        // frames (so consecutive re-toggles still order correctly), while the
        // authoritative server frame is always applied regardless of version.
        optimistic: true,
      });
    emit(nextUserIds);
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages/${message.id}/reactions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emoji }),
        },
      );
      // Roll back on failure — unlike a live change there's no server
      // reaction:changed coming to reconcile, so the optimistic toggle would
      // otherwise stick (out of sync with the server + other clients).
      if (!res.ok) emit(priorUserIds);
    } catch {
      emit(priorUserIds);
    }
  };

  const togglePin = async () => {
    const nextPinned = !message.pinned;
    // The optimistic frame attributes the pin to the actor, which is who it
    // will be attributed to server-side too. The authoritative frame arrives
    // moments later with the real pinnedAt and overwrites this.
    const optimisticPinMeta = nextPinned
      ? {
          pinnedAt: new Date().toISOString(),
          pinnedById: currentUser.id,
          pinnedByName: currentUser.name ?? null,
        }
      : { pinnedAt: null, pinnedById: null, pinnedByName: null };
    // Roll-back frame: restore whatever the pin state was before this click.
    const rollbackPinMeta = message.pinned
      ? {
          pinnedAt: new Date().toISOString(),
          pinnedById: null,
          pinnedByName: null,
        }
      : { pinnedAt: null, pinnedById: null, pinnedByName: null };

    // Optimistic: flip the pin badge instantly + fan the same frame the
    // server will emit so other surfaces (pinned-list etc.) update too.
    dispatchLocalSocketEvent("team:channel:pin:changed", {
      teamId: currentUser.teamId,
      channelId,
      messageId: message.id,
      pinned: nextPinned,
      ...optimisticPinMeta,
    });
    const rollback = () => {
      dispatchLocalSocketEvent("team:channel:pin:changed", {
        teamId: currentUser.teamId,
        channelId,
        messageId: message.id,
        pinned: message.pinned,
        ...rollbackPinMeta,
      });
    };
    try {
      const res = await fetchWithSessionGuard(
        `/api/team/channels/${channelId}/messages/${message.id}/pin`,
        { method: message.pinned ? "DELETE" : "POST" },
      );
      // Roll back to the prior value.
      if (!res.ok) rollback();
    } catch {
      rollback();
    }
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
    // Optimistic: splice the bubble immediately. No rollback path — if the
    // server rejects, we softly bounce by surfacing the toast; the next
    // refresh / reconnect will bring the row back.
    dispatchLocalSocketEvent("team:channel:message:deleted", {
      teamId: currentUser.teamId,
      channelId,
      messageId: message.id,
      threadRootId: isThreadReply ? message.threadRootId ?? null : null,
    });
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
    // Optimistic: update body + show (edited) label instantly. The real
    // socket frame arriving moments later carries the canonical editedAt.
    dispatchLocalSocketEvent("team:channel:message:edited", {
      teamId: currentUser.teamId,
      channelId,
      messageId: message.id,
      body: next,
      editedAt: new Date().toISOString(),
    });
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
      else {
        // Roll back to the pre-edit body.
        dispatchLocalSocketEvent("team:channel:message:edited", {
          teamId: currentUser.teamId,
          channelId,
          messageId: message.id,
          body: message.body,
          editedAt: message.editedAt ?? new Date().toISOString(),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      // Marker for jump-to-message — search results scroll to this attribute.
      // Pending messages don't have a real id yet, so we use the clientTempId
      // (which still uniquely identifies the row while it's optimistic).
      data-message-id={message.id}
      className={cn(
        "group relative flex gap-3 px-4 transition-colors hover:bg-muted/40",
        isContinuation ? "py-0.5" : "py-1.5",
        message.pinned && !isThreadReply && "bg-warning-bg/30",
        message.failed && "bg-destructive/10",
      )}
    >
      {isContinuation ? (
        // Spacer holding the avatar column, with the timestamp revealed on
        // hover — the Slack/Discord affordance that keeps a grouped run
        // scannable without repeating the header on every line.
        //
        // `text-3xs leading-relaxed whitespace-nowrap` is load-bearing, not
        // decoration: without it the 10px timestamp wrapped to two lines
        // inside the 36px gutter AND each line box was inflated to the 16px
        // root strut (24px), so an INVISIBLE (opacity-0) hover label forced
        // every grouped row to 54px instead of ~28px. That was the phantom
        // gap between consecutive messages. Setting the font size on the
        // block (not just the inline label) is what shrinks the strut.
        <div className="w-9 shrink-0 select-none whitespace-nowrap pt-1 text-right text-3xs leading-relaxed">
          <LocalTime
            iso={message.createdAt}
            format="messageTime"
            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          />
        </div>
      ) : (
        <Avatar className="mt-0.5 size-9 shrink-0">
          {message.authorAvatarUrl ? (
            <AvatarImage src={message.authorAvatarUrl} alt={authorName} />
          ) : null}
          <AvatarFallback seed={authorName} className="text-xs">{initials(authorName)}</AvatarFallback>
        </Avatar>
      )}

      {/* `text-sm leading-relaxed` on the COLUMN, not just on the body span:
          a block's line boxes are floored by its own strut, so leaving the
          column at the 16px/24px root made every text line 24px tall. */}
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        <div className={cn("flex min-w-0 items-baseline gap-1", isContinuation && "hidden")}>
          <span className="min-w-0 truncate text-sm font-semibold">{authorName}</span>
          <LocalTime
            iso={message.createdAt}
            format="messageTime"
            className="shrink-0 text-2xs text-muted-foreground"
          />
          {message.pinned && !isThreadReply && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Pin className="size-3 text-warning-fg" />
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
          <div className={isContinuation ? undefined : "mt-0.5"}>
            <BodyRenderer
              body={message.body}
              highlightUserId={currentUser.id}
              searchQuery={searchQuery}
              displayNameById={displayNameById}
            />
            {/* Slack-style trailing "(edited)". It lives next to the BODY, not
                in the author header — the header is suppressed on grouped
                (continuation) rows, so editing one of those showed no marker
                at all. Inline also reads better: the label belongs to the
                text that changed. */}
            {message.editedAt && (
              <span className="ml-1 align-baseline text-2xs text-muted-foreground">
                (edited)
              </span>
            )}
            {message.media && <MediaAttachment media={message.media} />}
          </div>
        )}

        {message.reactions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-0.5">
            {message.reactions.map((r) => {
              const mine = r.userIds.includes(currentUser.id);
              return (
                <Tooltip key={r.emoji}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => void toggleReaction(r.emoji)}
                      className={cn(
                        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                        mine
                          ? "border-primary/70 bg-primary/20 text-primary"
                          : "border-border bg-muted/70 hover:border-primary/40 hover:bg-accent",
                      )}
                    >
                      <span className="text-sm leading-none">{r.emoji}</span>
                      <span className="font-medium">{r.userIds.length}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {describeReactors(
                      r.userIds,
                      currentUser.id,
                      displayNameById,
                      r.emoji,
                    )}
                  </TooltipContent>
                </Tooltip>
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
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-destructive">
            <span className="inline-flex items-center gap-1">
              <X className="size-3" />
              Failed to send.
            </span>
            {/* Retry re-POSTs the same body + clientTempId (text-only — a
                failed media send can't be retried, its bytes are gone). Dismiss
                drops the optimistic row so its text isn't lost to a dead
                bubble with no affordance (L7). `hasOptimisticMedia` is the
                client-only marker the composer stamps on a media send (the
                optimistic row never carries a real `media` object), so we hide
                Retry for failed media — only Dismiss shows. */}
            {message.clientTempId &&
              onRetry &&
              !(message as { hasOptimisticMedia?: boolean }).hasOptimisticMedia && (
              <button
                type="button"
                onClick={() => onRetry(message.clientTempId!)}
                className="font-medium underline underline-offset-2 hover:no-underline"
              >
                Retry
              </button>
            )}
            {message.clientTempId && onDismiss && (
              <button
                type="button"
                onClick={() => onDismiss(message.clientTempId!)}
                className="font-medium text-muted-foreground underline underline-offset-2 hover:no-underline"
              >
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>

      {!editing && !message.pending && !message.failed && (
        <div
          className="absolute -top-3 right-4 flex items-center gap-0.5 rounded-md border border-border bg-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"
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
                aria-label="Add reaction"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9"
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
                  aria-label="Reply in thread"
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9"
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
                aria-label="More actions"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9"
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
                    className="text-destructive focus:text-destructive"
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
      prev.isContinuation === next.isContinuation &&
      prev.onOpenThread === next.onOpenThread &&
      prev.onRetry === next.onRetry &&
      prev.onDismiss === next.onDismiss &&
      prev.searchQuery === next.searchQuery &&
      prev.displayNameById === next.displayNameById
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
      prev.isContinuation !== next.isContinuation ||
      prev.onOpenThread !== next.onOpenThread ||
      prev.onRetry !== next.onRetry ||
      prev.onDismiss !== next.onDismiss ||
      prev.searchQuery !== next.searchQuery ||
      prev.displayNameById !== next.displayNameById
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
    // Fixed-aspect slot: reserve height BEFORE the bytes decode so the
    // bubble doesn't push every later message down on load. Mirrors the
    // inbox `media-blocks.tsx` pattern (CLAUDE.md "Image bubble flicker"
    // — same bug class, team-chat was missed). w-72/aspect-4/3 covers the
    // common phone-photo + screenshot proportions; very tall portraits
    // are letterboxed by object-contain. No flash because the slot's
    // dimensions don't depend on the image.
    return (
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        className="relative mt-1.5 block aspect-4/3 w-72 max-w-full overflow-hidden rounded-lg border border-border bg-muted/30"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media.url}
          alt={media.caption ?? media.filename ?? "attachment"}
          decoding="async"
          className="absolute inset-0 size-full object-contain"
        />
      </a>
    );
  }
  if (media.kind === "video") {
    // Same reserved-slot reasoning as image. `preload="metadata"` still
    // hints at the codec for the controls — only the box dimensions are
    // pinned, not the file fetch.
    return (
      <div className="mt-1.5 aspect-video w-80 max-w-full overflow-hidden rounded-lg border border-border bg-muted/30">
        <video
          controls
          preload="metadata"
          className="size-full"
        >
          <source src={media.url} type={media.mimeType} />
        </video>
      </div>
    );
  }
  if (media.kind === "audio") {
    // Audio controls have a fixed height in every browser, so a min-height
    // reservation is enough to keep scroll stable while metadata loads.
    return (
      <audio
        controls
        preload="metadata"
        className="mt-1.5 block h-10 w-full max-w-sm"
      >
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
