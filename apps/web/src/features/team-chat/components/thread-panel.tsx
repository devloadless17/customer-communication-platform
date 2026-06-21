"use client";

import { useMemo } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useThreadEvents } from "@/features/team-chat/hooks/use-thread-events";
import { toast } from "@/lib/toast";
import { canDeleteMessage } from "@ccp/shared/team-chat/permissions";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";
import type { User } from "@ccp/shared/types";

import { ChannelComposer } from "./channel-composer";
import { ChannelMessage } from "./channel-message";
import { TypingIndicator } from "./typing-indicator";

/**
 * Right-side panel showing the root message + all of its replies +
 * a dedicated composer scoped to the thread.
 */
export function ThreadPanel({
  channelId,
  channelName,
  rootMessage,
  currentUser,
  teamMembers,
  canPin,
  onClose,
}: {
  channelId: string;
  channelName: string;
  rootMessage: TeamChannelMessageDto;
  currentUser: User;
  teamMembers: User[];
  canPin: boolean;
  onClose: () => void;
}) {
  const {
    replies,
    loading,
    hasMore,
    loadingMore,
    loadMore,
    addOptimistic,
    markOptimisticFailed,
    removeOptimistic,
    retryOptimistic,
    typingUserIds,
  } = useThreadEvents(channelId, rootMessage.id, () => {
    // Root deleted out from under us — close the panel so the user isn't
    // stuck replying into a dead thread (those replies 404).
    toast.info("This thread was deleted");
    onClose();
  });

  // Tiny lookup so the indicator can render names without a parent prop.
  const namesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of teamMembers) map.set(u.id, u.name);
    return map;
  }, [teamMembers]);

  return (
    // Below xl the panel OVERLAYS the feed (absolute, right-docked, shadowed)
    // so it never squeezes the message column to an unusable width on tablet /
    // mobile — and crucially keeps the overlay through 1024–1279px, where an
    // in-flow 24rem column would starve the feed. At xl+ it's an in-flow 24rem
    // column beside the feed. Single mount either way (it owns a fetch + socket
    // subscriptions), so this is pure CSS — no media-query remount. The
    // workspace root is `relative` to anchor it.
    <aside className="absolute inset-y-0 right-0 z-20 flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-xl xl:static xl:z-auto xl:w-[24rem] xl:max-w-none xl:bg-card/30 xl:shadow-none xl:shrink-0">
      <div className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div>
          <div className="text-sm font-semibold">Thread</div>
          <div className="truncate text-2xs text-muted-foreground">
            in #{channelName}
          </div>
        </div>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close thread">
          <X className="size-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col py-1">
          {/* Root message anchors the thread — same bubble component, with
              thread actions hidden. */}
          <ChannelMessage
            message={rootMessage}
            channelId={channelId}
            currentUser={currentUser}
            canPin={canPin}
            canDelete={canDeleteMessage(currentUser.role, rootMessage.authorUserId, currentUser.id)}
            isThreadReply={false}
            displayNameById={namesById}
          />
          <div className="my-2 flex items-center gap-2 px-4">
            <div className="h-px flex-1 bg-border" />
            <span className="text-2xs uppercase tracking-wider text-muted-foreground">
              {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
          {loading && replies.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">Loading replies…</div>
          ) : (
            <>
              {replies.map((m) => (
                <ChannelMessage
                  key={m.id}
                  message={m}
                  channelId={channelId}
                  currentUser={currentUser}
                  canPin={false}
                  canDelete={canDeleteMessage(currentUser.role, m.authorUserId, currentUser.id)}
                  isThreadReply={true}
                  onRetry={retryOptimistic}
                  onDismiss={removeOptimistic}
                  displayNameById={namesById}
                />
              ))}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="mx-4 my-2 rounded-md border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load more replies"}
                </button>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      <div className="border-t border-border">
        <TypingIndicator
          userIds={typingUserIds}
          namesById={namesById}
          viewerUserId={currentUser.id}
        />
      </div>
      <ChannelComposer
        channelId={channelId}
        channelName={channelName}
        threadRootId={rootMessage.id}
        currentUser={currentUser}
        teamMembers={teamMembers}
        onOptimisticAdd={addOptimistic}
        onOptimisticFail={markOptimisticFailed}
        onOptimisticRemove={removeOptimistic}
      />
    </aside>
  );
}
