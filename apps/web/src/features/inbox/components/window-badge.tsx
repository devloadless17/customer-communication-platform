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
 *   - Three visual variants pick the same colors as message status pills,
 *     so this fits the existing palette without new tokens.
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
  // Shared 60s tick across the inbox — see hooks/use-now.ts. `now` is null
  // until after mount so SSR/client first renders agree on the static label;
  // the time suffix appears on the next commit.
  const now = useNow();
  const status = computeWindowStatus(lastInboundAt, now ?? Date.now());
  return (
    <WindowBadgeFromStatus
      status={status}
      size={size}
      className={className}
      hideRemaining={now === null}
    />
  );
}

export function WindowBadgeFromStatus({
  status,
  size = "sm",
  className,
  hideRemaining = false,
}: {
  status: WindowStatus;
  size?: "xs" | "sm";
  className?: string;
  // When true, omit the "· 8h left" suffix and the time-aware title. Used by
  // WindowBadge on the first render to keep SSR output deterministic.
  hideRemaining?: boolean;
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
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : state === "closing-soon"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : state === "closed"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-muted/40 text-muted-foreground";

  const sizing =
    size === "xs" ? "h-5 px-1.5 text-[10px]" : "h-6 px-2 text-[11px]";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border tabular-nums",
        sizing,
        tone,
        className,
      )}
      title={
        state === "never"
          ? "This contact hasn't messaged you yet — only templates can be sent."
          : state === "closed"
            ? hideRemaining
              ? "Free-form replies require a customer message in the last 24h."
              : `Free-form replies require a customer message in the last 24h. ${formatWindowRemaining(status)}.`
            : hideRemaining
              ? `The 24h customer service window is ${state === "open" ? "open" : "closing soon"}.`
              : `The 24h customer service window is ${state === "open" ? "open" : "closing soon"}. ${formatWindowRemaining(status)}.`
      }
    >
      <Icon className={size === "xs" ? "size-3" : "size-3.5"} />
      <span className="font-medium">{windowStateLabel(state)}</span>
      {!hideRemaining && (
        <span className="opacity-80" suppressHydrationWarning>
          · {formatWindowRemaining(status)}
        </span>
      )}
    </span>
  );
}
