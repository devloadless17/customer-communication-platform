"use client";

import { useEffect, useRef } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { canDeleteMessage } from "@ccp/shared/team-chat/permissions";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";
import type { User } from "@ccp/shared/types";

import { ChannelMessage } from "./channel-message";

/**
 * Channel feed scroller. Stays naive on purpose — same trick `useChatScroll`
 * uses for the inbox: anchor to the bottom unless the user scrolled up, in
 * which case respect their position. For v0 the implementation is a simple
 * "scroll to bottom on length change" because the channel feed is shorter
 * than a customer thread; if "load older" gets used heavily, swap in the
 * full `useChatScroll` reused from the inbox.
 */
export function ChannelThread({
  messages,
  channelId,
  currentUser,
  canPin,
  onLoadOlder,
  hasMoreOlder,
  onOpenThread,
}: {
  messages: TeamChannelMessageDto[];
  channelId: string;
  currentUser: User;
  canPin: boolean;
  onLoadOlder: () => Promise<number>;
  hasMoreOlder: boolean;
  onOpenThread: (rootMessageId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastLength = useRef(messages.length);

  useEffect(() => {
    if (messages.length > lastLength.current) {
      const viewport = scrollRef.current?.querySelector<HTMLDivElement>(
        "[data-radix-scroll-area-viewport]",
      );
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    }
    lastLength.current = messages.length;
  }, [messages.length]);

  return (
    <ScrollArea ref={scrollRef} className="flex-1">
      <div className="flex flex-col py-2">
        {hasMoreOlder && (
          <button
            type="button"
            onClick={() => void onLoadOlder()}
            className="mx-auto my-2 rounded-md border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Load older messages
          </button>
        )}
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 px-8 py-16 text-center">
            <div className="text-sm font-medium">This is the start of the channel.</div>
            <div className="text-xs text-muted-foreground">
              Say hi to your team — they'll see it in real time.
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <ChannelMessage
              key={m.id}
              message={m}
              channelId={channelId}
              currentUser={currentUser}
              canPin={canPin}
              canDelete={canDeleteMessage(currentUser.role, m.authorUserId, currentUser.id)}
              isThreadReply={false}
              // Pass the parent's handler directly (stable reference) — the
              // memo wrapper on ChannelMessage only skips re-renders when
              // this prop's identity is stable. Prior `() => onOpenThread(m.id)`
              // was a fresh closure per row per parent render, which would
              // defeat the memo on every event.
              onOpenThread={onOpenThread}
            />
          ))
        )}
      </div>
    </ScrollArea>
  );
}
