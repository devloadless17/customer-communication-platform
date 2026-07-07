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
  SendTextArgs,
  SendTextResult,
} from "@ccp/shared/providers/types";
import { parseSocialMessaging, sendSocialText } from "@/lib/providers/meta-social";
import type { MessengerSendConfig } from "@/lib/providers/messenger-config";

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
    return sendSocialText(args, {
      accountId: config.pageId,
      accessToken: config.pageAccessToken,
      graphVersion: config.graphVersion,
      label: "messenger",
    });
  },
};
