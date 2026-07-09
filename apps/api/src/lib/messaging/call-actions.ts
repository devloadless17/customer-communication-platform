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
import type { MessagingProvider } from "@ccp/shared/providers/types";

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

/** True when this channel uses Meta's unified `callAction` (Messenger). */
export function usesUnifiedCalling(provider: MessagingProvider): boolean {
  return typeof provider.callAction === "function";
}

/** Place an outbound call, forwarding the browser's SDP offer. */
export async function providerPlaceCall(
  provider: MessagingProvider,
  channel: Channel,
  config: unknown,
  args: { to: string; sdpOffer: string; from?: string },
): Promise<PlaceCallResult> {
  if (provider.callAction) {
    const r = await provider.callAction({ action: "connect", to: args.to, sdp: args.sdpOffer }, config);
    if (!r.callId) throw new Error(`${channel} connect returned no call id`);
    return { externalCallId: r.callId, sdpAnswer: r.sdpAnswer };
  }
  const placeCall = requireProviderMethod(provider, "placeCall", channel);
  const r = await placeCall(args, config);
  return { externalCallId: r.externalCallId };
}

/**
 * Answer an incoming call. `sdp` is what the browser produced — for WhatsApp an
 * ANSWER, for Messenger an OFFER (Messenger's accept flow has the business
 * offer). The provider carries it either way; the browser knows which it made.
 */
export async function providerAnswerCall(
  provider: MessagingProvider,
  channel: Channel,
  config: unknown,
  args: { externalCallId: string; sdp: string },
): Promise<AnswerCallResult> {
  if (provider.callAction) {
    const r = await provider.callAction(
      { action: "accept", callId: args.externalCallId, sdp: args.sdp },
      config,
    );
    return { sdpAnswer: r.sdpAnswer, sdpRenegotiation: r.sdpRenegotiation };
  }
  // WhatsApp: pre_accept THEN accept, both carrying the same SDP answer.
  const preAccept = requireProviderMethod(provider, "preAcceptCall", channel);
  const accept = requireProviderMethod(provider, "acceptCall", channel);
  await preAccept({ externalCallId: args.externalCallId, sdpAnswer: args.sdp }, config);
  await accept({ externalCallId: args.externalCallId, sdpAnswer: args.sdp }, config);
  return {};
}

/** Decline an incoming call before answer. */
export async function providerRejectCall(
  provider: MessagingProvider,
  channel: Channel,
  config: unknown,
  args: { externalCallId: string; reason?: "busy" | "declined" },
): Promise<void> {
  if (provider.callAction) {
    await provider.callAction({ action: "reject", callId: args.externalCallId }, config);
    return;
  }
  const reject = requireProviderMethod(provider, "rejectCall", channel);
  await reject(args, config);
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
