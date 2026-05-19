"use client";

import { useMemo } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useThreadEvents } from "@/features/team-chat/hooks/use-thread-events";
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
    typingUserIds,
  } = useThreadEvents(channelId, rootMessage.id);

  // Tiny lookup so the indicator can render names without a parent prop.
  const namesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of teamMembers) map.set(u.id, u.name);
    return map;
  }, [teamMembers]);

  return (
    <aside className="flex h-full w-[24rem] shrink-0 flex-col border-l border-border bg-card/30">
      <div className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div>
          <div className="text-sm font-semibold">Thread</div>
          <div className="truncate text-[11px] text-muted-foreground">
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
          />
          <div className="my-2 flex items-center gap-2 px-4">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
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
