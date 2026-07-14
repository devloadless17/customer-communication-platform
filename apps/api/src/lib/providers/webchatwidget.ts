/**
 * Website chat-widget provider — a FIRST-PARTY channel with no external vendor.
 *
 * Unlike the Meta providers, `sendText`/`sendMedia` do NOT call out over the wire:
 * the outbound pipeline persists the Message and publishes `message.sent` as usual,
 * and the visitor's browser receives it through the realtime fanout hook (see
 * apps/api/src/realtime/realtime-fanout.service.ts → WebchatwidgetGateway). So the
 * provider's only job here is to mint a synthetic `externalId` (the dedupe key /
 * message id) and report success — the transport is the socket, not this call.
 *
 * Inbound isn't a webhook either: the visitor gateway builds
 * `NormalizedInboundMessage[]` directly and hands them to the same `ingestEvents`,
 * so `parseWebhook` is unused (returns []). Media bytes live in R2 before the
 * message is created (the widget uploads them via the public endpoint, and the
 * agent composer uploads outbound media like every other channel), so there is no
 * `uploadMedia`/`fetchMedia` to implement.
 */

import { randomUUID } from "node:crypto";

import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import type {
  MessagingProvider,
  NormalizedEvent,
  SendMediaArgs,
  SendTextArgs,
  SendTextResult,
} from "@ccp/shared/providers/types";

import type { WebchatwidgetSendConfig } from "@/lib/providers/webchatwidget-config";

/** A locally-minted message id for a widget send (no vendor id exists). */
function mintExternalId(): string {
  return `wc_${randomUUID()}`;
}

export const webchatwidgetProvider: MessagingProvider<WebchatwidgetSendConfig> = {
  name: "webchatwidget",
  capabilities: CHANNEL_CAPABILITIES.webchatwidget,

  // No webhook path — the visitor gateway normalizes frames itself.
  parseWebhook(): NormalizedEvent[] {
    return [];
  },

  // First-party: no network call. Persist + message.sent (done by the caller) is
  // the send; the visitor sees it via the realtime fanout. `replyToExternalId`
  // rides through on the persisted row and is carried to the visitor frame.
  async sendText(_args: SendTextArgs, _config: WebchatwidgetSendConfig): Promise<SendTextResult> {
    return { externalId: mintExternalId(), timestamp: new Date() };
  },

  // Same as sendText — the media bytes already live in R2; the fanout carries the
  // same-origin URL + caption to the visitor. Caption inlines (see
  // supportsInlineCaption("webchatwidget", …) === true), so no follow-up split.
  async sendMedia(_args: SendMediaArgs, _config: WebchatwidgetSendConfig): Promise<SendTextResult> {
    return { externalId: mintExternalId(), timestamp: new Date() };
  },
};
