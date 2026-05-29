"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket, dispatchLocalSocketEvent } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";

/**
 * Voice-call hook. Owns the browser side of the WhatsApp WebRTC peer
 * connection. Mounted once at InboxShell so a call persists across thread
 * switches and the panel stays visible no matter where the user navigates.
 *
 * Lifecycle:
 *   1. `call:sdp_offer` socket frame arrives (incoming + targeted by callId).
 *   2. answerIncoming(callId) creates the RTCPeerConnection, sets remote
 *      description (the offer), generates a local answer, POSTs it to
 *      /api/calls/:id/answer.
 *   3. ICE candidates trickle in both directions:
 *        browser → server  via /api/calls/:id/ice
 *        server  → browser via `call:ice` socket event
 *   4. End on hangup (POST /end) OR `call:ended` socket frame.
 *
 * Outbound calls (initiate) work the same: the API POST returns immediately
 * with a callId; the SDP offer arrives via socket once the customer
 * accepts; from there it's identical to incoming.
 *
 * Design notes:
 *   - Single peer connection at a time. WhatsApp calling is 1:1; managing
 *     concurrent calls would need a Map keyed by callId. Out of scope.
 *   - The PeerConnection is a ref, not state — replacing it triggers no
 *     re-render. The state slot tracks the "live" call's metadata so the
 *     panel can render contact name + timer.
 *   - All errors are surfaced via the `error` slot, not thrown. The panel
 *     renders inline; nothing catastrophic about a failed call.
 */

export interface LiveCallState {
  callId: string;
  conversationId: string;
  contactName: string;
  direction: "in" | "out";
  status: "ringing" | "in_progress" | "ending";
  startedAt: number;
  answeredAt: number | null;
}

interface PendingOffer {
  callId: string;
  conversationId: string;
  sdp: string;
}

/**
 * Default ICE config. Meta provides their own ICE servers via the SDP
 * answer; we add a STUN fallback so candidates can be generated even in
 * networks where Meta's hints don't include public STUN.
 */
const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  bundlePolicy: "max-bundle",
};

export function useCall(): {
  liveCall: LiveCallState | null;
  pendingOffers: Map<string, PendingOffer>;
  error: string | null;
  answerIncoming: (callId: string, contactName: string, conversationId: string) => Promise<void>;
  reject: (callId: string) => Promise<void>;
  hangup: () => Promise<void>;
  setMuted: (muted: boolean) => void;
  isMuted: () => boolean;
} {
  const [liveCall, setLiveCall] = useState<LiveCallState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pending offers keyed by callId. The browser may receive the SDP offer
  // BEFORE the agent clicks Answer (incoming-toast race); we stash it so
  // answerIncoming can consume it without waiting for a fresh frame.
  const pendingOffersRef = useRef<Map<string, PendingOffer>>(new Map());

  // The active peer connection + local media stream. Refs so swapping
  // them doesn't trigger a re-render; we only re-render when liveCall
  // changes.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioElRef = useRef<HTMLAudioElement | null>(null);

  // Subscribe to call:sdp_offer + call:ice + call:ended once on mount.
  useEffect(() => {
    const socket = getClientSocket();

    const onSdpOffer = (payload: {
      callId: string;
      conversationId: string;
      sdp: { type: "offer"; sdp: string };
    }) => {
      pendingOffersRef.current.set(payload.callId, {
        callId: payload.callId,
        conversationId: payload.conversationId,
        sdp: payload.sdp.sdp,
      });
    };

    const onIce = async (payload: {
      callId: string;
      candidate: {
        candidate: string;
        sdpMid: string | null;
        sdpMLineIndex: number | null;
      };
    }) => {
      const pc = pcRef.current;
      if (!pc || !liveCall || liveCall.callId !== payload.callId) return;
      try {
        await pc.addIceCandidate(
          new RTCIceCandidate({
            candidate: payload.candidate.candidate,
            sdpMid: payload.candidate.sdpMid,
            sdpMLineIndex: payload.candidate.sdpMLineIndex,
          }),
        );
      } catch (err) {
        // Late candidates after the connection is established sometimes
        // fail to apply — non-fatal.
        console.warn("[useCall] addIceCandidate failed", err);
      }
    };

    const onEnded = (payload: { callId: string }) => {
      if (liveCall?.callId === payload.callId) {
        tearDown();
      }
      pendingOffersRef.current.delete(payload.callId);
    };

    socket.on("call:sdp_offer", onSdpOffer);
    socket.on("call:ice", onIce);
    socket.on("call:ended", onEnded);

    return () => {
      socket.off("call:sdp_offer", onSdpOffer);
      socket.off("call:ice", onIce);
      socket.off("call:ended", onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- liveCall is captured via ref inside the handlers, see onIce comment
  }, [liveCall?.callId]);

  // Ensure the hidden <audio> element exists exactly once.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (remoteAudioElRef.current) return;
    const el = document.createElement("audio");
    el.autoplay = true;
    el.setAttribute("data-ccp-call-audio", "true");
    document.body.appendChild(el);
    remoteAudioElRef.current = el;
    return () => {
      el.remove();
      remoteAudioElRef.current = null;
    };
  }, []);

  const tearDown = useCallback(() => {
    pcRef.current?.getSenders().forEach((s) => {
      try {
        s.track?.stop();
      } catch {
        // ignore
      }
    });
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (remoteAudioElRef.current) {
      remoteAudioElRef.current.srcObject = null;
    }
    setLiveCall(null);
  }, []);

  const setupPeer = useCallback(
    async (callId: string): Promise<RTCPeerConnection> => {
      const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);

      // Local mic.
      const local = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      localStreamRef.current = local;
      for (const track of local.getAudioTracks()) {
        pc.addTrack(track, local);
      }

      // Remote audio → hidden <audio> element so the user can actually hear
      // the call. Same pattern every WebRTC demo uses.
      pc.ontrack = (e) => {
        const el = remoteAudioElRef.current;
        if (el && e.streams[0]) {
          el.srcObject = e.streams[0];
        }
      };

      // Trickle ICE → server → Meta.
      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        void fetchWithSessionGuard(`/api/calls/${callId}/ice`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid ?? null,
            sdpMLineIndex: e.candidate.sdpMLineIndex ?? null,
          }),
        }).catch((err) => {
          console.warn("[useCall] ICE relay failed", err);
        });
      };

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected"
        ) {
          setError("Call connection lost.");
        }
      };

      pcRef.current = pc;
      return pc;
    },
    [],
  );

  const answerIncoming = useCallback(
    async (callId: string, contactName: string, conversationId: string) => {
      setError(null);
      const offer = pendingOffersRef.current.get(callId);
      if (!offer) {
        setError("Call setup pending — try again in a moment.");
        return;
      }

      try {
        const pc = await setupPeer(callId);
        await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const startedAt = Date.now();
        setLiveCall({
          callId,
          conversationId,
          contactName,
          direction: "in",
          status: "in_progress",
          startedAt,
          answeredAt: startedAt,
        });

        // Optimistic dispatch — the answer button flips the local UI
        // immediately. The server frame arrives moments later via the
        // bus → fanout path; reducers are idempotent so the duplicate
        // is harmless.
        dispatchLocalSocketEvent("call:answered", {
          teamId: "",
          conversationId,
          callId,
          answeredByUserId: "",
          answeredAt: new Date(startedAt).toISOString(),
        });

        const res = await fetchWithSessionGuard(`/api/calls/${callId}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sdp: answer.sdp }),
        });
        if (!res.ok) {
          if (res.status === 409) {
            setError("Another agent already answered this call.");
          } else {
            setError(`Failed to accept call (${res.status}).`);
          }
          tearDown();
          pendingOffersRef.current.delete(callId);
          return;
        }
        pendingOffersRef.current.delete(callId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // getUserMedia failure (no mic permission) is the most common case.
        setError(
          /permission|denied|notallowed/i.test(message)
            ? "Microphone access is required to answer calls."
            : `Failed to start call: ${message}`,
        );
        tearDown();
      }
    },
    [setupPeer, tearDown],
  );

  const reject = useCallback(async (callId: string) => {
    pendingOffersRef.current.delete(callId);
    try {
      await fetchWithSessionGuard(`/api/calls/${callId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "declined" }),
      });
    } catch (err) {
      console.warn("[useCall] reject failed", err);
    }
  }, []);

  const hangup = useCallback(async () => {
    const current = liveCall;
    if (!current) return;
    setLiveCall((prev) => (prev ? { ...prev, status: "ending" } : prev));
    try {
      await fetchWithSessionGuard(`/api/calls/${current.callId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch (err) {
      console.warn("[useCall] hangup failed", err);
    } finally {
      tearDown();
    }
  }, [liveCall, tearDown]);

  const setMuted = useCallback((muted: boolean) => {
    const stream = localStreamRef.current;
    if (!stream) return;
    for (const t of stream.getAudioTracks()) {
      t.enabled = !muted;
    }
  }, []);

  const isMuted = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return false;
    const t = stream.getAudioTracks()[0];
    return t ? !t.enabled : false;
  }, []);

  return {
    liveCall,
    pendingOffers: pendingOffersRef.current,
    error,
    answerIncoming,
    reject,
    hangup,
    setMuted,
    isMuted,
  };
}
