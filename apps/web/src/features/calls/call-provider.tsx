"use client";

import { createContext, useContext, type ReactNode } from "react";

import { useCall } from "@/features/calls/hooks/use-call";
import { IncomingCallToast } from "@/features/calls/components/incoming-call-toast";
import { CallbackRequestToast } from "@/features/calls/components/callback-request-toast";
import { CallPanel } from "@/features/calls/components/call-panel";

/**
 * App-wide voice-call layer. Runs the SINGLE `useCall` instance (one
 * RTCPeerConnection, one set of call-signal socket listeners) and renders the
 * incoming-call toast + active-call panel as fixed overlays — so an incoming
 * call is visible on EVERY page, not just the inbox. Mounted once in the (app)
 * layout; consumers (the inbox thread's call button, the Calls page's
 * click-to-call) read the API via `useCallApi()` rather than calling `useCall`
 * themselves, which would spin up a second peer connection and double the
 * signalling.
 *
 * The toast self-detects via the team-wide `call:incoming` frame (see
 * IncomingCallToast); we only hand it the answer/reject actions.
 */
type CallApi = ReturnType<typeof useCall>;

const CallContext = createContext<CallApi | null>(null);

export function useCallApi(): CallApi {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error("useCallApi must be used within <CallProvider>");
  }
  return ctx;
}

export function CallProvider({
  children,
  canReceiveCalls,
}: {
  children: ReactNode;
  /** Resolved `calls:receive` capability. When false the incoming-call toast
   *  is suppressed entirely — a role an admin scoped OUT of calling must not
   *  get ringing popups it can't answer (answer/reject are already API-gated;
   *  this stops the misleading interruption + the 403-on-click). */
  canReceiveCalls: boolean;
}) {
  const callApi = useCall();

  return (
    <CallContext.Provider value={callApi}>
      {children}
      {/* Fixed-position overlays — toast bottom-left, panel bottom-right; they
          float over whatever page is open and never shift the layout. */}
      <IncomingCallToast
        canReceiveCalls={canReceiveCalls}
        onAnswer={(callId, contactName, conversationId, channel) => {
          void callApi.answerIncoming(callId, contactName, conversationId, channel);
        }}
        onReject={(callId) => {
          void callApi.reject(callId);
        }}
      />
      {/* Passive team-wide "customer requested a callback" sonner toast —
          deliberately NOT capability-gated (informational, nothing to answer). */}
      <CallbackRequestToast />
      <CallPanel
        liveCall={callApi.liveCall}
        error={callApi.error}
        onHangup={() => void callApi.hangup()}
        onSetMuted={callApi.setMuted}
        isMuted={callApi.isMuted}
      />
    </CallContext.Provider>
  );
}
