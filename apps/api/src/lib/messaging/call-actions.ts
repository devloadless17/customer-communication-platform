/**
 * Channel-agnostic calling adapter. Meta ships TWO business-calling APIs with
 * different shapes:
 *
 *   - WhatsApp — method-per-action (`placeCall` / `preAcceptCall` + `acceptCall`
 *     / `rejectCall` / `endCall`); the SDP answer for a placed/accepted call
 *     arrives LATER via webhook, so these return no SDP.
 *   - Messenger — a single `callAction` (`connect`/`accept`/`reject`/`terminate`)
 *     that returns the SDP answer SYNCHRONOUSLY (see docs/messenger-calling.md).
 *
 * CallsService should not care which. These helpers dispatch on whichever the
 * channel's provider implements and normalize the result, so the service +
 * controller carry an optional `sdpAnswer`/`sdpRenegotiation` that is populated
 * for Messenger and absent for WhatsApp (whose browser waits for the webhook).
 */

import { requireProviderMethod } from "@/lib/providers";
import type { Channel } from "@ccp/shared/types";
import type {
  CallRecordingOptions,
  MessagingProvider,
} from "@ccp/shared/providers/types";

export interface PlaceCallResult {
  externalCallId: string;
  /** Messenger returns the answer immediately; WhatsApp delivers it by webhook. */
  sdpAnswer?: string;
}
export interface AnswerCallResult {
  /** Messenger `accept` returns an answer (+ optional renegotiation offer). */
  sdpAnswer?: string;
  sdpRenegotiation?: string;
}
export interface MediaUpdateResult {
  /** Meta may answer our renegotiation (+ chain another renegotiation offer). */
  sdpAnswer?: string;
  sdpRenegotiation?: string;
}

/** True when this channel uses Meta's unified `callAction` (Messenger). */
export function usesUnifiedCalling(provider: MessagingProvider): boolean {
  return typeof provider.callAction === "function";
}

/**
 * Place an outbound call, forwarding the browser's SDP offer. The callee is
 * identified by `to` (phone) or `recipient` (business-scoped user id) — a cold
 * caller may have only the latter.
 */
export async function providerPlaceCall(
  provider: MessagingProvider,
  channel: Channel,
  config: unknown,
  args: {
    to?: string;
    recipient?: string;
    sdpOffer: string;
    correlationId?: string;
    recording?: CallRecordingOptions;
  },
): Promise<PlaceCallResult> {
  if (provider.callAction) {
    // Unified calling has no BSUID notion — the PSID arrives as `to`.
    const to = args.to ?? args.recipient;
    if (!to) throw new Error(`${channel} connect needs a recipient`);
    const r = await provider.callAction({ action: "connect", to, sdp: args.sdpOffer }, config);
    if (!r.callId) throw new Error(`${channel} connect returned no call id`);
    return { externalCallId: r.callId, sdpAnswer: r.sdpAnswer };
  }
  const placeCall = requireProviderMethod(provider, "placeCall", channel);
  const r = await placeCall(args, config);
  return { externalCallId: r.externalCallId };
}

/**
 * FIRST half of answering an incoming call: tell the provider we're taking it
 * and hand over the browser's SDP, so the WebRTC connection can establish.
 *
 * `sdp` is what the browser produced — for WhatsApp an ANSWER, for Messenger an
 * OFFER (Messenger's accept flow has the business offer). The browser knows
 * which it made; the provider carries it either way.
 *
 * WhatsApp splits this into pre_accept (here) and accept
 * (`providerCompleteAccept`, once media is up). That split is the whole point
 * of pre_accept: media must not flow until accept returns, or the caller loses
 * the first words of the call. Messenger has no such step, so its single accept
 * happens here and completion is a no-op.
 *
 * `acceptPending` tells the caller whether a completion step is still owed.
 */
export async function providerAnswerCall(
  provider: MessagingProvider,
  channel: Channel,
  config: unknown,
  args: { externalCallId: string; sdp: string },
): Promise<AnswerCallResult & { acceptPending: boolean }> {
  if (provider.callAction) {
    const r = await provider.callAction(
      { action: "accept", callId: args.externalCallId, sdp: args.sdp },
      config,
    );
    return {
      sdpAnswer: r.sdpAnswer,
      sdpRenegotiation: r.sdpRenegotiation,
      acceptPending: false,
    };
  }
  const preAccept = requireProviderMethod(provider, "preAcceptCall", channel);
  await preAccept({ externalCallId: args.externalCallId, sdpAnswer: args.sdp }, config);
  return { acceptPending: true };
}

/**
 * SECOND half: issue the actual `accept` once the browser reports its WebRTC
 * connection established. Carries the SAME SDP as the pre_accept (the provider
 * requires them to match). The browser may only start sending audio after this
 * resolves.
 *
 * No-op for unified calling, which accepted in one hop.
 */
export async function providerCompleteAccept(
  provider: MessagingProvider,
  channel: Channel,
  config: unknown,
  args: {
    externalCallId: string;
    sdp: string;
    correlationId?: string;
    recording?: CallRecordingOptions;
  },
): Promise<void> {
  if (provider.callAction) return;
  const accept = requireProviderMethod(provider, "acceptCall", channel);
  await accept(
    {
      externalCallId: args.externalCallId,
      sdpAnswer: args.sdp,
      ...(args.correlationId ? { correlationId: args.correlationId } : {}),
      ...(args.recording ? { recording: args.recording } : {}),
    },
    config,
  );
}

/**
 * Decline an incoming call before answer. No reason is sent to the provider —
 * its reject action takes only the call id, and an undocumented extra field
 * risks the whole request failing, which would leave the customer's phone
 * ringing after the agent declined. Any reason stays local.
 */
export async function providerRejectCall(
  provider: MessagingProvider,
  channel: Channel,
  config: unknown,
  args: { externalCallId: string },
): Promise<void> {
  if (provider.callAction) {
    await provider.callAction({ action: "reject", callId: args.externalCallId }, config);
    return;
  }
  const reject = requireProviderMethod(provider, "rejectCall", channel);
  await reject(args, config);
}

/**
 * Answer a mid-call media renegotiation. Meta (Messenger) can send a post-pickup
 * `media_update` webhook carrying a new SDP OFFER; the browser generates the
 * answer and we relay it back via the unified `media_update` action. Unified
 * calling only — WhatsApp has no such flow (it never delivers a live
 * renegotiation offer on the call:sdp_offer path), so this throws for it.
 */
export async function providerMediaUpdate(
  provider: MessagingProvider,
  channel: Channel,
  config: unknown,
  args: { externalCallId: string; sdp: string },
): Promise<MediaUpdateResult> {
  if (provider.callAction) {
    const r = await provider.callAction(
      { action: "media_update", callId: args.externalCallId, sdp: args.sdp },
      config,
    );
    return { sdpAnswer: r.sdpAnswer, sdpRenegotiation: r.sdpRenegotiation };
  }
  throw new Error(`${channel} does not support mid-call media renegotiation`);
}

/** Hang up / terminate a call from our side. */
export async function providerEndCall(
  provider: MessagingProvider,
  channel: Channel,
  config: unknown,
  args: { externalCallId: string },
): Promise<void> {
  if (provider.callAction) {
    await provider.callAction({ action: "terminate", callId: args.externalCallId }, config);
    return;
  }
  const end = requireProviderMethod(provider, "endCall", channel);
  await end(args, config);
}
