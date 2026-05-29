"use client";

import { useEffect, useState } from "react";
import { Phone, PhoneOff } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { initials } from "@ccp/shared/utils";
import { getClientSocket } from "@/lib/socket-client";

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
  onAnswer,
  onReject,
}: {
  /** Called when the user clicks Answer — wires up the peer connection. */
  onAnswer: (callId: string, contactName: string, conversationId: string) => void;
  /** Called when the user clicks Decline. */
  onReject: (callId: string) => void;
}) {
  const [calls, setCalls] = useState<IncomingCall[]>([]);

  useEffect(() => {
    const socket = getClientSocket();

    const onIncoming = (payload: {
      callId: string;
      conversationId: string;
      contactName: string;
      ringingAt: string;
    }) => {
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
    };

    const onAnswered = (payload: { callId: string }) => {
      setCalls((prev) => prev.filter((c) => c.callId !== payload.callId));
    };

    const onEnded = (payload: { callId: string }) => {
      setCalls((prev) => prev.filter((c) => c.callId !== payload.callId));
    };

    socket.on("call:incoming", onIncoming);
    socket.on("call:answered", onAnswered);
    socket.on("call:ended", onEnded);
    return () => {
      socket.off("call:incoming", onIncoming);
      socket.off("call:answered", onAnswered);
      socket.off("call:ended", onEnded);
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
        <div className="text-xs text-muted-foreground">Incoming WhatsApp call…</div>
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
