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
  SendTextArgs,
  SendTextResult,
} from "@ccp/shared/providers/types";
import {
  fetchSocialProfileName,
  parseSocialMessaging,
  sendSocialText,
} from "@/lib/providers/meta-social";
import type { InstagramSendConfig } from "@/lib/providers/instagram-config";

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
    return sendSocialText(args, {
      accountId: config.igId,
      accessToken: config.igAccessToken,
      graphVersion: config.graphVersion,
      label: "instagram",
    });
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
