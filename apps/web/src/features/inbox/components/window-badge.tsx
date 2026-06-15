"use client";

import { Clock, AlertTriangle, Lock, MessageSquareDashed } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import {
  computeWindowStatus,
  formatWindowRemaining,
  windowStateLabel,
  type WindowStatus,
} from "@ccp/shared/utils/window";
import { useNow } from "@/hooks/use-now";

/**
 * Visual status of the WhatsApp 24h customer-service window. Used in two
 * places: above the reply composer and as a chip on contact-list rows.
 *
 *   - `lastInboundAt` is the source of truth; the badge re-derives state
 *     every minute via a tick so the "8h left" countdown moves without a
 *     refresh. We don't subscribe to second-level updates — the cost of an
 *     extra render every 60s is negligible and keeps the badge accurate.
 *
 *   - Tones route through the semantic status tokens (success / warning) plus
 *     destructive / muted, so the badge matches every other status pill and the
 *     token carries dark mode.
 */

export function WindowBadge({
  lastInboundAt,
  size = "sm",
  className,
}: {
  lastInboundAt: string | null;
  size?: "xs" | "sm";
  className?: string;
}) {
  // Shared "now" — initialized to the server's clock on SSR (see
  // TimezoneProvider) so the rendered string is identical on both sides of
  // hydration. No "Window closed" → "Window closed · 42h ago" flash.
  const now = useNow();
  const status = computeWindowStatus(lastInboundAt, now);
  return <WindowBadgeFromStatus status={status} size={size} className={className} />;
}

export function WindowBadgeFromStatus({
  status,
  size = "sm",
  className,
}: {
  status: WindowStatus;
  size?: "xs" | "sm";
  className?: string;
}) {
  const { state } = status;
  const Icon =
    state === "open"
      ? Clock
      : state === "closing-soon"
        ? AlertTriangle
        : state === "closed"
          ? Lock
          : MessageSquareDashed;

  const tone =
    state === "open"
      ? "border-success-border bg-success-bg text-success-fg"
      : state === "closing-soon"
        ? "border-warning-border bg-warning-bg text-warning-fg"
        : state === "closed"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-muted/40 text-muted-foreground";

  const sizing =
    size === "xs" ? "h-5 px-1.5 text-3xs" : "h-6 px-2 text-2xs";

  const title =
    state === "never"
      ? "This contact hasn't messaged you yet — only templates can be sent."
      : state === "closed"
        ? `Free-form replies require a customer message in the last 24h. ${formatWindowRemaining(status)}.`
        : `The 24h customer service window is ${state === "open" ? "open" : "closing soon"}. ${formatWindowRemaining(status)}.`;

  return (
    <span
      className={cn(
        // whitespace-nowrap: keep the label + relative time on ONE line. Without
        // it the text wraps inside a fixed-width lane (contacts row) or a tight
        // composer header, breaking row alignment.
        "inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap rounded-full border tabular-nums",
        sizing,
        tone,
        className,
      )}
      title={title}
    >
      <Icon className={cn("shrink-0", size === "xs" ? "size-3" : "size-3.5")} />
      <span className="shrink-0 font-medium">{windowStateLabel(state)}</span>
      <span className="truncate opacity-80">· {formatWindowRemaining(status)}</span>
    </span>
  );
}
