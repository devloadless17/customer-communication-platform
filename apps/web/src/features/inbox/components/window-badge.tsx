"use client";

import { Clock, AlertTriangle, Lock, MessageSquareDashed } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import {
  computeWindowStatus,
  effectiveSendWindowMs,
  formatWindowRemaining,
  windowStateLabel,
  type WindowStatus,
} from "@ccp/shared/utils/window";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import type { Channel } from "@ccp/shared/types";
import { useNow } from "@/hooks/use-now";

/**
 * Visual status of a channel's free-form messaging window (WhatsApp 24h; Meta
 * social 24h + a 7-day human-agent window). Used in two places: above the reply
 * composer and as a chip on contact-list rows.
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
  channel,
  size = "sm",
  className,
}: {
  lastInboundAt: string | null;
  /** The contact's channel — drives the window length: WhatsApp 24h, Meta social
   *  24h + a 7-day human-agent band. Omit ⇒ the 24h default (back-compat). Without
   *  this a social contact between 24h and 7d was wrongly shown "window closed"
   *  while the composer (channel-aware) still sends. */
  channel?: Channel;
  size?: "xs" | "sm";
  className?: string;
}) {
  // Shared "now" — initialized to the server's clock on SSR (see
  // TimezoneProvider) so the rendered string is identical on both sides of
  // hydration. No "Window closed" → "Window closed · 42h ago" flash.
  const now = useNow();
  // Match the reply composer: derive the window length from the channel's
  // capability so social threads reflect the full 7-day human-agent window.
  // A NULL capability means the channel has NO window (webchat widget) — render
  // nothing rather than letting the 24h default paint a false "Window closed"
  // lock in the contacts list, contact drawer and browser rows.
  const caps = channel ? CHANNEL_CAPABILITIES[channel] : null;
  if (caps && effectiveSendWindowMs(caps) === null) return null;
  const windowMs = caps ? effectiveSendWindowMs(caps) ?? undefined : undefined;
  const status = computeWindowStatus(lastInboundAt, now, windowMs);
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

  // Channel-neutral copy: WhatsApp is a 24h window, Meta social is 24h + a
  // 7-day human-agent window — the badge derives the countdown from the
  // channel's capability, so the wording stays generic ("messaging window").
  const title =
    state === "never"
      ? "This contact hasn't messaged you yet."
      : state === "closed"
        ? `The messaging window has closed — a new customer message reopens it. ${formatWindowRemaining(status)}.`
        : `The messaging window is ${state === "open" ? "open" : "closing soon"}. ${formatWindowRemaining(status)}.`;

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
      {/* At the dense xs size (contact row) the tone + icon already encode the
          state and the full label lives in the title tooltip — so drop the word
          and the middot, keeping just icon + remaining time. */}
      {size === "xs" ? (
        <span className="truncate opacity-80">{formatWindowRemaining(status)}</span>
      ) : (
        <>
          <span className="shrink-0 font-medium">{windowStateLabel(state)}</span>
          <span className="truncate opacity-80">· {formatWindowRemaining(status)}</span>
        </>
      )}
    </span>
  );
}
