"use client";

import { AlertCircle, Check, CheckCheck, Clock } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useTimezone } from "@/providers/tz-provider";
import { cn, formatLocaleString, initials } from "@ccp/shared/utils";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import type { Message } from "@ccp/shared/types";

export function BubbleMeta({
  message,
  isOut,
}: {
  message: Message;
  isOut: boolean;
}) {
  // Provider failure reason — only on a failed outbound send that carried a
  // Meta `errors[0]`. Surfaced ONCE, via the AlertCircle tooltip in StatusTicks
  // (plus the bubble's red ring + the FailedRecovery Retry/Dismiss row); no
  // redundant muted line below the meta row.
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
          "flex min-w-0 items-center gap-2 px-1 text-3xs text-muted-foreground",
          isOut ? "flex-row-reverse" : "flex-row",
        )}
      >
        <span title={fullDateTime}>
          <LocalTime iso={message.timestamp} format="messageTime" />
        </span>
        {/* Sender attribution moved to the GROUP HEAD (see MessageBubble's
            SenderChip header) so "which teammate" is answered at the top of a
            burst, not buried under its last bubble. The tail keeps time + ticks. */}
        {isOut && <StatusTicks message={message} reason={failureReason} />}
      </div>
    </div>
  );
}

/**
 * Inline sender pill: tiny avatar + name. Sits in the meta row beneath the
 * bubble so the same teammate's sends are scannable down a thread that's
 * shared between multiple agents. Falls back to initials when no avatarUrl
 * is set so the slot doesn't collapse.
 */
export function SenderChip({
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
        <AvatarFallback className="text-4xs">{initials(name)}</AvatarFallback>
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
      // `title` must sit on an HTML element — a bare <svg> ignores the global
      // title attribute, so the Meta rejection reason (e.g. 24h-window 131047)
      // was invisible on hover. Wrap in a <span> so sighted agents get the why.
      return reason ? (
        <span title={reason} className="inline-flex">
          <AlertCircle
            className="size-3 text-destructive"
            aria-label={`Failed to send: ${reason}`}
          />
        </span>
      ) : (
        <AlertCircle className="size-3 text-destructive" aria-label="Failed to send" />
      );
    case "sent":
      // A channel with NO delivery receipt (Instagram) never reports
      // "delivered", so a sent message would otherwise sit on a lone single
      // tick until it's read. It reached Meta and there's no pre-read signal
      // coming, so render it as delivered (two muted ticks) — matching the
      // native IG "Sent → Seen" flow instead of looking stuck.
      if (CHANNEL_CAPABILITIES[message.channel]?.deliveryReceipts === false) {
        return (
          <CheckCheck className="size-3 opacity-70" strokeWidth={2} aria-label="Sent" />
        );
      }
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
