"use client";

import { AlertCircle, Check, CheckCheck, Clock } from "lucide-react";

import { cn, formatMessageTime } from "@/lib/utils";
import type { Message, User } from "@/lib/types";

export function BubbleMeta({
  message,
  sender,
  isOut,
}: {
  message: Message;
  sender: User | null;
  isOut: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground",
        isOut ? "flex-row-reverse" : "flex-row",
      )}
    >
      <span suppressHydrationWarning>{formatMessageTime(message.timestamp)}</span>
      {isOut && sender && (
        <>
          <span className="opacity-50">·</span>
          <span>via @{sender.name}</span>
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
