"use client";

import { AlertCircle, Check, CheckCheck, Clock } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { cn } from "@ccp/shared/utils";
import type { Message } from "@ccp/shared/types";

export function BubbleMeta({
  message,
  senderName,
  isOut,
}: {
  message: Message;
  // Primitive — passing the whole User object made `MessageBubble`'s
  // React.memo shallow-equality miss whenever the team's User map identity
  // changed (e.g. a teammate's presence flipped). Now memo can short-circuit
  // unchanged bubbles even on team-roster updates.
  senderName: string | null;
  isOut: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground",
        isOut ? "flex-row-reverse" : "flex-row",
      )}
    >
      <LocalTime iso={message.timestamp} format="messageTime" />
      {isOut && senderName && (
        <>
          <span className="opacity-50">·</span>
          <span>via @{senderName}</span>
        </>
      )}
      {isOut && <StatusTicks message={message} />}
    </div>
  );
}

function StatusTicks({ message }: { message: Message }) {
  if (message.failed) {
    return <AlertCircle className="size-3 text-destructive" aria-label="Failed to send" />;
  }
  if (message.pending) {
    return <Clock className="size-3 opacity-60" aria-label="Sending…" />;
  }
  switch (message.status) {
    case "failed":
      return <AlertCircle className="size-3 text-destructive" aria-label="Failed to send" />;
    case "sent":
      return <Check className="size-3 opacity-70" aria-label="Sent" />;
    case "delivered":
      return <CheckCheck className="size-3 opacity-70" aria-label="Delivered" />;
    case "read":
      return <CheckCheck className="size-3 text-primary" aria-label="Read" />;
  }
}
