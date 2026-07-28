"use client";

import { useState } from "react";
import {
  AudioLines,
  FileText,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
} from "lucide-react";

import type { CallSnapshot } from "@ccp/shared/types";
import {
  RecordingPlayer,
  TranscriptPanel,
} from "@/features/calls/call-artifacts";

/**
 * Inline call entry in the thread timeline. Same visual idiom as the
 * activity pills (assignment / status / stage / tag changes) so it sorts
 * cleanly into the mixed-content timeline.
 *
 * Copy is direction-aware: an inbound missed call reads "Missed call from
 * customer" while a no-answer outbound reads "Customer didn't answer." A
 * completed call shows just direction + duration ("Call · 1:23"); ringing
 * shows nothing terminal (it's still ongoing).
 *
 * Attribution (like a message shows its sender): an OUTBOUND call names the
 * agent who placed it; an answered INBOUND call names the agent who picked up.
 * Names are resolved by the thread (from its team-member map) and passed in.
 */
export function CallBubble({
  call,
  initiatedByName,
  answeredByName,
}: {
  call: CallSnapshot;
  /** Agent who placed an outbound call (resolved from initiatedByUserId). */
  initiatedByName?: string | null;
  /** Agent who answered an inbound call (resolved from answeredByUserId). */
  answeredByName?: string | null;
}) {
  const isInbound = call.direction === "in";
  // A real two-way connection actually happened (see the `completed` case).
  const connected =
    call.answeredAt !== null ||
    (call.durationSeconds !== null && call.durationSeconds > 0);

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
      "border-info-border bg-info-bg text-info-fg",
    // Missed / no-answer calls — the warning semantic (negative but not the
    // harsh `destructive` red used for failed/declined).
    warn:
      "border-warning-border bg-warning-bg text-warning-fg",
    danger:
      "border-destructive/40 bg-destructive/10 text-destructive",
  } as const;

  // Outbound → the agent who placed it ("who called"). Inbound → only once
  // connected, the agent who picked up. An unanswered inbound has no agent.
  const actor = isInbound ? (connected ? answeredByName : null) : initiatedByName;

  // Call artifacts, revealed on demand right in the thread — agents shouldn't
  // have to leave the conversation to hear a call or read its (Arabic-RTL)
  // transcript. Optional fields: live-frame bubbles predate the artifacts,
  // which appear on the next thread hydrate ~1min after the call ends.
  const [openPanel, setOpenPanel] = useState<"recording" | "transcript" | null>(
    null,
  );
  const togglePanel = (panel: "recording" | "transcript") =>
    setOpenPanel((prev) => (prev === panel ? null : panel));

  return (
    <div className="flex flex-col items-center py-1.5">
      <div
        className={
          "inline-flex max-w-72 items-center gap-1.5 rounded-full border px-3 py-1 text-2xs " +
          tones[tone]
        }
      >
        <Icon className="size-3.5 shrink-0" />
        {actor && (
          <>
            <span className="min-w-0 truncate font-semibold">{actor}</span>
            <span className="shrink-0 opacity-50">·</span>
          </>
        )}
        <span className="shrink-0 whitespace-nowrap font-medium">{label}</span>
        {call.durationSeconds !== null && call.durationSeconds > 0 && (
          <span className="shrink-0 whitespace-nowrap opacity-70">· {formatDuration(call.durationSeconds)}</span>
        )}
        {/* WHY it failed, from the provider's terminate webhook (e.g. "Media
            receive timeout") — turns a generic failure into something the
            agent can act on or report. */}
        {call.status === "failed" && call.errorTitle && (
          <span className="min-w-0 truncate opacity-70">· {call.errorTitle}</span>
        )}
        {call.hasRecording && (
          <button
            type="button"
            title="Play recording"
            aria-label="Play recording"
            aria-pressed={openPanel === "recording"}
            onClick={() => togglePanel("recording")}
            className={
              "shrink-0 rounded-full p-0.5 transition-colors hover:bg-foreground/10 " +
              (openPanel === "recording" ? "text-primary" : "")
            }
          >
            <AudioLines className="size-3.5" />
          </button>
        )}
        {call.hasTranscript && (
          <button
            type="button"
            title={`Transcript${call.transcriptLanguage ? ` (${call.transcriptLanguage.toUpperCase()})` : ""}`}
            aria-label="Show transcript"
            aria-pressed={openPanel === "transcript"}
            onClick={() => togglePanel("transcript")}
            className={
              "shrink-0 rounded-full p-0.5 transition-colors hover:bg-foreground/10 " +
              (openPanel === "transcript" ? "text-primary" : "")
            }
          >
            <FileText className="size-3.5" />
          </button>
        )}
      </div>
      {openPanel === "recording" && (
        <div className="mt-1.5 w-full max-w-md">
          <RecordingPlayer callId={call.id} />
        </div>
      )}
      {openPanel === "transcript" && (
        <div className="mt-1.5 w-full max-w-md">
          <TranscriptPanel callId={call.id} />
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
