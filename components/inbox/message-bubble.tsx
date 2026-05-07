"use client";

import { Check, CheckCheck, AlertCircle } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn, formatMessageTime, initials } from "@/lib/utils";
import type { Message, User } from "@/lib/types";

export function MessageBubble({
  message,
  sender,
  contactName,
}: {
  message: Message;
  /** null on inbound — only outbound has an authoring agent. */
  sender: User | null;
  contactName: string;
}) {
  const isOut = message.direction === "out";

  return (
    <div className={cn("flex w-full gap-2", isOut ? "justify-end" : "justify-start")}>
      {!isOut && (
        <Avatar className="size-7 shrink-0 self-end">
          <AvatarFallback className="text-[10px]">{initials(contactName)}</AvatarFallback>
        </Avatar>
      )}

      <div className={cn("flex max-w-[70%] flex-col gap-0.5", isOut ? "items-end" : "items-start")}>
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-xs ring-1 transition-colors",
            isOut
              ? "rounded-br-sm bg-outbound-bg text-outbound-fg ring-transparent"
              : "rounded-bl-sm bg-inbound-bg text-inbound-fg ring-border",
          )}
        >
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        </div>

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
              <span>via @{sender.name.split(" ")[0]?.toLowerCase()}</span>
            </>
          )}
          {isOut && <StatusTicks status={message.status} />}
        </div>
      </div>
    </div>
  );
}

function StatusTicks({ status }: { status: Message["status"] }) {
  if (status === "failed") {
    return <AlertCircle className="size-3 text-destructive" aria-label="Failed to send" />;
  }
  if (status === "sent") {
    return <Check className="size-3 opacity-70" aria-label="Sent" />;
  }
  if (status === "delivered") {
    return <CheckCheck className="size-3 opacity-70" aria-label="Delivered" />;
  }
  return <CheckCheck className="size-3 text-primary" aria-label="Read" />;
}
