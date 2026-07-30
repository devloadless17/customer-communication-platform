"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AudioLines,
  FileText,
  Loader2,
  MessageSquare,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
} from "lucide-react";

import { cn } from "@ccp/shared/utils";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/local-time";
import { AccountLabel } from "@/features/channels/components/account-label";
import { RecordingPlayer, TranscriptPanel } from "@/features/calls/call-artifacts";
import type { Channel } from "@ccp/shared/types";

/**
 * ONE call-history row, rendered by both surfaces that show call history:
 * the team-wide Calls page and the contact panel's Calls tab (one customer).
 *
 * Same reasoning as `call-artifacts.tsx`, which this composes: two copies of
 * "what did this call mean" would drift the first time a status/tone rule
 * changed, and a call log that describes the same call two different ways is
 * worse than one that describes it in only one place.
 *
 * `compact` is the panel's variant: the contact's name and the open-chat link
 * are pure noise on a surface already scoped to that contact's thread.
 */

export interface CallHistoryRowData {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  status: "ringing" | "in_progress" | "completed" | "missed" | "rejected" | "failed";
  /** Agent who placed an outbound call (null for inbound). */
  initiatedByName: string | null;
  /** Agent who answered an inbound call (null if unanswered). */
  answeredByName: string | null;
  ringingAt: string;
  channel: Channel;
  durationSeconds: number | null;
  /** Did the two sides actually talk — "called" vs "missed". */
  connected: boolean;
  /** Opaque payload from the call button that produced an inbound call. */
  ctaPayload: string | null;
  /** Opaque payload from the wa.me/call deep link that produced it. */
  deeplinkPayload: string | null;
  hasRecording: boolean;
  hasTranscript: boolean;
  /** Auto-detected spoken language of the transcript (ISO 639, e.g. "ar"). */
  transcriptLanguage: string | null;
  /** Why a FAILED call failed, from the provider's terminate webhook. */
  errorTitle: string | null;
  /** WHICH of our accounts on the channel this call was on (the thread's). */
  accountId: string | null;
  /** That account named for a human — the Settings label, else the number. */
  accountName: string | null;
  /** Only meaningful on the team-wide page; absent in `compact` mode. */
  contactName?: string | null;
  contactPhone?: string | null;
}

type Tone = "neutral" | "good" | "warn" | "danger";

/** Direction + status → icon, one-line label, tone, and the attributed agent. */
export function describeCall(row: CallHistoryRowData): {
  Icon: typeof Phone;
  label: string;
  tone: Tone;
  actor: string | null;
} {
  const inbound = row.direction === "in";
  switch (row.status) {
    case "ringing":
    case "in_progress":
      return {
        Icon: inbound ? PhoneIncoming : PhoneOutgoing,
        label: inbound ? "Incoming call" : "Outgoing call",
        tone: "neutral",
        actor: inbound ? null : row.initiatedByName,
      };
    case "rejected":
      return {
        Icon: PhoneOff,
        label: inbound ? "Declined" : "Customer declined",
        tone: "danger",
        actor: inbound ? null : row.initiatedByName,
      };
    case "failed":
      return {
        Icon: PhoneOff,
        label: "Couldn't connect",
        tone: "danger",
        actor: inbound ? null : row.initiatedByName,
      };
    case "missed":
    case "completed":
    default:
      if (!row.connected) {
        return {
          Icon: inbound ? PhoneMissed : PhoneOutgoing,
          label: inbound ? "Missed call" : "No answer",
          tone: "warn",
          actor: inbound ? null : row.initiatedByName,
        };
      }
      return {
        Icon: inbound ? PhoneIncoming : PhoneOutgoing,
        label: inbound ? "Incoming call" : "Outgoing call",
        tone: "good",
        // Connected: outbound → who placed it; inbound → who answered.
        actor: inbound ? row.answeredByName : row.initiatedByName,
      };
  }
}

const TONE_RING: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-success-bg text-success-fg",
  warn: "bg-warning-bg text-warning-fg",
  danger: "bg-destructive/10 text-destructive",
};

export function formatCallDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function CallHistoryRow({
  row,
  first,
  canCall,
  calling,
  onCallBack,
  compact = false,
}: {
  row: CallHistoryRowData;
  /** Suppresses the top divider on the first row of a bordered list. */
  first: boolean;
  canCall: boolean;
  calling: boolean;
  onCallBack: () => void;
  /** Contact panel variant: no contact name, no open-chat link. */
  compact?: boolean;
}) {
  const { Icon, label, tone, actor } = describeCall(row);
  const name = row.contactName?.trim() || row.contactPhone || "Unknown contact";
  // Recording player / transcript panel, revealed on demand — nothing is
  // fetched until the agent asks for it.
  const [showPlayer, setShowPlayer] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  return (
    <li
      data-call-row=""
      className={cn(
        "flex flex-wrap items-center gap-3 transition-colors hover:bg-accent/40",
        compact ? "gap-2 px-2 py-2.5" : "px-4 py-3",
        !first && "border-t border-border",
      )}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full",
          compact ? "size-7" : "size-9",
          TONE_RING[tone],
        )}
      >
        <Icon className={compact ? "size-3.5" : "size-4"} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {compact ? (
            // The customer is already the subject of this panel — the CALL is
            // the headline here, so it gets the primary line instead.
            <span className="truncate text-sm font-medium">{label}</span>
          ) : (
            <>
              <span className="truncate text-sm font-medium">{name}</span>
              {row.contactPhone && row.contactName && (
                <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                  {row.contactPhone}
                </span>
              )}
            </>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {!compact && <span>{label}</span>}
          {actor && (
            <>
              {!compact && <span className="opacity-50">·</span>}
              <span className="font-medium text-foreground/70">{actor}</span>
            </>
          )}
          {row.durationSeconds !== null && row.durationSeconds > 0 && (
            <>
              {(actor || !compact) && <span className="opacity-50">·</span>}
              <span className="tabular-nums">
                {formatCallDuration(row.durationSeconds)}
              </span>
            </>
          )}
          {/* WHICH of our numbers. Renders only when the CHANNEL actually has
              more than one account — on a single-number workspace it is noise,
              and on a multi-number one two calls from the same customer to two
              different numbers were indistinguishable in this log.
              `fallbackName` keeps a since-disconnected account named rather
              than silently re-attributing the call. */}
          <AccountLabel
            channel={row.channel}
            accountId={row.accountId}
            fallbackName={row.accountName}
            variant="inline"
            verb="Received on"
          />
          {row.status === "failed" && row.errorTitle && (
            <>
              <span className="opacity-50">·</span>
              <span className="min-w-0 truncate">{row.errorTitle}</span>
            </>
          )}
          {/* Origin attribution: which call button / deep link produced this
              inbound call. The payload is the campaign's own opaque tag, so
              show it verbatim in the tooltip and keep the label generic. */}
          {(row.ctaPayload ?? row.deeplinkPayload) && (
            <>
              <span className="opacity-50">·</span>
              <span
                className="rounded bg-muted px-1 py-px text-2xs"
                title={row.ctaPayload ?? row.deeplinkPayload ?? undefined}
              >
                {row.ctaPayload ? "via call button" : "via call link"}
              </span>
            </>
          )}
        </div>
      </div>

      <LocalTime
        iso={row.ringingAt}
        format="listTime"
        className="shrink-0 text-2xs tabular-nums text-muted-foreground"
      />

      <div className="flex shrink-0 items-center gap-1">
        {row.hasRecording && (
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-8", showPlayer && "text-primary")}
            title="Play recording"
            aria-label="Play recording"
            aria-pressed={showPlayer}
            onClick={() => setShowPlayer((v) => !v)}
          >
            <AudioLines className="size-4" />
          </Button>
        )}
        {row.hasTranscript && (
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-8", showTranscript && "text-primary")}
            title={`Transcript${row.transcriptLanguage ? ` (${row.transcriptLanguage.toUpperCase()})` : ""}`}
            aria-label="Show transcript"
            aria-pressed={showTranscript}
            onClick={() => setShowTranscript((v) => !v)}
          >
            <FileText className="size-4" />
          </Button>
        )}
        {!compact && (
          <Button asChild variant="ghost" size="icon" title="Open chat" className="size-8">
            <Link href={`/inbox?c=${row.conversationId}`} aria-label="Open chat">
              <MessageSquare className="size-4" />
            </Link>
          </Button>
        )}
        {canCall && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Call back"
            aria-label="Call back"
            disabled={calling}
            onClick={onCallBack}
          >
            {calling ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Phone className="size-4" />
            )}
          </Button>
        )}
      </div>

      {showPlayer && (
        <div className={cn("basis-full", compact ? "pl-9" : "pl-12")}>
          <RecordingPlayer callId={row.id} />
        </div>
      )}

      {showTranscript && (
        <div className={cn("basis-full", compact ? "pl-9" : "pl-12")}>
          <TranscriptPanel callId={row.id} />
        </div>
      )}
    </li>
  );
}
