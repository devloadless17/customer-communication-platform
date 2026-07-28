"use client";

import { useEffect, useState } from "react";
import { Mic, MicOff, PhoneOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { LiveCallState } from "@/features/calls/hooks/use-call";
import { AccountLabel } from "@/features/channels/components/account-label";

/**
 * In-call overlay. Renders fixed bottom-right while a call is active.
 *
 * Three states:
 *   - ringing       — contact name + "Ringing…" + Hangup
 *   - in_progress   — contact name + duration + mute toggle + Hangup
 *   - ending        — disabled buttons, "Ending…"
 *
 * Stylistically a smaller, calmer version of the team-chat compose bar —
 * the user just clicked Answer or initiated; we don't want a full-screen
 * modal taking over their inbox.
 */
export function CallPanel({
  liveCall,
  error,
  onHangup,
  onSetMuted,
  isMuted,
}: {
  liveCall: LiveCallState | null;
  error: string | null;
  onHangup: () => void;
  onSetMuted: (muted: boolean) => void;
  isMuted: () => boolean;
}) {
  const [muted, setMutedState] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Tick once per second while we're in a call so the duration timer
  // updates. Pause when there's no call. Read the primitive fields (not the
  // whole `liveCall` object, whose identity churns as call state updates) so
  // the 1s interval only restarts on a real call/status change.
  const callId = liveCall?.callId;
  const callStatus = liveCall?.status;
  useEffect(() => {
    if (!callId || callStatus === "ending") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [callId, callStatus]);

  // Keep the muted UI in sync with the underlying stream state.
  useEffect(() => {
    setMutedState(isMuted());
  }, [callId, isMuted]);

  if (!liveCall) return null;

  const duration = liveCall.answeredAt
    ? Math.max(0, Math.floor((now - liveCall.answeredAt) / 1000))
    : 0;

  const handleMute = () => {
    const next = !muted;
    onSetMuted(next);
    setMutedState(next);
  };

  return (
    <div
      role="dialog"
      aria-label="Active call"
      className="fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-lg"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{liveCall.contactName}</div>
          <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <span className="shrink-0">
              {liveCall.status === "ringing" &&
                (liveCall.direction === "out" ? "Calling…" : "Incoming call…")}
              {liveCall.status === "in_progress" && formatDuration(duration)}
              {liveCall.status === "ending" && "Hanging up…"}
            </span>
            {/* WHICH of our numbers this call is on. Appended to the existing
                status line rather than added as a row, so the panel's height
                is identical on a single-account workspace (where this renders
                nothing at all). Until now the panel showed only the contact,
                so an agent mid-call could not tell which business they were
                representing. */}
            <AccountLabel
              channel={liveCall.channel ?? undefined}
              accountId={liveCall.accountId}
              variant="inline"
              verb={liveCall.direction === "out" ? "Calling from" : "Received on"}
            />
          </div>
        </div>
        <div
          aria-hidden
          className={
            "size-2 rounded-full " +
            (liveCall.status === "in_progress"
              ? "bg-emerald-500 animate-pulse"
              : liveCall.status === "ringing"
                ? "bg-amber-400 animate-pulse"
                : "bg-muted-foreground/40")
          }
        />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant={muted ? "secondary" : "outline"}
          size="sm"
          onClick={handleMute}
          disabled={liveCall.status !== "in_progress"}
          aria-pressed={muted}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          className="flex-1"
        >
          {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          <span className="ml-2">{muted ? "Unmute" : "Mute"}</span>
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onHangup}
          disabled={liveCall.status === "ending"}
          aria-label="End call"
          className="flex-1"
        >
          <PhoneOff className="size-4" />
          <span className="ml-2">End</span>
        </Button>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
