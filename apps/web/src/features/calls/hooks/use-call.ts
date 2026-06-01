"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket, dispatchLocalSocketEvent } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { toast } from "@/lib/toast";

/**
 * Voice-call hook. Owns the browser side of the WhatsApp WebRTC peer
 * connection. Mounted once at InboxShell so a call persists across thread
 * switches and the panel stays visible no matter where the user navigates.
 *
 * Inbound flow:
 *   1. `call:incoming` socket frame → IncomingCallToast renders.
 *   2. `call:sdp_offer` socket frame → stash the offer in pendingOffersRef.
 *   3. Agent clicks Answer → `answerIncoming()`: create RTCPeerConnection,
 *      setRemoteDescription(offer), createAnswer, setLocalDescription,
 *      POST /api/calls/:id/answer with the answer SDP.
 *
 * Outbound flow:
 *   1. Agent clicks Phone → `initiateOutbound()`: create RTCPeerConnection,
 *      createOffer, setLocalDescription, POST /api/conversations/:id/call
 *      with the offer SDP. Panel opens optimistically as "ringing".
 *   2. Customer picks up → Meta webhook → `call:sdp_offer` socket frame
 *      with `sdp.type === "answer"` → setRemoteDescription(answer) →
 *      panel flips to "in_progress" and audio flows.
 *
 * Teardown:
 *   - End button → POST /api/calls/:id/end → fan-out → `call:ended`.
 *   - Customer hangs up → WebRTC peer goes disconnected/failed → we POST
 *     /end ourselves and tear down immediately (Meta's terminate webhook
 *     can lag by seconds).
 *   - `call:ended` socket frame → tearDown.
 *
 * ICE: Meta uses ICE-LITE (all candidates baked into the SDP). The browser
 * still gathers locally to match against Meta's candidates; we don't try
 * to forward trickle candidates (Meta's API has no action for it).
 *
 * Concurrency: single peer connection at a time. WhatsApp calling is 1:1;
 * supporting parallel calls would require a Map keyed by callId.
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
 * Default ICE config. STUN fallback so the browser can gather local
 * candidates even in networks where Meta's hints don't include one.
 */
const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  bundlePolicy: "max-bundle",
};

export function useCall(): {
  liveCall: LiveCallState | null;
  error: string | null;
  answerIncoming: (
    callId: string,
    contactName: string,
    conversationId: string,
  ) => Promise<void>;
  initiateOutbound: (
    conversationId: string,
    contactName: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  reject: (callId: string) => Promise<void>;
  hangup: () => Promise<void>;
  setMuted: (muted: boolean) => void;
  isMuted: () => boolean;
} {
  const [liveCall, setLiveCall] = useState<LiveCallState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Surface a call error BOTH in `error` (for CallPanel) AND as a toast. Use
  // this at any error site that also calls tearDown() — tearDown nulls liveCall,
  // which unmounts CallPanel, so the `error` state alone would never be seen
  // (e.g. the answer-race 409 "another teammate picked up"). The toast is the
  // only reliably-visible channel once the panel is gone.

  // Pending offers keyed by callId. Stashed when call:sdp_offer arrives so
  // answerIncoming can consume the offer without waiting on a fresh frame.
  const pendingOffersRef = useRef<Map<string, PendingOffer>>(new Map());

  // Pending ANSWER SDPs for outbound calls, keyed by Meta's REAL callId. The
  // customer's answer arrives as a `call:sdp_offer` (type:"answer") frame fanned
  // to the WHOLE team room, so it can (a) beat the POST /call response that
  // rebinds our optimistic `tmp_` id to the real one, AND (b) belong to a
  // DIFFERENT agent's concurrent outbound call. Keying by callId is what makes
  // both safe: the matching outbound drain consumes only its OWN answer, while a
  // foreign-call answer sits inert under its own key (it never equals our call's
  // id) and is GC'd by that call's own `call:ended` frame. A dropped answer =
  // the call never establishes media (ICE times out ~15s, the panel closes
  // itself — the documented "first outbound flow" bug), so we never drop:
  // apply-or-stash, then drain on rebind.
  const pendingAnswersRef = useRef<Map<string, string>>(new Map());

  // Peer connection + media stream live as refs so swapping doesn't trigger
  // a re-render. Re-renders are driven by liveCall changes only.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioElRef = useRef<HTMLAudioElement | null>(null);
  // Mirror liveCall in a ref so socket handlers (bound once) read the
  // current call state without forcing the effect to re-subscribe.
  const liveCallRef = useRef<LiveCallState | null>(null);
  useEffect(() => {
    liveCallRef.current = liveCall;
  }, [liveCall]);

  const fail = useCallback((msg: string) => {
    setError(msg);
    toast.error(msg);
  }, []);

  // Apply an outbound call's answer SDP to the live peer connection. Returns
  // true if applied. Matches STRICTLY on callId (live.callId === callId): the
  // answer frame is fanned to the whole team room, so EVERY agent's browser
  // receives it — including agents who themselves have an unrelated outbound
  // call sitting in `have-local-offer`. The earlier PC-state-only match made
  // agent B apply agent A's customer's answer to B's peer connection, breaking
  // B's call. Keying on the real callId fixes it: B's live.callId never equals
  // A's call. The tmp_→real rebind window (where live.callId is still tmp_ and
  // can't match the real id) is handled by stashing + draining on rebind, NOT
  // by relaxing this match. The signalingState guard stays as a secondary
  // safety (a duplicate answer after we're already `stable` is a no-op).
  const applyOutboundAnswer = useCallback(
    async (callId: string, sdp: string): Promise<boolean> => {
      const pc = pcRef.current;
      const live = liveCallRef.current;
      if (
        !pc ||
        !live ||
        live.direction !== "out" ||
        live.callId !== callId ||
        pc.signalingState !== "have-local-offer"
      ) {
        return false;
      }
      try {
        await pc.setRemoteDescription({ type: "answer", sdp });
        setLiveCall((prev) =>
          prev && prev.direction === "out" && prev.callId === callId
            ? { ...prev, status: "in_progress", answeredAt: Date.now() }
            : prev,
        );
        return true;
      } catch (err) {
        console.warn("[useCall] setRemoteDescription(answer) failed", err);
        return false;
      }
    },
    [],
  );

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
      // Explicitly stop playback before detaching the stream. The element is
      // created once and reused across calls; clearing srcObject alone can
      // leave the media element in a lingering "playing" internal state, so
      // pause + rewind first for a clean slate on the next call's stream.
      remoteAudioElRef.current.pause();
      remoteAudioElRef.current.srcObject = null;
    }
    // Clear any stashed answers so they can't leak into the next call's PC.
    pendingAnswersRef.current.clear();
    setLiveCall(null);
  }, []);

  // Socket subscribers. Bound once on mount; read liveCallRef inside
  // handlers so a callId change doesn't force a re-subscribe.
  useEffect(() => {
    const socket = getClientSocket();

    const onSdpOffer = async (payload: {
      callId: string;
      conversationId: string;
      sdp: { type: "offer" | "answer"; sdp: string };
    }) => {
      // Answer SDP: customer accepted our outbound call. Apply it now if the PC
      // is ready; otherwise STASH it (it may have beaten the tmp_→real rebind or
      // the local-offer set) so initiateOutbound can drain it on rebind. Never
      // drop it — a dropped answer = the call never establishes media.
      if (payload.sdp.type === "answer") {
        const applied = await applyOutboundAnswer(payload.callId, payload.sdp.sdp);
        if (!applied) {
          // Stash by callId. It may have beaten the tmp_→real rebind (our own
          // call — drained on rebind), or be a foreign agent's call (never
          // matches our id — GC'd by its own call:ended). Keying by id keeps
          // the two cases from colliding on a single slot.
          pendingAnswersRef.current.set(payload.callId, payload.sdp.sdp);
        }
        return;
      }
      // Offer SDP: inbound call from the customer. Stash so answerIncoming
      // can consume it when the agent clicks Answer.
      pendingOffersRef.current.set(payload.callId, {
        callId: payload.callId,
        conversationId: payload.conversationId,
        sdp: payload.sdp.sdp,
      });
    };

    const onEnded = (payload: { callId: string }) => {
      if (liveCallRef.current?.callId === payload.callId) {
        tearDown();
      }
      pendingOffersRef.current.delete(payload.callId);
      // GC any stashed answer for this call — including foreign-call answers
      // that landed here via the team-room fanout but were never ours to apply.
      pendingAnswersRef.current.delete(payload.callId);
    };

    socket.on("call:sdp_offer", onSdpOffer);
    socket.on("call:ended", onEnded);
    return () => {
      socket.off("call:sdp_offer", onSdpOffer);
      socket.off("call:ended", onEnded);
    };
  }, [tearDown, applyOutboundAnswer]);

  // Hidden <audio> element for remote audio playback. Created once.
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

  // Tab-close mid-call: fire /end via sendBeacon so the customer side
  // doesn't have to wait for the ~15s ICE timeout. pc.close runs in
  // tearDown which never fires on a real tab close (no unload event for
  // a hard close). sendBeacon is fire-and-forget + survives unload by
  // spec. Only fires when we have a real (non-tmp) callId.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBeforeUnload = () => {
      const live = liveCallRef.current;
      if (!live || live.callId.startsWith("tmp_")) return;
      try {
        const url = `/api/calls/${live.callId}/end`;
        const blob = new Blob([JSON.stringify({})], { type: "application/json" });
        navigator.sendBeacon?.(url, blob);
      } catch {
        // best-effort — nothing we can do at unload time
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onBeforeUnload);
    };
  }, []);

  /**
   * Build an RTCPeerConnection with mic capture, remote-audio routing,
   * and a connection-state watcher that auto-terminates on disconnect.
   */
  const setupPeer = useCallback(async (): Promise<RTCPeerConnection> => {
    const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);

    // Local mic → outbound audio track.
    const local = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    localStreamRef.current = local;
    for (const track of local.getAudioTracks()) {
      pc.addTrack(track, local);
    }

    // Remote audio → hidden <audio> element so the user can hear it.
    pc.ontrack = (e) => {
      const el = remoteAudioElRef.current;
      if (el && e.streams[0]) {
        el.srcObject = e.streams[0];
      }
    };

    // Customer hangs up → connectionState goes disconnected → failed →
    // closed. Tear down immediately AND POST /end so the audit row gets
    // a terminal status. Don't wait on Meta's terminate webhook (lag-prone).
    //
    // disconnected → failed → closed each fire this handler, so without a guard
    // we'd POST /end (and run tearDown) 2-3× per teardown. Server-side endCall
    // is idempotent so it's not a correctness bug, but the redundant POSTs are
    // pure waste. One-shot per peer connection (the flag is per-call — setupPeer
    // builds a fresh PC + closure each call).
    let teardownFired = false;
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed" || state === "disconnected" || state === "closed") {
        if (teardownFired) return;
        teardownFired = true;
        const live = liveCallRef.current;
        if (live && !live.callId.startsWith("tmp_")) {
          void fetchWithSessionGuard(`/api/calls/${live.callId}/end`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          }).catch(() => {});
        }
        tearDown();
      }
    };

    pcRef.current = pc;
    return pc;
  }, [tearDown]);

  const answerIncoming = useCallback(
    async (callId: string, contactName: string, conversationId: string) => {
      setError(null);
      const offer = pendingOffersRef.current.get(callId);
      if (!offer) {
        setError("Hold on — the call is still connecting.");
        return;
      }

      try {
        const pc = await setupPeer();
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

        const res = await fetchWithSessionGuard(`/api/calls/${callId}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sdp: answer.sdp }),
        });
        if (!res.ok) {
          fail(
            res.status === 409
              ? "Another teammate already picked up this call."
              : "Couldn't accept the call. Try again.",
          );
          tearDown();
          return;
        }
        pendingOffersRef.current.delete(callId);

        // Optimistic local dispatch — dismiss the toast on this browser + flip
        // the thread's activeCall to in_progress, ahead of the server's
        // call:answered frame. Fired ONLY after the POST is confirmed (200):
        // firing it BEFORE meant a lost race (409) had already flipped local
        // reducer state (activeCall = in_progress in the thread cache) that
        // tearDown doesn't revert — leaving a stale "live call" indicator on a
        // call this agent never won. The IncomingCallToast already self-dismisses
        // its own card on click, so the toast doesn't linger during the POST.
        dispatchLocalSocketEvent("call:answered", {
          teamId: "",
          conversationId,
          callId,
          answeredByUserId: "",
          answeredAt: new Date(startedAt).toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fail(
          /permission|denied|notallowed/i.test(message)
            ? "Allow microphone access to answer calls."
            : "Couldn't start the call. Check your microphone and try again.",
        );
        tearDown();
      }
    },
    [setupPeer, tearDown, fail],
  );

  const initiateOutbound = useCallback(
    async (
      conversationId: string,
      contactName: string,
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      setError(null);

      // The browser doesn't know the real callId until placeCall returns
      // (Meta assigns it). Use a temp id so onicecandidate / state handlers
      // can wire up before the rebind; the panel rebinds on POST success.
      // Prefer crypto.randomUUID for a guaranteed-unique id; Math.random
      // is short-bit and could (very unlikely) collide with a real call id.
      const tempCallId = `tmp_${
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2)
      }`;

      let pc: RTCPeerConnection;
      let sdpOffer: string;
      try {
        pc = await setupPeer();
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        if (!offer.sdp) throw new Error("SDP generation failed");
        sdpOffer = offer.sdp;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = /permission|denied|notallowed/i.test(message)
          ? "mic_permission_denied"
          : "rtc_setup_failed";
        tearDown();
        return { ok: false, reason };
      }

      // Optimistic ringing UI.
      setLiveCall({
        callId: tempCallId,
        conversationId,
        contactName,
        direction: "out",
        status: "ringing",
        startedAt: Date.now(),
        answeredAt: null,
      });

      try {
        const res = await fetchWithSessionGuard(
          `/api/conversations/${conversationId}/call`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sdp: sdpOffer }),
          },
        );
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          callId?: string;
          reason?: string;
        };
        if (!res.ok || body.ok === false) {
          tearDown();
          return { ok: false, reason: body.reason ?? `http_${res.status}` };
        }
        // Rebind to Meta's real callId so both the `call:ended` frame AND the
        // answer frame (now matched by callId, not PC state) target this call.
        const realCallId = body.callId ?? tempCallId;
        // Update liveCallRef SYNCHRONOUSLY (not just via setLiveCall, whose
        // effect won't run until the next tick): the drain below + every
        // applyOutboundAnswer match read liveCallRef.callId, so it must already
        // be the real id when we drain, or the strict callId match would reject
        // our own stashed answer.
        if (liveCallRef.current && liveCallRef.current.callId === tempCallId) {
          liveCallRef.current = { ...liveCallRef.current, callId: realCallId };
        }
        setLiveCall((prev) =>
          prev && prev.callId === tempCallId
            ? { ...prev, callId: realCallId }
            : prev,
        );
        // Drain an answer SDP that arrived BEFORE this rebind (the team-room
        // answer frame can beat the POST response). Matched by the REAL callId,
        // so we apply ONLY our own call's answer — a foreign agent's answer
        // stashed under a different id is left untouched. Without this drain a
        // fast customer pickup would strand the stashed answer and the call
        // would never connect.
        const stashed = pendingAnswersRef.current.get(realCallId);
        if (stashed) {
          pendingAnswersRef.current.delete(realCallId);
          void applyOutboundAnswer(realCallId, stashed);
        }
        return { ok: true };
      } catch {
        tearDown();
        return { ok: false, reason: "network_error" };
      }
    },
    [setupPeer, tearDown, applyOutboundAnswer],
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
    const current = liveCallRef.current;
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
  }, [tearDown]);

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
    error,
    answerIncoming,
    initiateOutbound,
    reject,
    hangup,
    setMuted,
    isMuted,
  };
}
