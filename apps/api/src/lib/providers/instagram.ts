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
  SendReactionArgs,
  SendTextArgs,
  SendTextResult,
  UploadMediaArgs,
  UploadMediaResult,
} from "@ccp/shared/providers/types";
import {
  fetchSocialProfile,
  type SocialContactProfile,
  parseSocialMessaging,
  sendSocialInteractive,
  sendSocialMedia,
  sendSocialReaction,
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
    ...(config.appSecret ? { appSecret: config.appSecret } : {}),
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

  async sendReaction(
    args: SendReactionArgs,
    config: InstagramSendConfig,
  ): Promise<SendTextResult> {
    return sendSocialReaction(args, target(config));
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
    active: boolean = true,
  ): Promise<void> {
    if (!recipientId) return;
    await sendSocialSenderAction(active ? "typing_on" : "typing_off", recipientId, target(config));
  },

  async fetchContactProfile(
    externalId: string,
    config: InstagramSendConfig,
  ): Promise<SocialContactProfile> {
    // Instagram exposes the richest identity of the three Meta channels: name,
    // @username, profile_pic PLUS follower_count / verified / follow-relationship
    // signals. We pull them all so ingest can persist the @handle, avatar, and
    // the richer `socialProfile` context shown in the contact panel.
    return fetchSocialProfile(externalId, {
      accessToken: config.igAccessToken,
      graphVersion: config.graphVersion,
      fields:
        "name,username,profile_pic,follower_count,is_verified_user,is_user_follow_business,is_business_follow_user",
      // The follow/verified signals need `instagram_manage_messages` on a
      // business-linked account; without it Graph rejects the whole node
      // request, so fall back to the identity core rather than lose the handle.
      fallbackFields: "name,username,profile_pic",
      label: "instagram",
    });
  },
};
