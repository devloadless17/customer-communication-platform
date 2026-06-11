"use client";

import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { initials } from "@ccp/shared/utils";
import { getClientSocket } from "@/lib/socket-client";
import { notificationSound } from "@/lib/notifications/notification-sound";
import { useNotificationSounds } from "@/providers/notification-sound-provider";

/**
 * Team-wide incoming-call toast. Subscribes to `call:incoming` (team-room)
 * and renders a stack of dismissible cards bottom-right. Whichever agent
 * clicks Answer first wins; everyone else's toast dismisses via
 * `call:answered` / `call:ended`.
 *
 * Mounted at the InboxShell level so it survives chat switches and renders
 * across every inbox page.
 */
interface IncomingCall {
  callId: string;
  conversationId: string;
  contactName: string;
  ringingAt: string;
}

export function IncomingCallToast({
  canReceiveCalls,
  onAnswer,
  onReject,
}: {
  /** Resolved `calls:receive` capability. When false the toast never renders
   *  and never rings — a role scoped OUT of calling shouldn't be interrupted
   *  by inbound calls it can't answer (the API already 403s answer/reject). */
  canReceiveCalls: boolean;
  /** Called when the user clicks Answer — wires up the peer connection. */
  onAnswer: (callId: string, contactName: string, conversationId: string) => void;
  /** Called when the user clicks Decline. */
  onReject: (callId: string) => void;
}) {
  const [calls, setCalls] = useState<IncomingCall[]>([]);
  // Per-card auto-expire timers. Without this, a missed terminal frame
  // (call:answered/call:ended dropped during a socket blip or throttled tab)
  // would leave a phantom "is calling you" card on screen forever. Meta stops
  // ringing well before 60s, so the card self-dismisses then.
  const expiryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const RING_EXPIRY_MS = 60_000;

  // Device opt-out: when this PC has "receive calls" off, ignore incoming calls
  // entirely (no card, no ring). Read via a ref so toggling doesn't churn the
  // socket subscription below; the team still rings on everyone else's devices.
  const { receiveCalls } = useNotificationSounds();
  const receiveCallsRef = useRef(receiveCalls);
  receiveCallsRef.current = receiveCalls;

  // Capability gate (admin-configured role permission), kept in a ref for the
  // same reason as the device opt-out: toggling shouldn't churn the socket
  // subscription. A role without `calls:receive` gets no card and no ring.
  const canReceiveCallsRef = useRef(canReceiveCalls);
  canReceiveCallsRef.current = canReceiveCalls;

  useEffect(() => {
    const socket = getClientSocket();
    const timers = expiryTimers.current;

    const drop = (callId: string) => {
      notificationSound.stopCallRing(callId);
      setCalls((prev) => prev.filter((c) => c.callId !== callId));
      const t = timers.get(callId);
      if (t) {
        clearTimeout(t);
        timers.delete(callId);
      }
    };

    const onIncoming = (payload: {
      callId: string;
      conversationId: string;
      contactName: string;
      ringingAt: string;
    }) => {
      // Role isn't allowed to receive calls (admin scoped it out) — drop
      // silently. answer/reject are API-gated anyway; this stops the
      // misleading ring + "is calling you" card for a call they can't take.
      if (!canReceiveCallsRef.current) return;
      // This device opted out of receiving calls — drop it silently. Teammates
      // who keep it on still get the popup + ring.
      if (!receiveCallsRef.current) return;
      setCalls((prev) => {
        if (prev.some((c) => c.callId === payload.callId)) return prev;
        return [
          ...prev,
          {
            callId: payload.callId,
            conversationId: payload.conversationId,
            contactName: payload.contactName,
            ringingAt: payload.ringingAt,
          },
        ];
      });
      if (!timers.has(payload.callId)) {
        timers.set(
          payload.callId,
          setTimeout(() => drop(payload.callId), RING_EXPIRY_MS),
        );
      }
      // Audible ring (if call sounds are on). Ref-counted by callId in the
      // engine — simultaneous calls share one ring; stopped in drop() (which
      // covers answered / ended / 60s-expiry) and in the effect cleanup.
      notificationSound.startCallRing(payload.callId);
    };

    const onAnswered = (payload: { callId: string }) => drop(payload.callId);
    const onEnded = (payload: { callId: string }) => drop(payload.callId);

    socket.on("call:incoming", onIncoming);
    socket.on("call:answered", onAnswered);
    socket.on("call:ended", onEnded);
    return () => {
      socket.off("call:incoming", onIncoming);
      socket.off("call:answered", onAnswered);
      socket.off("call:ended", onEnded);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      notificationSound.stopAllCallRings();
    };
  }, []);

  if (calls.length === 0) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed bottom-4 left-4 z-50 flex flex-col gap-2"
    >
      {calls.map((call) => (
        <IncomingCallCard
          key={call.callId}
          call={call}
          onAnswer={() => {
            // Optimistic dismiss — the answer flow will replace it with the
            // CallPanel. Multiple-clicks safe because answer is idempotent
            // server-side (CAS); failed answer (already_answered) re-emits
            // the right state.
            setCalls((prev) => prev.filter((c) => c.callId !== call.callId));
            onAnswer(call.callId, call.contactName, call.conversationId);
          }}
          onReject={() => {
            setCalls((prev) => prev.filter((c) => c.callId !== call.callId));
            onReject(call.callId);
          }}
        />
      ))}
    </div>
  );
}

function IncomingCallCard({
  call,
  onAnswer,
  onReject,
}: {
  call: IncomingCall;
  onAnswer: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex w-72 items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-lg">
      <Avatar className="size-9">
        <AvatarFallback
          className="text-xs text-white"
          style={{ backgroundImage: avatarGradient(call.callId) }}
        >
          {initials(call.contactName)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{call.contactName}</div>
        <div className="text-xs text-muted-foreground">is calling you on WhatsApp</div>
      </div>
      <Button
        size="icon"
        variant="destructive"
        onClick={onReject}
        aria-label="Decline call"
        className="size-8"
      >
        <PhoneOff className="size-4" />
      </Button>
      <Button
        size="icon"
        onClick={onAnswer}
        aria-label="Answer call"
        className="size-8 bg-emerald-600 text-white hover:bg-emerald-700"
      >
        <Phone className="size-4" />
      </Button>
    </div>
  );
}
