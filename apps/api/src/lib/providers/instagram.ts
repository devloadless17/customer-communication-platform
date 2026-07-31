/**
 * Instagram DM provider — a thin wrapper over the shared social logic in
 * `meta-social.ts` (Instagram and Messenger are the same wire shape).
 *
 *  - Inbound: `{ object: "instagram", entry[].messaging[] }`. `entry[].id` is the
 *    INSTAGRAM professional-account id (Meta's own webhook reference annotates it
 *    "ID of your Instagram Professional account"), which is why an Instagram
 *    `ChannelConnection.externalAccountId` stores the IG id and not the Page id —
 *    that is the key per-event account attribution resolves against.
 *  - Identity: the Instagram-Scoped ID (IGSID) of the person, per thread.
 *  - Outbound: `POST /{PAGE_ID}/messages` — see `target()` below for why the send
 *    host is the linked Page and not the IG id.
 *
 * Implemented against Meta's Instagram Messaging docs (re-verified 2026-07-30):
 * inbound + outbound text, image / video / audio / PDF, quick replies (13 max,
 * 20-char titles, `user_phone_number` consent chip), the `cta_url` link button as
 * a BUTTON TEMPLATE, business reactions (the single documented `love`), read +
 * typing sender actions, quoted replies (`reply_to.mid`), unsends, message edits,
 * native-inbox echoes, postbacks (icebreaker / template button taps), story
 * mentions & replies, ad / `ig.me` / Instagram-Shop referral attribution, and
 * user blocking via the Moderate Conversations API. What Meta does NOT offer here
 * is recorded on `CHANNEL_CAPABILITIES.instagram` (no template catalog, no
 * delivery receipt, no calling) — read that map, never a `channel === …` check.
 */

import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";
import {
  getThreadOwner,
  INSTAGRAM_INBOX_APP_ID,
  passThreadControl,
  releaseThreadControl,
  requestThreadControl,
  takeThreadControl,
} from "@/lib/providers/messenger-handover";
import type {
  BlockUsersResult,
  ChannelEntryPoints,
  MessagingProvider,
  ThreadControlArgs,
  ThreadControlResult,
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
  getChannelEntryPoints,
  moderateSocialConversations,
  replyToSocialComment,
  setChannelEntryPoints,
} from "@/lib/providers/meta-social";
import type { InstagramSendConfig } from "@/lib/providers/instagram-config";

/**
 * Map the Moderate Conversations outcome onto the channel-agnostic
 * `BlockUsersResult` the generic block path consumes, so an Instagram block is
 * indistinguishable downstream from a WhatsApp one. `externalUserId` stays null:
 * Meta echoes no id back, and inventing one would misreport it.
 */
function toBlockUsersResult(res: {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
}): BlockUsersResult {
  return {
    succeeded: res.succeeded.map((input) => ({ input, externalUserId: null, error: null })),
    failed: res.failed.map((f) => ({
      input: f.id,
      externalUserId: null,
      error: { code: null, message: f.error, details: null },
    })),
  };
}

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

  /**
   * Block / unblock a person through the Moderate Conversations API. Meta caps a
   * request at 10 ids and refuses `block_user` and `unblock_user` in one body, so
   * each direction is its own call (see `moderateSocialConversations`).
   */
  async blockUsers(
    users: string[],
    config: InstagramSendConfig,
  ): Promise<BlockUsersResult> {
    return toBlockUsersResult(
      await moderateSocialConversations("block_user", users, target(config)),
    );
  },

  async unblockUsers(
    users: string[],
    config: InstagramSendConfig,
  ): Promise<BlockUsersResult> {
    return toBlockUsersResult(
      await moderateSocialConversations("unblock_user", users, target(config)),
    );
  },

  /**
   * Read the account's conversation ENTRY POINTS — the ice breakers and
   * persistent menu a customer sees before they have typed anything. Both live on
   * `/{page-id}/messenger_profile?platform=instagram`; see `meta-social.ts`.
   */
  async getEntryPoints(config: InstagramSendConfig): Promise<ChannelEntryPoints> {
    return getChannelEntryPoints(target(config));
  },

  async setEntryPoints(
    entryPoints: ChannelEntryPoints,
    config: InstagramSendConfig,
  ): Promise<void> {
    return setChannelEntryPoints(entryPoints, target(config));
  },

  /**
   * CONVERSATION ROUTING (thread control).
   *
   * The same Page-node endpoints Messenger uses, and they apply to Instagram
   * because Meta DISCONTINUED the Instagram Handover Protocol on 2025-10-23 and
   * migrated every business to Conversation Routing — the surface the parser has
   * been warning about on `entry.standby[]` all along.
   *
   * It matters here even though this app onboards as the sole customer-care app:
   * if a customer connects a routing-enabled bot that claims the primary
   * receiver, our real inbound arrives only on standby and an agent's reply
   * fails with `2018300`. `take` is the move that unblocks them.
   */
  async threadControl(
    args: ThreadControlArgs,
    config: InstagramSendConfig,
  ): Promise<ThreadControlResult> {
    const t = target(config);
    switch (args.action) {
      case "take":
        await takeThreadControl(args.to, t, args.metadata);
        break;
      case "request":
        await requestThreadControl(args.to, t, args.metadata);
        break;
      case "release":
        await releaseThreadControl(args.to, t);
        break;
      case "pass":
        // The INSTAGRAM inbox, not the Page inbox. Meta names two different
        // first-party targets — "use 263902037430900 for the Page Inbox and
        // 1217981644879628 for the Instagram Inbox" — and this provider was
        // defaulting to the Messenger one it inherited. Handing an Instagram
        // thread to the Page inbox sends it somewhere no Instagram agent is
        // looking, and the API accepts it, so nothing would have errored.
        await passThreadControl(
          args.to,
          args.targetAppId ?? INSTAGRAM_INBOX_APP_ID,
          t,
          args.metadata,
        );
        break;
    }
    // Re-read rather than assume — a `request` is a message to the primary
    // receiver, which may simply ignore it, so a 200 is not possession.
    return { ownerAppId: await getThreadOwner(args.to, t) };
  },

  async threadOwner(igsid: string, config: InstagramSendConfig): Promise<string | null> {
    return getThreadOwner(igsid, target(config));
  },

  /**
   * Move this person's conversation to SPAM in Meta Business Suite.
   *
   * The third documented Moderate Conversations action, alongside block/unblock.
   * Distinct from blocking: a block stops them reaching the business at all,
   * whereas this files the existing thread as spam without severing contact —
   * the right answer for bulk junk that is not worth a permanent block.
   */
  async markSpam(users: string[], config: InstagramSendConfig): Promise<BlockUsersResult> {
    return toBlockUsersResult(
      await moderateSocialConversations("move_to_spam", users, target(config)),
    );
  },

  /**
   * Reply PUBLICLY on the comment thread. The complement to the private reply:
   * everyone reading the post sees it, there is no one-per-comment cap, and it
   * starts no DM conversation.
   */
  async replyToComment(
    commentId: string,
    message: string,
    config: InstagramSendConfig,
  ): Promise<{ commentId: string }> {
    return replyToSocialComment(commentId, message, target(config));
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
      ...(config.appSecret ? { appSecret: config.appSecret } : {}),
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
