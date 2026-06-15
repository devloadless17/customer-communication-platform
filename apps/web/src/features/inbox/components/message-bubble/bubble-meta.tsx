"use client";

import { AlertCircle, Check, CheckCheck, Clock } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useTimezone } from "@/providers/tz-provider";
import { cn, formatLocaleString, initials } from "@ccp/shared/utils";
import type { Message } from "@ccp/shared/types";

export function BubbleMeta({
  message,
  senderName,
  senderAvatarUrl,
  isOut,
}: {
  message: Message;
  // Primitive — passing the whole User object made `MessageBubble`'s
  // React.memo shallow-equality miss whenever the team's User map identity
  // changed (e.g. a teammate's presence flipped). Now memo can short-circuit
  // unchanged bubbles even on team-roster updates.
  senderName: string | null;
  senderAvatarUrl: string | null;
  isOut: boolean;
}) {
  // Provider failure reason — only on a failed outbound send that carried a
  // Meta `errors[0]`. Rendered as a tooltip on the alert icon plus a subtle
  // muted line so the agent sees WHY a send failed, not just a red icon.
  const failureReason =
    isOut && message.status === "failed"
      ? message.statusErrorDetail ?? message.statusErrorTitle ?? null
      : null;

  // Full localized date+time for the time-hover tooltip — the meta row only
  // shows "h:mm AM", so hovering surfaces the exact day/year without a click.
  const tz = useTimezone();
  const fullDateTime = formatLocaleString(message.timestamp, tz);

  return (
    <div className={cn("flex flex-col gap-0.5", isOut ? "items-end" : "items-start")}>
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5 px-1 text-3xs text-muted-foreground",
          isOut ? "flex-row-reverse" : "flex-row",
        )}
      >
        <span title={fullDateTime}>
          <LocalTime iso={message.timestamp} format="messageTime" />
        </span>
        {isOut && senderName && (
          <>
            <span className="opacity-50">·</span>
            <SenderChip name={senderName} avatarUrl={senderAvatarUrl} />
          </>
        )}
        {isOut && <StatusTicks message={message} reason={failureReason} />}
      </div>
      {failureReason && (
        <span className="px-1 text-3xs leading-tight text-destructive/80">
          {failureReason}
        </span>
      )}
    </div>
  );
}

/**
 * Inline sender pill: tiny avatar + name. Sits in the meta row beneath the
 * bubble so the same teammate's sends are scannable down a thread that's
 * shared between multiple agents. Falls back to initials when no avatarUrl
 * is set so the slot doesn't collapse.
 */
function SenderChip({
  name,
  avatarUrl,
}: {
  name: string;
  avatarUrl: string | null;
}) {
  return (
    <span className="inline-flex min-w-0 max-w-48 items-center gap-1">
      <Avatar className="size-3.5 shrink-0">
        {avatarUrl ? <AvatarImage src={avatarUrl} alt={name} /> : null}
        <AvatarFallback className="text-[7px]">{initials(name)}</AvatarFallback>
      </Avatar>
      <span className="truncate">{name}</span>
    </span>
  );
}

function StatusTicks({
  message,
  reason,
}: {
  message: Message;
  // Provider failure reason for the failed-status tooltip (native title);
  // null on the optimistic-failed path (no provider reason yet).
  reason?: string | null;
}) {
  if (message.failed) {
    return <AlertCircle className="size-3 text-destructive" aria-label="Failed to send" />;
  }
  if (message.pending) {
    return <Clock className="size-3 opacity-60" aria-label="Sending…" />;
  }
  switch (message.status) {
    case "failed":
      return (
        <AlertCircle
          className="size-3 text-destructive"
          aria-label={reason ? `Failed to send: ${reason}` : "Failed to send"}
          {...(reason ? { title: reason } : {})}
        />
      );
    case "sent":
      return <Check className="size-3 opacity-70" aria-label="Sent" />;
    case "delivered":
      // Thin, muted double-check. Differs from "read" by WEIGHT + opacity, not
      // hue alone, so it stays distinguishable for color-blind agents.
      return (
        <CheckCheck className="size-3 opacity-70" strokeWidth={2} aria-label="Delivered" />
      );
    case "read":
      // Read = full-opacity primary AND a heavier stroke, so it reads as "more
      // confirmed" than delivered even when the green/grey hue is imperceptible.
      return (
        <CheckCheck
          className="size-3 text-primary opacity-100"
          strokeWidth={3}
          aria-label="Read"
        />
      );
  }
}
