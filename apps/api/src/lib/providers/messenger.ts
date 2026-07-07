/**
 * Facebook Messenger provider — a thin wrapper over the shared social logic in
 * `meta-social.ts` (Messenger and Instagram are the same wire shape). Inbound
 * webhooks are `{ object: "page", entry[].messaging[] }`, identity is the
 * Page-Scoped ID (PSID), outbound hits `POST /{PAGE_ID}/messages`.
 *
 * Scope (first increment): inbound TEXT + delivery status, outbound TEXT. Media
 * (in/out), read/typing marks, and sender-name enrichment are follow-ups —
 * see `CHANNEL_CAPABILITIES.messenger` in @ccp/shared.
 */

import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import type {
  MessagingProvider,
  NormalizedEvent,
  SendInteractiveArgs,
  SendMediaArgs,
  SendTextArgs,
  SendTextResult,
  UploadMediaArgs,
  UploadMediaResult,
} from "@ccp/shared/providers/types";
import {
  fetchSocialProfileName,
  parseSocialMessaging,
  sendSocialInteractive,
  sendSocialMedia,
  sendSocialSenderAction,
  sendSocialText,
  uploadSocialMedia,
} from "@/lib/providers/meta-social";
import type { MessengerSendConfig } from "@/lib/providers/messenger-config";

/** The Page id + token that address a Messenger send. */
function target(config: MessengerSendConfig) {
  return {
    accountId: config.pageId,
    accessToken: config.pageAccessToken,
    graphVersion: config.graphVersion,
    label: "messenger",
  };
}

export const messengerProvider: MessagingProvider<MessengerSendConfig> = {
  name: "messenger",
  capabilities: CHANNEL_CAPABILITIES.messenger,

  parseWebhook(payload: unknown): NormalizedEvent[] {
    return parseSocialMessaging(payload, "page");
  },

  async sendText(
    args: SendTextArgs,
    config: MessengerSendConfig,
  ): Promise<SendTextResult> {
    return sendSocialText(args, target(config));
  },

  async uploadMedia(
    args: UploadMediaArgs,
    config: MessengerSendConfig,
  ): Promise<UploadMediaResult> {
    return uploadSocialMedia(args, target(config));
  },

  async sendMedia(
    args: SendMediaArgs,
    config: MessengerSendConfig,
  ): Promise<SendTextResult> {
    return sendSocialMedia(args, target(config));
  },

  async sendInteractive(
    args: SendInteractiveArgs,
    config: MessengerSendConfig,
  ): Promise<SendTextResult> {
    return sendSocialInteractive(args, target(config));
  },

  // Read receipt: mark the whole thread seen by the recipient (PSID). Meta
  // social has no per-message read state, so `externalId` is unused.
  async markIncomingRead(
    _externalId: string,
    config: MessengerSendConfig,
    recipientId?: string,
  ): Promise<void> {
    if (!recipientId) return;
    await sendSocialSenderAction("mark_seen", recipientId, target(config));
  },

  // "typing…" bubble to the recipient (PSID). Auto-dismisses provider-side.
  async sendTypingIndicator(
    _externalId: string,
    config: MessengerSendConfig,
    recipientId?: string,
  ): Promise<void> {
    if (!recipientId) return;
    await sendSocialSenderAction("typing_on", recipientId, target(config));
  },

  async fetchContactProfile(
    externalId: string,
    config: MessengerSendConfig,
  ): Promise<{ name: string | null }> {
    const name = await fetchSocialProfileName(externalId, {
      accessToken: config.pageAccessToken,
      graphVersion: config.graphVersion,
      fields: "name",
    });
    return { name };
  },
};
