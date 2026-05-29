"use client";

import { Phone, PhoneIncoming, PhoneMissed, PhoneOff } from "lucide-react";

import type { CallSnapshot } from "@ccp/shared/types";

/**
 * Inline call entry in the thread timeline. Renders like the existing
 * activity pills (`assigned`, `status_changed`) so it slots into the
 * mixed-content timeline without a new visual idiom.
 *
 * Phase 2 (SIP + recording) will add a Play button when `recordingUrl`
 * is non-null — the bubble already plumbs the field through.
 */
export function CallBubble({ call }: { call: CallSnapshot }) {
  const status = call.status;
  const isInbound = call.direction === "in";

  let Icon = Phone;
  let label: string;
  let tone: "neutral" | "warn" | "danger" = "neutral";

  if (status === "missed") {
    Icon = PhoneMissed;
    label = isInbound ? "Missed call" : "No answer";
    tone = "warn";
  } else if (status === "rejected") {
    Icon = PhoneOff;
    label = isInbound ? "Call declined" : "Call rejected by customer";
    tone = "danger";
  } else if (status === "failed") {
    Icon = PhoneOff;
    label = "Call failed";
    tone = "danger";
  } else if (status === "completed") {
    Icon = isInbound ? PhoneIncoming : Phone;
    label = isInbound ? "Incoming call" : "Outgoing call";
  } else {
    Icon = isInbound ? PhoneIncoming : Phone;
    label = isInbound ? "Incoming call" : "Outgoing call";
  }

  const tones = {
    neutral:
      "border-border bg-muted/40 text-muted-foreground",
    warn:
      "border-amber-300/50 bg-amber-50 text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200",
    danger:
      "border-destructive/40 bg-destructive/10 text-destructive",
  } as const;

  return (
    <div className="flex items-center justify-center py-1.5">
      <div
        className={
          "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] " +
          tones[tone]
        }
      >
        <Icon className="size-3.5" />
        <span className="font-medium">{label}</span>
        {call.durationSeconds !== null && call.durationSeconds > 0 && (
          <span className="opacity-70">· {formatDuration(call.durationSeconds)}</span>
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
