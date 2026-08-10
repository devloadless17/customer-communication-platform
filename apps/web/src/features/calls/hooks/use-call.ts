"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket, dispatchLocalSocketEvent } from "@/lib/socket-client";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { toast } from "@/lib/toast";
import { isPhoneChannel } from "@ccp/shared/providers/capabilities";
import type { Channel } from "@ccp/shared/types";

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
  /**
   * WHICH of our accounts this call is on, so the live panel can say it.
   *
   * The channel is not enough: a workspace running a Sales and a Support number
   * saw "WhatsApp" on both, and the agent picked up without knowing which
   * business to answer as. Null when the thread isn't bound to an account.
   */
  channel: Channel | null;
  accountId: string | null;
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

/**
 * How long to wait for the peer connection before completing an accept anyway.
 *
 * The provider gives roughly 30-60s from the incoming-call webhook to accept,
 * so this has to resolve well inside that. If ICE hasn't completed by now the
 * call is likely doomed regardless — sending the accept is still the better
 * move, since it at least lets the provider report a real failure instead of
 * timing us out.
 */
const PEER_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Resolve once the peer connection reports `connected`, or after a bounded
 * wait. Resolves rather than rejects on timeout: the caller wants to proceed
 * either way, and treating a slow connection as an error would abort a call
 * that might still have come up.
 */
function waitForPeerConnected(pc: RTCPeerConnection): Promise<void> {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      // `failed`/`closed` also release the wait — there is nothing left to wait
      // for, and the caller's own teardown path handles the dead connection.
      if (
        pc.connectionState === "connected" ||
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        done();
      }
    };
    const timer = window.setTimeout(done, PEER_CONNECT_TIMEOUT_MS);
    pc.addEventListener("connectionstatechange", onChange);
  });
}


/**
 * sessionStorage key holding the call this TAB currently has live.
 *
 * sessionStorage (not local) is deliberate: it is per-tab and survives a
 * reload, which is exactly the distinction we need. An agent with the app open
 * in two tabs must not have tab B's mount tear down tab A's call — tab B never
 * wrote this key, so it never reclaims anything.
 */
const ACTIVE_CALL_TAB_KEY = "ccp.call.activeCallId";

function readTabCallId(): string | null {
  try {
    return window.sessionStorage.getItem(ACTIVE_CALL_TAB_KEY);
  } catch {
    // Private mode / storage disabled — recovery degrades to the server-side
    // stale-call sweeper, which is slower but still terminal.
    return null;
  }
}

function writeTabCallId(callId: string | null): void {
  try {
    if (callId) window.sessionStorage.setItem(ACTIVE_CALL_TAB_KEY, callId);
    else window.sessionStorage.removeItem(ACTIVE_CALL_TAB_KEY);
  } catch {
    // Non-fatal; see readTabCallId.
  }
}

export function useCall(): {
  liveCall: LiveCallState | null;
  error: string | null;
  answerIncoming: (
    callId: string,
    contactName: string,
    conversationId: string,
    channel: Channel,
    /** The account being called — from the `call:incoming` frame. */
    accountId?: string | null,
  ) => Promise<void>;
  initiateOutbound: (
    conversationId: string,
    contactName: string,
    /** The thread's account — the number this call goes out FROM. */
    channel?: Channel | null,
    accountId?: string | null,
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

  // Pending `call:answered` frames, keyed by Meta's REAL callId — the SAME
  // race class as pendingAnswersRef, with a worse failure mode. The pickup
  // frame is fanned to the whole team and can beat the POST /call response
  // that rebinds our optimistic `tmp_` id; the old handler matched strictly on
  // `prev.callId === payload.callId` and DROPPED the frame in that window, so
  // the recorder never armed (no recording, no transcript), the status stayed
  // `ringing`, and the 60s ring-timeout tore down a call two people were
  // already talking on. Apply-or-stash, drain on rebind; a foreign agent's
  // pickup sits inert under its own key and is GC'd by that call's own
  // `call:ended`. Value = the provider's answeredAt ISO timestamp.
  const pendingAnsweredRef = useRef<Map<string, string>>(new Map());

  // Peer connection + media stream live as refs so swapping doesn't trigger
  // a re-render. Re-renders are driven by liveCall changes only.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioElRef = useRef<HTMLAudioElement | null>(null);

  // ── In-app call recorder (artifact mode "inapp") ─────────────────────────
  // The server's initiate/answer response says whether THIS call should be
  // recorded in the browser (recordInApp). The recorder mixes the agent mic
  // (left channel) and the customer (right channel) into one stereo stream —
  // the channel split is what keeps per-speaker transcription possible later.
  // Uploads: full-file-so-far every 30s (crash resilience without a chunk
  // protocol — the server overwrites the same key), then a final upload on
  // teardown that triggers the OGG remux + Whisper transcription server-side.
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const recordArmedRef = useRef(false);
  // OUTBOUND pickup gate. The media leg "connects" ~1s after dialing — that's
  // WhatsApp's media server, NOT the customer — so starting the recorder on
  // `connected` captured the entire ringing period (a 6s conversation became a
  // 23s file). Set synchronously by the `call:answered` frame (the provider's
  // ACCEPTED status = real pickup); a ref, not state, so the recorder guard
  // never races React's render cycle. Inbound calls don't consult it — the
  // agent answering IS the pickup.
  const outboundAnsweredRef = useRef(false);
  const recorderRef = useRef<{
    recorder: MediaRecorder;
    ctx: AudioContext;
    chunks: Blob[];
    mimeType: string;
    flushTimer: ReturnType<typeof setTimeout>;
    // Interim flushes re-send the WHOLE file-so-far (the server overwrites one
    // key — crash insurance, not a chunk protocol), so a fixed 30s cadence is
    // O(n²) bytes: a 30-minute call re-uploads ~400MB in total. The delay
    // doubles after every flush (30s → 60 → 120 → 240, capped at 300s), which
    // keeps early crash-loss small while bounding what a long call re-sends.
    flushDelayMs: number;
    callId: string;
    // Kept so a mid-call renegotiation can re-point the customer leg at the
    // new remote media (see rebindRecorderRemoteSource). `remoteTrack` is the
    // identity the rebind decision keys on: a renegotiation usually replaces
    // the TRACK inside the SAME MediaStream object, so comparing streams
    // would miss exactly the case the rebind exists for.
    merger: ChannelMergerNode;
    remoteSource: MediaStreamAudioSourceNode;
    remoteTrack: MediaStreamTrack | null;
  } | null>(null);
  // Mirror liveCall in a ref so socket handlers (bound once) read the
  // current call state without forcing the effect to re-subscribe.
  const liveCallRef = useRef<LiveCallState | null>(null);
  useEffect(() => {
    liveCallRef.current = liveCall;
  }, [liveCall]);

  // Synchronous in-flight guard for call SETUP (getUserMedia → createOffer/
  // createAnswer → POST). liveCallRef stays null through this whole async window
  // (setLiveCall runs only AFTER setupPeer resolves, and liveCallRef then trails
  // it by a tick via the effect above), so the liveCallRef check alone lets a
  // double-click on the Phone button — or an inbound Answer click during an
  // outbound dial — slip through twice: two real Meta calls, and the first
  // getUserMedia stream orphaned (mic indicator stuck lit). busyRef closes that
  // window: set true before the first await, cleared in a finally on every exit.
  const busyRef = useRef(false);

  const fail = useCallback((msg: string) => {
    setError(msg);
    toast.error(msg);
  }, []);

  // NOTE: there is deliberately no browser-side pickup detection.
  //
  // This hook used to poll inbound-rtp packet counts and declare the customer
  // had answered once audio started flowing, on the belief that the provider
  // sends no live "answered" signal for business-initiated calls. It does — the
  // ACCEPTED call-status webhook — and the heuristic could be fooled by ringback
  // tone into starting the timer on a call nobody picked up. Pickup now arrives
  // as a `call:answered` frame like any other state change.

  // Grace timer for a TRANSIENT WebRTC `disconnected`. Per the spec
  // `disconnected` is frequently temporary (a brief packet-loss blip, a WiFi
  // hop, a network-interface switch) and routinely returns to `connected` on
  // its own — only `failed` is terminal. We start this timer on `disconnected`
  // and only end the call if the state HASN'T recovered when it fires; a return
  // to `connected`/`connecting` clears it. Cleared in releaseMedia so it can't
  // outlive the peer connection and kill the next call.
  const disconnectGraceRef = useRef<number | null>(null);

  const clearDisconnectGrace = useCallback(() => {
    if (disconnectGraceRef.current !== null) {
      window.clearTimeout(disconnectGraceRef.current);
      disconnectGraceRef.current = null;
    }
  }, []);

  // Outbound calls the agent cancelled while we were still in the tmp_ id window
  // (before placeCall returned Meta's real id). /end can't target a call that
  // doesn't exist yet, so we record the tmp id here and initiateOutbound
  // terminates the REAL call the instant the id lands — otherwise the customer
  // keeps ringing after the agent already bailed (the "started by mistake, ended
  // it, customer still called" bug).
  const cancelledTmpIdsRef = useRef<Set<string>>(new Set());

  // Release ALL call hardware (mic + peer connection + remote audio) WITHOUT
  // touching liveCall state. Idempotent. Called on teardown AND at the start of
  // every setupPeer, so a rapid re-dial can never leave a prior getUserMedia
  // stream live — that leak is what keeps Chrome's mic indicator lit after a
  // call ends when calls overlap.
  // Drop the recorder WITHOUT uploading (re-dial safety; the teardown path
  // finalizes-with-upload first, so reaching here with a live recorder means
  // an abnormal path — better to lose one recording than to double-upload
  // against the wrong call).
  const disposeInAppRecorder = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    clearTimeout(rec.flushTimer);
    try {
      if (rec.recorder.state !== "inactive") rec.recorder.stop();
    } catch {
      // ignore
    }
    void rec.ctx.close().catch(() => undefined);
  }, []);

  /**
   * Upload the recording-so-far. `final` stops the recorder, retries the
   * upload (it's the one that matters — it triggers remux + transcription),
   * and disposes the mixer.
   */
  const uploadInAppRecording = useCallback(
    async (final: boolean) => {
      const rec = recorderRef.current;
      if (!rec) return;
      if (final) {
        recorderRef.current = null;
        clearTimeout(rec.flushTimer);
        if (rec.recorder.state !== "inactive") {
          // stop() flushes the buffered tail through ondataavailable before
          // onstop — awaited so the final blob carries the last words.
          await new Promise<void>((resolve) => {
            rec.recorder.onstop = () => resolve();
            try {
              rec.recorder.stop();
            } catch {
              resolve();
            }
          });
        }
        void rec.ctx.close().catch(() => undefined);
      } else if (rec.recorder.state === "recording") {
        // Flush the in-progress slice so the periodic upload is current.
        try {
          rec.recorder.requestData();
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (rec.chunks.length === 0) return;
      const blob = new Blob(rec.chunks, { type: rec.mimeType });
      const fd = new FormData();
      fd.append(
        "file",
        blob,
        `call.${rec.mimeType.includes("mp4") ? "mp4" : "webm"}`,
      );
      const url = `/api/calls/${rec.callId}/recording-upload${final ? "?final=1" : ""}`;
      const attempts = final ? 3 : 1;
      for (let i = 0; i < attempts; i++) {
        try {
          // No content-type header — the browser must set the multipart boundary.
          const res = await fetchWithSessionGuard(url, { method: "POST", body: fd });
          if (res.ok) return;
        } catch {
          // retry below
        }
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
      if (final) {
        // The final upload is what triggers remux + transcription server-side.
        // The server-side recovery sweeper finalizes from the last interim
        // flush, so a failure here degrades to "recording up to the last
        // checkpoint" — but the agent must hear about it NOW, while re-asking
        // the customer is still possible, not weeks later from a missing
        // transcript.
        console.warn("[useCall] final recording upload failed after retries");
        toast.error(
          "Call recording upload failed — only audio up to the last checkpoint could be saved.",
        );
      }
    },
    [],
  );

  /** Start the recorder once the call is actually flowing. Idempotent; no-op
   *  unless the server armed this call (`recordInApp`) and both media legs
   *  exist with a REAL call id. */
  const startInAppRecorder = useCallback(() => {
    if (!recordArmedRef.current || recorderRef.current) return;
    const local = localStreamRef.current;
    const remote = remoteStreamRef.current;
    const live = liveCallRef.current;
    if (!local || !remote || !live || live.callId.startsWith("tmp_")) return;
    // Outbound: wait for REAL pickup (see outboundAnsweredRef) so the ring
    // period is never recorded and the file length matches the conversation.
    if (live.direction === "out" && !outboundAnsweredRef.current) return;

    // WAIT FOR THE REMOTE TRACK TO CARRY MEDIA.
    //
    // `ontrack` fires as soon as the track is negotiated, BEFORE audio flows,
    // and a remote track is `muted` until it does. A MediaStreamAudioSourceNode
    // created over a muted remote track produces silence for the LIFE of the
    // call — it binds at construction and never recovers when media starts.
    //
    // Measured on a production recording: the customer's channel was digital
    // silence end to end (-91 dBFS mean against -26 dBFS on the agent's), so
    // that side of the conversation never existed in the file and no
    // transcription setting could recover it. It was intermittent because the
    // recorder can also be started from the connection-state path, which
    // happens to run after media is flowing — hence some calls captured the
    // customer and some did not.
    const remoteTrack = remote.getAudioTracks()[0];
    if (!remoteTrack) return; // no audio track yet; ontrack will call again
    if (remoteTrack.muted) {
      remoteTrack.addEventListener("unmute", () => startInAppRecorder(), {
        once: true,
      });
      return;
    }

    try {
      // Same constructor fallback as the voice recorder / notification sound.
      const AudioCtxCtor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtxCtor) {
        console.warn("[useCall] AudioContext unavailable — recording skipped");
        return;
      }
      const ctx = new AudioCtxCtor();
      // This runs from a socket handler or a track `unmute` event — NOT a user
      // gesture — so the context can be born `suspended`, and a suspended
      // context records digital silence with no diagnostic anywhere. Resume it
      // and say so if the browser refuses.
      if (ctx.state !== "running") {
        void ctx
          .resume()
          .then(() => {
            if ((ctx.state as AudioContextState) !== "running") {
              console.warn(
                `[useCall] recorder AudioContext is ${ctx.state} after resume() — ` +
                  "this recording may be silent",
              );
            }
          })
          .catch(() => {});
      }
      const dest = ctx.createMediaStreamDestination();
      // FORCE two DISCRETE channels. Without this the browser collapsed the
      // mix to mono and the stored file carried the SAME audio on both
      // channels — verified on a real production recording, where left minus
      // right measured -90 dB (digital silence) and each leg transcribed to
      // identical text. That makes speaker separation impossible downstream:
      // there is nothing to tell the two apart, so every line lands under one
      // speaker. `discrete` is what stops the up/down-mix rules of the default
      // "speakers" interpretation from applying.
      dest.channelCount = 2;
      dest.channelCountMode = "explicit";
      dest.channelInterpretation = "discrete";
      const merger = ctx.createChannelMerger(2);
      // Agent → left, customer → right. See the recorder header comment.
      ctx.createMediaStreamSource(local).connect(merger, 0, 0);
      const remoteSource = ctx.createMediaStreamSource(remote);
      remoteSource.connect(merger, 0, 1);
      merger.connect(dest);
      // The browser does not have to honour the request, and when it silently
      // doesn't, the only symptom is a transcript with no speaker labels weeks
      // later. Say so at the moment it happens.
      const recordedChannels = dest.stream.getAudioTracks()[0]?.getSettings?.().channelCount;
      if (recordedChannels !== undefined && recordedChannels < 2) {
        console.warn(
          `[useCall] recorder captured ${recordedChannels} channel(s), not 2 — ` +
            "agent/customer separation will be unavailable for this call",
        );
      }
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4" // Safari
          : "";
      const recorder = new MediaRecorder(dest.stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 64_000,
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.start(5_000);
      const rec = {
        recorder,
        ctx,
        chunks,
        mimeType: mimeType || "audio/webm",
        flushTimer: setTimeout(() => {}, 0),
        flushDelayMs: 30_000,
        callId: live.callId,
        merger,
        remoteSource,
        remoteTrack: remoteTrack ?? null,
      };
      // Self-rescheduling flush with backoff (see flushDelayMs on the ref).
      const scheduleFlush = () => {
        rec.flushTimer = setTimeout(() => {
          void uploadInAppRecording(false).finally(() => {
            if (recorderRef.current === rec) {
              rec.flushDelayMs = Math.min(rec.flushDelayMs * 2, 300_000);
              scheduleFlush();
            }
          });
        }, rec.flushDelayMs);
      };
      scheduleFlush();
      recorderRef.current = rec;
    } catch (err) {
      console.warn("[useCall] in-app recorder failed to start", err);
    }
  }, [uploadInAppRecording]);

  /**
   * Re-point the recorder's CUSTOMER channel at a new remote stream.
   *
   * A mid-call renegotiation (`media_update` — Meta sends one post-pickup on
   * Messenger) replaces the remote track, but a MediaStreamAudioSourceNode
   * binds at construction: with the recorder already running, the merger
   * stayed wired to the DEAD stream and the customer's leg went silent for
   * the rest of the file — the same -91 dBFS failure class the `unmute` wait
   * exists for, reintroduced through a different door. Honors the same
   * muted-track gate: binding a muted track records silence forever.
   */
  const rebindRecorderRemoteSource = useCallback(
    (remote: MediaStream, track: MediaStreamTrack) => {
      const rec = recorderRef.current;
      if (!rec) return;
      const bind = () => {
        const cur = recorderRef.current;
        // The recorder may have stopped, or the media been superseded again,
        // while we waited on `unmute` — binding then would wire a stale source.
        if (cur !== rec || remoteStreamRef.current !== remote) return;
        if (!remote.getAudioTracks().includes(track)) return;
        try {
          rec.remoteSource.disconnect();
          const src = rec.ctx.createMediaStreamSource(remote);
          src.connect(rec.merger, 0, 1);
          rec.remoteSource = src;
          rec.remoteTrack = track;
        } catch (err) {
          console.warn("[useCall] failed to rebind recorder to new remote track", err);
        }
      };
      if (track.muted) track.addEventListener("unmute", bind, { once: true });
      else bind();
    },
    [],
  );

  const releaseMedia = useCallback(() => {
    clearDisconnectGrace();
    disposeInAppRecorder();
    remoteStreamRef.current = null;
    const pc = pcRef.current;
    if (pc) {
      // Detach handlers BEFORE closing. close() fires `connectionstatechange`
      // ASYNCHRONOUSLY; if releaseMedia ran from setupPeer (a re-dial), that late
      // event would otherwise run tearDown against the NEWER call setupPeer just
      // installed — the classic stale-close-kills-the-new-call race.
      pc.onconnectionstatechange = null;
      pc.ontrack = null;
      pc.getSenders().forEach((s) => {
        try {
          s.track?.stop();
        } catch {
          // ignore
        }
      });
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // ignore
      }
    });
    localStreamRef.current = null;
    if (remoteAudioElRef.current) {
      // Stop playback before detaching: the element is reused across calls and
      // clearing srcObject alone can leave it in a lingering "playing" state.
      remoteAudioElRef.current.pause();
      remoteAudioElRef.current.srcObject = null;
    }
  }, [clearDisconnectGrace, disposeInAppRecorder]);

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
        // Media is now negotiated with the provider — but this answer comes
        // from its media server and arrives BEFORE the human picks up. Stay
        // "ringing" ("Calling…", no timer); the `call:answered` frame driven by
        // the provider's ACCEPTED status is what flips us to in_progress.
        return true;
      } catch (err) {
        console.warn("[useCall] setRemoteDescription(answer) failed", err);
        return false;
      }
    },
    [],
  );

  const tearDown = useCallback(() => {
    // Finalize the in-app recording FIRST: the synchronous part stops the
    // MediaRecorder before releaseMedia kills its source tracks, and the
    // upload continues async after the UI is torn down (with retries — the
    // final upload is what triggers remux + transcription).
    void uploadInAppRecording(true);
    recordArmedRef.current = false;
    outboundAnsweredRef.current = false;
    releaseMedia();
    // Clear any stashed answers so they can't leak into the next call's PC.
    pendingAnswersRef.current.clear();
    pendingAnsweredRef.current.clear();
    setLiveCall(null);
  }, [releaseMedia, uploadInAppRecording]);

  /**
   * The customer picked up our outbound call (a `call:answered` frame that
   * matched this call, live or drained from the stash after the tmp_→real
   * rebind). Side effects run HERE, outside the state updater — an updater
   * must be pure (StrictMode runs it twice), and the old code started the
   * recorder from inside one.
   */
  const applyOutboundAnswered = useCallback(
    (callId: string, answeredAt: string) => {
      // Open the outbound recorder gate first: the ref flips synchronously so
      // the start call below (and any later ontrack/connected path) sees it.
      // Harmless when the frame turns out not to apply — the gate is only
      // consulted for a live outbound ring, and teardown resets it.
      outboundAnsweredRef.current = true;
      startInAppRecorder();
      const answeredAtMs = Date.parse(answeredAt);
      setLiveCall((prev) => {
        // Only our own still-ringing OUTBOUND call. Inbound calls set their
        // own state when the agent answers.
        if (
          !prev ||
          prev.callId !== callId ||
          prev.direction !== "out" ||
          prev.status !== "ringing"
        ) {
          return prev;
        }
        return {
          ...prev,
          status: "in_progress",
          // Start the timer from the provider's real pickup time, not from
          // when this frame happened to arrive.
          answeredAt: Number.isFinite(answeredAtMs) ? answeredAtMs : Date.now(),
        };
      });
    },
    [startInAppRecorder],
  );

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
      // Mid-call media renegotiation: Meta (Messenger) sends a post-pickup
      // `media_update` OFFER on this same frame. If it targets our LIVE call and
      // the PC is already negotiated (stable), answer it IN PLACE and relay the
      // answer to Meta — without this the renegotiation is silently dropped and
      // the post-pickup media may never establish. Distinct from the fresh
      // inbound ring below: during a ring liveCall is null, so that path is
      // untouched. Best-effort — a failure leaves the existing media flowing.
      const live = liveCallRef.current;
      const livePc = pcRef.current;
      if (
        live &&
        livePc &&
        live.callId === payload.callId &&
        livePc.signalingState === "stable"
      ) {
        try {
          await livePc.setRemoteDescription({ type: "offer", sdp: payload.sdp.sdp });
          const answer = await livePc.createAnswer();
          await livePc.setLocalDescription(answer);
          const res = await fetchWithSessionGuard(
            `/api/calls/${payload.callId}/media-update`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sdp: answer.sdp }),
            },
          );
          if (res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              sdpAnswer?: string;
            };
            // A chained answer from Meta, if any, completes the exchange.
            if (body.sdpAnswer && pcRef.current?.signalingState === "have-local-offer") {
              await pcRef.current.setRemoteDescription({
                type: "answer",
                sdp: body.sdpAnswer,
              });
            }
          }
        } catch (err) {
          console.warn("[useCall] media renegotiation failed", err);
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

    /**
     * The customer picked up an outbound call.
     *
     * This frame is the ONLY thing that starts the timer on a call we placed:
     * the SDP answer arrives a second after dialing (media setup, not pickup),
     * and the provider's authoritative pickup signal is its ACCEPTED call
     * status, which reaches us as this frame. Without a handler here the panel
     * sits on "Calling…" forever while the two parties are already talking.
     */
    const onAnswered = (payload: { callId: string; answeredAt: string }) => {
      // Apply-or-stash, like the answer SDP above. This frame is fanned to
      // the whole team, so a non-matching callId is EITHER a foreign agent's
      // call (inert in the stash, GC'd by its call:ended) OR our own outbound
      // pickup beating the tmp_→real rebind — and dropping that one used to
      // disable recording for the whole call and let the ring-timeout kill a
      // live conversation (see pendingAnsweredRef).
      const live = liveCallRef.current;
      if (live && live.callId === payload.callId) {
        applyOutboundAnswered(payload.callId, payload.answeredAt);
        return;
      }
      pendingAnsweredRef.current.set(payload.callId, payload.answeredAt);
    };

    const onEnded = (payload: { callId: string }) => {
      if (liveCallRef.current?.callId === payload.callId) {
        tearDown();
      }
      pendingOffersRef.current.delete(payload.callId);
      // GC any stashed answer for this call — including foreign-call answers
      // that landed here via the team-room fanout but were never ours to apply.
      pendingAnswersRef.current.delete(payload.callId);
      pendingAnsweredRef.current.delete(payload.callId);
    };

    socket.on("call:sdp_offer", onSdpOffer);
    socket.on("call:answered", onAnswered);
    socket.on("call:ended", onEnded);
    return () => {
      socket.off("call:sdp_offer", onSdpOffer);
      socket.off("call:answered", onAnswered);
      socket.off("call:ended", onEnded);
    };
  }, [tearDown, applyOutboundAnswer, applyOutboundAnswered]);


  // ── Surviving a reload / tab close ──────────────────────────────────────
  //
  // A page reload destroys the RTCPeerConnection, and a WebRTC session cannot
  // be resumed across it — the SDP negotiation is gone and the provider holds
  // the other end. So the media is provably dead the moment the page unloads,
  // while our Call row still says `in_progress` and the CUSTOMER is sitting on
  // a silent line. Left alone the stale-call sweeper only clears that after two
  // hours, which is two hours of a customer being ignored by a call that looks
  // live to everyone else on the team.
  //
  // Two layers, because neither alone is reliable:
  //   1. on unload, release the call immediately (keepalive, so it survives the
  //      navigation) — this is what frees the customer in the normal case;
  //   2. on mount, if this tab left a marker behind, the unload beacon either
  //      didn't fire or didn't land — release it now.
  // Captured during the FIRST RENDER, before any effect runs. This ordering is
  // load-bearing: the mirror effect below writes `null` on mount (liveCall is
  // null then), so reading the marker from inside an effect would race against
  // it being cleared and the reclaim would never fire.
  const [orphanedCallId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readTabCallId(),
  );

  useEffect(() => {
    writeTabCallId(liveCall?.callId ?? null);
  }, [liveCall?.callId]);

  useEffect(() => {
    const release = () => {
      const callId = liveCallRef.current?.callId;
      // `tmp_` ids exist only until placeCall returns; there is no server-side
      // call to end under that id yet. The mount-time reclaim below is the
      // backstop for a reload inside that brief window.
      if (!callId || callId.startsWith("tmp_")) return;
      try {
        // keepalive so the request outlives the page. sendBeacon can't set the
        // session cookie policy we need, so this is a keepalive fetch — through
        // fetchWithSessionGuard like every other call in this hook (the bare
        // fetch() was the one site skipping the stale-session guard).
        void fetchWithSessionGuard(`/api/calls/${callId}/end`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          credentials: "include",
          keepalive: true,
        });
      } catch {
        // Best effort — the mount-time reclaim covers a failure here.
      }
    };
    // `pagehide` fires where `beforeunload` doesn't (bfcache, mobile Safari).
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, []);

  useEffect(() => {
    const orphaned = orphanedCallId;
    if (!orphaned || orphaned.startsWith("tmp_")) return;
    // This tab was mid-call when it reloaded. End the call — idempotent, and a
    // no-op if the unload beacon already did it or the customer hung up.
    writeTabCallId(null);
    void fetchWithSessionGuard(`/api/calls/${orphaned}/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then((res) => {
        // Only tell the agent when WE ended a call that was still live —
        // otherwise every reload after a normal hangup would nag.
        if (!res.ok) return;
        return res
          .json()
          .then((body: { durationSeconds?: number | null }) => {
            if (body?.durationSeconds != null) {
              toast.message?.("Your call ended when the page reloaded.");
            }
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    // Mount-only: this is reload recovery, not an ongoing subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // SPA navigation mid-call: a client-side route change unmounts this hook
  // WITHOUT firing beforeunload/pagehide, so the tab-close beacon above never
  // runs. Without this cleanup the mic stays hot (browser recording indicator
  // stays on) and the RTCPeerConnection leaks, and the customer is left in a
  // one-sided call until the ICE timeout. Release the hardware and, for a real
  // (non-tmp) call, tell the server to end it. Empty deps so this runs ONLY on
  // true unmount — never mid-call (refs are always current inside the cleanup).
  useEffect(() => {
    return () => {
      const live = liveCallRef.current;
      if (live && !live.callId.startsWith("tmp_")) {
        try {
          navigator.sendBeacon?.(
            `/api/calls/${live.callId}/end`,
            new Blob([JSON.stringify({})], { type: "application/json" }),
          );
        } catch {
          // best-effort — nothing more we can do as the component unmounts
        }
      }
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
    };
  }, []);

  // Ring timeout. A call can sit in "ringing" indefinitely if the terminal
  // `call:ended` frame is missed (socket drop / throttled tab / the 30s
  // connection-state-recovery window exceeded) AND the PC never reaches a
  // failed state because no answer was ever applied — leaving the mic hot.
  // Meta stops ringing well before 60s, so this backstop terminates a stuck
  // ring: POST /end for a real call, then tear down. Re-arms whenever a new
  // call starts ringing; cleared the moment it's answered (→ in_progress),
  // torn down, or the tmp_→real callId rebinds.
  useEffect(() => {
    if (liveCall?.status !== "ringing") return;
    const RING_TIMEOUT_MS = 60_000;
    const timer = setTimeout(() => {
      const live = liveCallRef.current;
      if (!live || live.status !== "ringing") return;
      if (!live.callId.startsWith("tmp_")) {
        void fetchWithSessionGuard(`/api/calls/${live.callId}/end`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }).catch(() => undefined);
      }
      tearDown();
      toast.info("No answer");
    }, RING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [liveCall?.status, liveCall?.callId, tearDown]);

  /**
   * Build an RTCPeerConnection with mic capture, remote-audio routing,
   * and a connection-state watcher that auto-terminates on disconnect.
   */
  const setupPeer = useCallback(async (): Promise<RTCPeerConnection> => {
    // Release any prior call's hardware FIRST. A rapid re-dial (or any path that
    // builds a fresh PC without a clean teardown in between) would otherwise
    // overwrite localStreamRef/pcRef and orphan the previous getUserMedia
    // stream, leaving the mic live (Chrome's recording dot stays lit).
    releaseMedia();
    const pc = new RTCPeerConnection(DEFAULT_RTC_CONFIG);

    // Local mic → outbound audio track. EXACTLY ONE, by contract, not
    // convenience: WhatsApp's media relay handles a single audio SSRC per
    // peer, and Meta documents multiple SSRCs as undefined behavior up to
    // "total media failure" (calling integration-patterns doc, mandatory
    // requirements). So never addTrack a second audio source here (screen
    // audio, hold music, a second mic) — mix into this one track via the Web
    // Audio API instead if that day comes. getUserMedia({audio:true}) yields
    // one track per spec; the [0] pin makes the invariant explicit.
    const local = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    localStreamRef.current = local;
    const micTrack = local.getAudioTracks()[0];
    if (micTrack) pc.addTrack(micTrack, local);

    // Remote audio → hidden <audio> element so the user can hear it.
    pc.ontrack = (e) => {
      const el = remoteAudioElRef.current;
      if (el && e.streams[0]) {
        el.srcObject = e.streams[0];
      }
      if (e.streams[0]) {
        remoteStreamRef.current = e.streams[0];
        const rec = recorderRef.current;
        if (rec && e.track !== rec.remoteTrack) {
          // Renegotiation replaced the remote media mid-recording. Compare
          // TRACKS, not streams: under unified-plan the renegotiated track
          // usually arrives inside the SAME MediaStream object, so a stream
          // comparison misses it — and a MediaStreamAudioSourceNode binds at
          // construction, so without a rebind the customer leg records
          // silence for the rest of the file (the -91 dBFS class).
          rebindRecorderRemoteSource(e.streams[0], e.track);
        } else if (!rec) {
          // Both legs may now exist — the recorder start is idempotent and
          // guards on the armed flag, so calling from here AND from the
          // connected state covers either arrival order.
          startInAppRecorder();
        }
      }
    };

    // Connection-state lifecycle. `failed`/`closed` are TERMINAL — tear down
    // immediately AND POST /end so the audit row gets a terminal status (don't
    // wait on Meta's lag-prone terminate webhook).
    //
    // `disconnected`, however, is frequently TRANSIENT per the WebRTC spec — a
    // brief packet-loss blip, a WiFi hop, an interface switch — and routinely
    // recovers to `connected` on its own. Ending the call on it would drop live
    // customer calls on a 1-2s network blip ("calls keep cutting out"). So we
    // give `disconnected` a grace window: arm a timer and only end if the state
    // hasn't recovered when it fires. A return to `connected`/`connecting`
    // clears the timer. (Meta still ends the call its own side if the media leg
    // is truly gone, and the server-side stale-calls sweeper is the final
    // backstop — so a grace window can't strand a dead call.)
    //
    // teardownFired makes the terminal path one-shot (disconnected → failed →
    // closed each fire this handler; server-side endCall is idempotent but the
    // redundant POSTs are waste). Per-call — setupPeer builds a fresh closure.
    const DISCONNECT_GRACE_MS = 8_000;
    let teardownFired = false;
    const fireTeardown = () => {
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
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed" || state === "closed") {
        clearDisconnectGrace();
        fireTeardown();
      } else if (state === "disconnected") {
        // Don't kill the call yet — wait out the grace window. If still not
        // recovered when it fires, end it. Re-arm guard: only one timer.
        if (disconnectGraceRef.current === null && !teardownFired) {
          disconnectGraceRef.current = window.setTimeout(() => {
            disconnectGraceRef.current = null;
            // Re-check: a recovery between the timer firing and now would have
            // moved us off `disconnected`. Only end if we're still degraded.
            const s = pcRef.current?.connectionState;
            if (s === "disconnected" || s === "failed") fireTeardown();
          }, DISCONNECT_GRACE_MS);
        }
      } else if (state === "connected" || state === "connecting") {
        // Recovered (or progressing) — cancel any pending disconnect teardown.
        clearDisconnectGrace();
        if (state === "connected") startInAppRecorder();
      }
    };

    pcRef.current = pc;
    return pc;
  }, [tearDown, releaseMedia, clearDisconnectGrace, startInAppRecorder, rebindRecorderRemoteSource]);

  /**
   * Finish a two-hop accept: hold our audio, wait for the peer connection to
   * come up, tell the server to issue the real `accept`, then speak.
   *
   * The muting is the point. The provider requires the accept to land after the
   * WebRTC connection is established, and warns that media flowing before its
   * 200 means the caller misses the start of the conversation — so the agent's
   * mic stays disabled across the whole handshake.
   *
   * Falls through to unmuted on any failure: a call where the first word might
   * clip is strictly better than one the agent can never be heard on. Respects
   * an explicit mute — if the agent muted themselves during setup, we leave
   * them muted.
   */
  const completePendingAccept = useCallback(
    async (pc: RTCPeerConnection, callId: string, localSdp: string) => {
      const stream = localStreamRef.current;
      const held = stream?.getAudioTracks().filter((t) => t.enabled) ?? [];
      for (const t of held) t.enabled = false;
      try {
        await waitForPeerConnected(pc);
        await fetchWithSessionGuard(`/api/calls/${callId}/accept-media`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sdp: localSdp }),
        });
      } catch (err) {
        console.warn("[useCall] completing accept failed", err);
      } finally {
        // Only re-enable tracks WE disabled, so a mid-handshake mute sticks.
        for (const t of held) t.enabled = true;
      }
    },
    [],
  );

  const answerIncoming = useCallback(
    async (
      callId: string,
      contactName: string,
      conversationId: string,
      channel: Channel,
      accountId?: string | null,
    ) => {
      setError(null);
      // Single peer connection (1:1, see the contract note up top). Answering
      // a DIFFERENT call while one is live would tear down the live call's
      // media (setupPeer → releaseMedia) with no /end for it — refuse instead.
      // busyRef also refuses while an outbound dial (or another answer) is
      // mid-setup — liveCallRef is still null then, so without it an Answer click
      // would destroy that in-flight PC via setupPeer → releaseMedia.
      if (
        busyRef.current ||
        (liveCallRef.current && liveCallRef.current.callId !== callId)
      ) {
        toast.error("End your current call before answering another one.");
        return;
      }
      // WhatsApp delivers the customer's SDP OFFER via webhook (call:sdp_offer →
      // pendingOffersRef) and we answer it. A social (Messenger) call carries NO
      // webhook offer — Meta expects the BUSINESS to generate the offer on
      // accept and returns the answer synchronously from POST /answer. Branch on
      // the channel: without this, a social answer waited forever for an offer
      // that never arrives and failed with "still connecting".
      const isSocialAnswer = !isPhoneChannel(channel);
      const offer = pendingOffersRef.current.get(callId);
      if (!isSocialAnswer && !offer) {
        // Use fail() (which toasts) not bare setError(): the incoming card was
        // optimistically dismissed and CallPanel only renders when liveCall !=
        // null (still null here), so a setError message would never be seen.
        fail("The call is still connecting — try again in a moment.");
        return;
      }

      busyRef.current = true;
      try {
        const pc = await setupPeer();
        // Build the local SDP: an OFFER for a social answer (Meta answers it), or
        // an ANSWER to the customer's stashed offer for WhatsApp.
        let localSdp: string;
        if (isSocialAnswer) {
          const localOffer = await pc.createOffer({ offerToReceiveAudio: true });
          await pc.setLocalDescription(localOffer);
          localSdp = localOffer.sdp ?? "";
        } else {
          await pc.setRemoteDescription({ type: "offer", sdp: offer!.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          localSdp = answer.sdp ?? "";
        }

        const startedAt = Date.now();
        setLiveCall({
          callId,
          conversationId,
          contactName,
          channel,
          accountId: accountId ?? null,
          direction: "in",
          status: "in_progress",
          startedAt,
          answeredAt: startedAt,
        });

        const res = await fetchWithSessionGuard(`/api/calls/${callId}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sdp: localSdp }),
        });
        if (!res.ok) {
          fail(
            res.status === 409
              ? "Another teammate already picked up this call."
              : res.status === 403
                ? "You don't have permission to answer calls."
                : "Couldn't accept the call. Try again.",
          );
          tearDown();
          return;
        }
        // Social: Meta returns the SDP answer synchronously from the accept
        // (same as the outbound `connect` path) — apply it so media negotiates.
        // WhatsApp completed its media locally above and returns no SDP body.
        // (A `sdpRenegotiation` offer, if Meta ever sends one, is not applied
        // here — the outbound path doesn't either; that's the media-update gap.)
        const answerBody = (await res.json().catch(() => ({}))) as {
          sdpAnswer?: string;
          acceptPending?: boolean;
          recordInApp?: boolean;
        };
        // Arm the in-app recorder for this call (artifact mode "inapp"). The
        // connection usually establishes AFTER this response, so the
        // connected-state hook starts it; the direct attempt covers the
        // social path where the answer applies synchronously.
        recordArmedRef.current = answerBody.recordInApp === true;
        if (recordArmedRef.current) startInAppRecorder();
        if (isSocialAnswer && answerBody.sdpAnswer) {
          await pc.setRemoteDescription({ type: "answer", sdp: answerBody.sdpAnswer });
        }
        // WhatsApp answers in two hops: the POST above was `pre_accept`, which
        // lets the WebRTC connection establish; the real `accept` must follow
        // once it has. Stay silent until that lands — media flowing before the
        // accept costs the caller the first words they speak.
        if (answerBody.acceptPending) {
          await completePendingAccept(pc, callId, localSdp);
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
          workspaceId: "",
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
      } finally {
        busyRef.current = false;
      }
    },
    [setupPeer, tearDown, fail, completePendingAccept, startInAppRecorder],
  );

  const initiateOutbound = useCallback(
    async (
      conversationId: string,
      contactName: string,
      channel?: Channel | null,
      accountId?: string | null,
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      // Fresh call ⇒ fresh pickup gate (teardown also resets it; this covers
      // any path that reaches a new dial without a clean teardown between).
      outboundAnsweredRef.current = false;
      setError(null);

      // Single peer connection (1:1). If a call is already live — or another
      // call setup is mid-flight — refuse rather than silently dropping the
      // in-flight call's media (setupPeer → releaseMedia closes the existing PC
      // without POSTing /end for it). liveCallRef is null through the whole async
      // setup window below, so busyRef is the synchronous guard that stops a
      // double-click on the Phone button from placing TWO real Meta calls and
      // orphaning the first mic stream. The entry-point buttons are also disabled
      // while live; this is the backstop. (Check a local copy of liveCallRef so
      // this guard doesn't permanently narrow liveCallRef.current to null for
      // the rebind logic further down.)
      const alreadyLive = liveCallRef.current;
      if (busyRef.current || alreadyLive) {
        return { ok: false, reason: "call_in_progress" };
      }
      busyRef.current = true;
      try {
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
          channel: channel ?? null,
          accountId: accountId ?? null,
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
            // Messenger only — Meta returns the SDP answer synchronously from the
            // `connect` call. WhatsApp omits it (its answer arrives via webhook).
            sdpAnswer?: string;
            recordInApp?: boolean;
          };
          // Arm the in-app recorder (artifact mode "inapp") — it starts once
          // the media leg reaches `connected`, after the rebind below gives
          // the live call its REAL id.
          recordArmedRef.current = body.recordInApp === true;
          if (!res.ok || body.ok === false) {
            tearDown();
            return { ok: false, reason: body.reason ?? `http_${res.status}` };
          }
          // Rebind to Meta's real callId so both the `call:ended` frame AND the
          // answer frame (now matched by callId, not PC state) target this call.
          const realCallId = body.callId ?? tempCallId;
          // Agent already hit End during the tmp window → terminate the real Meta
          // call now so the customer stops ringing. Our UI is already torn down;
          // just fire /end and bail (don't rebind/drain a call we're killing).
          if (cancelledTmpIdsRef.current.has(tempCallId)) {
            cancelledTmpIdsRef.current.delete(tempCallId);
            void fetchWithSessionGuard(`/api/calls/${realCallId}/end`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            }).catch(() => undefined);
            tearDown();
            return { ok: false, reason: "cancelled" };
          }
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
          // Same drain for a stashed PICKUP frame: without it a fast customer
          // answer that beat this rebind leaves the recorder gate closed and
          // the status on `ringing` until the ring-timeout kills a call two
          // people are talking on.
          const stashedAnswered = pendingAnsweredRef.current.get(realCallId);
          if (stashedAnswered !== undefined) {
            pendingAnsweredRef.current.delete(realCallId);
            applyOutboundAnswered(realCallId, stashedAnswered);
          }
          // Messenger: the answer came back in THIS response (not a webhook), so
          // apply it directly. Reuses the same have-local-offer → setRemote path;
          // WhatsApp responses carry no sdpAnswer, so this is a no-op there.
          if (body.sdpAnswer) {
            void applyOutboundAnswer(realCallId, body.sdpAnswer);
          }
          return { ok: true };
        } catch {
          tearDown();
          return { ok: false, reason: "network_error" };
        }
      } finally {
        busyRef.current = false;
      }
    },
    [setupPeer, tearDown, applyOutboundAnswer, applyOutboundAnswered],
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
    // Cancelled before placeCall returned the real id: /end can't target a call
    // that doesn't exist yet. Record the tmp id so initiateOutbound terminates
    // the REAL Meta call the moment it lands, then tear down our side now. Without
    // this the customer keeps ringing even though the agent already hung up.
    if (current.callId.startsWith("tmp_")) {
      cancelledTmpIdsRef.current.add(current.callId);
      tearDown();
      return;
    }
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
