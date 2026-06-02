"use client";

import {
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
} from "lucide-react";

import type { CallSnapshot } from "@ccp/shared/types";

/**
 * Inline call entry in the thread timeline. Same visual idiom as the
 * activity pills (assignment / status / stage / tag changes) so it sorts
 * cleanly into the mixed-content timeline.
 *
 * Copy is direction-aware: an inbound missed call reads "Missed call from
 * customer" while a no-answer outbound reads "Customer didn't answer." A
 * completed call shows just direction + duration ("Call · 1:23"); ringing
 * shows nothing terminal (it's still ongoing).
 */
export function CallBubble({ call }: { call: CallSnapshot }) {
  const isInbound = call.direction === "in";

  let Icon = Phone;
  let label: string;
  let tone: "neutral" | "info" | "warn" | "danger" = "neutral";

  switch (call.status) {
    case "ringing":
    case "in_progress":
      Icon = PhoneCall;
      label = isInbound ? "Incoming call" : "Outgoing call";
      tone = "info";
      break;
    case "missed":
      // PhoneMissed reads as "inbound missed" visually (the downward arrow).
      // Outbound no-answer uses PhoneOutgoing to keep the direction signal
      // consistent with the copy ("Customer didn't answer").
      Icon = isInbound ? PhoneMissed : PhoneOutgoing;
      label = isInbound ? "Missed call from customer" : "Customer didn't answer";
      tone = "warn";
      break;
    case "rejected":
      Icon = PhoneOff;
      label = isInbound ? "Call declined" : "Customer declined the call";
      tone = "danger";
      break;
    case "failed":
      Icon = PhoneOff;
      label = "Call couldn't connect";
      tone = "danger";
      break;
    case "completed":
    default: {
      // "Connected" = a real two-way call actually happened. answeredAt is the
      // primary signal (the server stamps it from the provider's real pickup
      // time — Meta's terminate `start_time`). durationSeconds>0 is the backstop
      // for the live socket path, where the `call:ended` frame carries the real
      // duration but not answeredAt. A terminal "completed" with NEITHER means
      // nobody picked up — Meta reports unanswered business-initiated calls as
      // status:COMPLETED, so a completed row is NOT proof of a connection.
      const connected =
        call.answeredAt !== null ||
        (call.durationSeconds !== null && call.durationSeconds > 0);
      if (!connected) {
        Icon = isInbound ? PhoneMissed : PhoneOutgoing;
        label = isInbound ? "Missed call from customer" : "Customer didn't answer";
        tone = "warn";
      } else {
        // Direction-aware icon pair for clarity at-a-glance: inbound arrow vs
        // outbound arrow rather than a neutral handset for one side.
        Icon = isInbound ? PhoneIncoming : PhoneOutgoing;
        label = isInbound ? "Incoming call" : "Outgoing call";
        tone = "neutral";
      }
      break;
    }
  }

  const tones = {
    neutral:
      "border-border bg-muted/40 text-muted-foreground",
    info:
      "border-sky-300/50 bg-sky-50 text-sky-900 dark:border-sky-700/40 dark:bg-sky-900/20 dark:text-sky-200",
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
