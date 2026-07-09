/**
 * Instagram DM provider — a thin wrapper over the shared social logic in
 * `meta-social.ts` (Instagram and Messenger are the same wire shape). Inbound
 * webhooks are `{ object: "instagram", entry[].messaging[] }`, identity is the
 * Instagram-Scoped ID (IGSID), outbound hits `POST /{IG_ID}/messages`.
 *
 * Scope (first increment): inbound TEXT + delivery status, outbound TEXT. Media
 * (in/out), read/typing marks, and sender-name enrichment are follow-ups —
 * see `CHANNEL_CAPABILITIES.instagram` in @ccp/shared.
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
import type { InstagramSendConfig } from "@/lib/providers/instagram-config";

/**
 * Address an Instagram send through the linked Facebook Page — NOT the IG id.
 * Instagram-via-Facebook-Login sends over `POST /{pageId}/messages` (recipient
 * = the IGSID) with a Page access token, exactly like Messenger; the recipient
 * id routes it to Instagram. `/{igId}/messages` is the Instagram-Login
 * (graph.instagram.com) pattern and returns `(#3)` on graph.facebook.com.
 */
function target(config: InstagramSendConfig) {
  return {
    accountId: config.pageId,
    accessToken: config.igAccessToken,
    graphVersion: config.graphVersion,
    label: "instagram",
  };
}

export const instagramProvider: MessagingProvider<InstagramSendConfig> = {
  name: "instagram",
  capabilities: CHANNEL_CAPABILITIES.instagram,

  parseWebhook(payload: unknown): NormalizedEvent[] {
    return parseSocialMessaging(payload, "instagram");
  },

  async sendText(
    args: SendTextArgs,
    config: InstagramSendConfig,
  ): Promise<SendTextResult> {
    return sendSocialText(args, target(config));
  },

  async uploadMedia(
    args: UploadMediaArgs,
    config: InstagramSendConfig,
  ): Promise<UploadMediaResult> {
    return uploadSocialMedia(args, target(config));
  },

  async sendMedia(
    args: SendMediaArgs,
    config: InstagramSendConfig,
  ): Promise<SendTextResult> {
    return sendSocialMedia(args, target(config));
  },

  async sendInteractive(
    args: SendInteractiveArgs,
    config: InstagramSendConfig,
  ): Promise<SendTextResult> {
    return sendSocialInteractive(args, target(config));
  },

  async markIncomingRead(
    _externalId: string,
    config: InstagramSendConfig,
    recipientId?: string,
  ): Promise<void> {
    if (!recipientId) return;
    await sendSocialSenderAction("mark_seen", recipientId, target(config));
  },

  async sendTypingIndicator(
    _externalId: string,
    config: InstagramSendConfig,
    recipientId?: string,
  ): Promise<void> {
    if (!recipientId) return;
    await sendSocialSenderAction("typing_on", recipientId, target(config));
  },

  async fetchContactProfile(
    externalId: string,
    config: InstagramSendConfig,
  ): Promise<{ name: string | null }> {
    // Instagram exposes `name` and `username`; prefer the real name, fall back
    // to @username (both are useful; the helper returns whichever is present).
    const name = await fetchSocialProfileName(externalId, {
      accessToken: config.igAccessToken,
      graphVersion: config.graphVersion,
      fields: "name,username",
    });
    return { name };
  },
};
