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
  CallActionArgs,
  CallActionResult,
  ChannelEntryPoints,
  ChannelWelcomeScreen,
  MessagingProvider,
  ChannelPersona,
  SendStickerArgs,
  SendStructuredTemplateArgs,
  SendUtilityTemplateArgs,
  ThreadControlArgs,
  ThreadControlResult,
  NormalizedEvent,
  SendInteractiveArgs,
  SendMediaArgs,
  SendReactionArgs,
  SendTextArgs,
  SendTextResult,
  SocialCallPermission,
  UploadMediaArgs,
  UploadMediaResult,
} from "@ccp/shared/providers/types";
import {
  checkSocialCallPermission,
  enableSocialCalling,
  fetchSocialProfile,
  getChannelEntryPoints,
  messagingTypeFields,
  setChannelEntryPoints,
  type SocialContactProfile,
  parseSocialMessaging,
  requestSocialCallPermission,
  sendSocialCallAction,
  sendSocialInteractive,
  sendSocialMedia,
  sendSocialReaction,
  sendSocialSenderAction,
  sendSocialText,
  socialCallFeatureEnabled,
  uploadSocialMedia,
} from "@/lib/providers/meta-social";
import {
  getMessengerWelcome,
  setMessengerWelcome,
} from "@/lib/providers/messenger-profile";
import { sendMessengerSticker } from "@/lib/providers/messenger-stickers";
import { sendMessengerTemplate } from "@/lib/providers/messenger-templates";
import {
  listUtilityTemplates,
  sendUtilityMessage,
} from "@/lib/providers/messenger-utility-templates";
import {
  createPersona,
  deletePersona,
  listPersonas,
} from "@/lib/providers/messenger-personas";
import {
  getThreadOwner,
  PAGE_INBOX_APP_ID,
  passThreadControl,
  releaseThreadControl,
  requestThreadControl,
  takeThreadControl,
} from "@/lib/providers/messenger-handover";
import type { MessengerSendConfig } from "@/lib/providers/messenger-config";

/** The Page id + token that address a Messenger send. */
function target(config: MessengerSendConfig) {
  return {
    accountId: config.pageId,
    accessToken: config.pageAccessToken,
    graphVersion: config.graphVersion,
    label: "messenger",
    ...(config.appSecret ? { appSecret: config.appSecret } : {}),
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

  async sendReaction(
    args: SendReactionArgs,
    config: MessengerSendConfig,
  ): Promise<SendTextResult> {
    return sendSocialReaction(args, target(config));
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
    active: boolean = true,
  ): Promise<void> {
    if (!recipientId) return;
    await sendSocialSenderAction(active ? "typing_on" : "typing_off", recipientId, target(config));
  },

  async fetchContactProfile(
    externalId: string,
    config: MessengerSendConfig,
  ): Promise<SocialContactProfile> {
    // Messenger's user node exposes name, the pre-split first/last name, and
    // profile_pic (no @username, no follower/verified signals — Instagram-only).
    // We ALSO request `locale`/`timezone`/`gender` — the only extra identity
    // Meta offers here (drives the "Local time" / language rows). Each sits
    // behind a `pages_user_*` App Review, and Graph fails the WHOLE node if any
    // requested field is unapproved, so the fallback drops just those three and
    // keeps the name split + avatar. Two-tier: full → name+split+pic. Until the
    // perms clear, this is one extra rejected request then the fallback — a
    // no-op enrichment-wise (name/avatar still land).
    return fetchSocialProfile(externalId, {
      accessToken: config.pageAccessToken,
      graphVersion: config.graphVersion,
      ...(config.appSecret ? { appSecret: config.appSecret } : {}),
      fields: "name,first_name,last_name,profile_pic,locale,timezone,gender",
      fallbackFields: "name,first_name,last_name,profile_pic",
      label: "messenger",
    });
  },

  // ---- Conversation entry points + welcome screen ----------------------
  // Entry points (ice breakers + persistent menu) are the SHARED social
  // implementation — the same `messenger_profile` node Instagram uses, minus the
  // `platform=instagram` disambiguator. The welcome screen is Messenger-only and
  // lives in its own module; see the header of messenger-profile.ts for why the
  // two are not one call.
  async getEntryPoints(config: MessengerSendConfig): Promise<ChannelEntryPoints> {
    return getChannelEntryPoints(target(config));
  },
  async setEntryPoints(
    entryPoints: ChannelEntryPoints,
    config: MessengerSendConfig,
  ): Promise<void> {
    return setChannelEntryPoints(entryPoints, target(config));
  },
  async getWelcomeScreen(config: MessengerSendConfig): Promise<ChannelWelcomeScreen> {
    return getMessengerWelcome(target(config));
  },
  async setWelcomeScreen(
    welcome: ChannelWelcomeScreen,
    config: MessengerSendConfig,
  ): Promise<void> {
    return setMessengerWelcome(welcome, target(config));
  },

  // ---- Stickers --------------------------------------------------------
  // `messagingTypeFields` is threaded in rather than re-derived: a sticker is
  // gated on the standard messaging window exactly like a text send, and the one
  // place that decides RESPONSE-vs-HUMAN_AGENT must stay the one place.
  async sendSticker(
    args: SendStickerArgs,
    config: MessengerSendConfig,
  ): Promise<SendTextResult> {
    return sendMessengerSticker(args, target(config), messagingTypeFields(args.useHumanAgentTag));
  },

  // ---- Structured templates + personas ----------------------------------
  // `sendStructuredTemplate` is Meta's inline BUTTON/GENERIC message shape — NOT
  // the approved-template catalog `capabilities.templates` refers to. See the
  // header of messenger-templates.ts.
  async sendStructuredTemplate(
    args: SendStructuredTemplateArgs,
    config: MessengerSendConfig,
  ): Promise<SendTextResult> {
    return sendMessengerTemplate(
      {
        to: args.to,
        template: args.template,
        ...(args.personaId ? { personaId: args.personaId } : {}),
      },
      target(config),
      messagingTypeFields(args.useHumanAgentTag),
    );
  },

  // ---- Utility messages (Meta-approved templates) -----------------------
  // The one send that legitimately IGNORES the 24h window — that is the entire
  // point of the message type. `fetchTemplates` reads Meta live; there is no
  // local mirror (see messenger-utility-templates.ts).
  async fetchUtilityTemplates(config: MessengerSendConfig) {
    return listUtilityTemplates(target(config));
  },
  async sendUtilityTemplate(
    args: SendUtilityTemplateArgs,
    config: MessengerSendConfig,
  ): Promise<SendTextResult> {
    return sendUtilityMessage(args, target(config));
  },

  async listPersonas(config: MessengerSendConfig): Promise<ChannelPersona[]> {
    return listPersonas(target(config));
  },
  async createPersona(
    args: { name: string; profilePictureUrl: string },
    config: MessengerSendConfig,
  ): Promise<ChannelPersona> {
    return createPersona(args, target(config));
  },
  async deletePersona(personaId: string, config: MessengerSendConfig): Promise<void> {
    return deletePersona(personaId, target(config));
  },

  // ---- Handover protocol ------------------------------------------------
  // Exposed as explicit actions, never as an automatic retry inside the send
  // path — see the header of messenger-handover.ts for why seizing a thread in a
  // `catch` block is a race rather than a decision.
  async threadControl(
    args: ThreadControlArgs,
    config: MessengerSendConfig,
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
        // Default target is Meta's own Page Inbox — "hand this back to whoever
        // is staffing Business Suite" is by far the most common pass, and the id
        // is a documented constant rather than something a caller can look up.
        await passThreadControl(args.to, args.targetAppId ?? PAGE_INBOX_APP_ID, t, args.metadata);
        break;
    }
    // Re-read rather than assume: a `request` in particular is a message to the
    // primary receiver, which "may then choose to honor the request, or ignore
    // it", so a 200 here does NOT mean we hold the thread.
    return { ownerAppId: await getThreadOwner(args.to, t) };
  },

  async threadOwner(psid: string, config: MessengerSendConfig): Promise<string | null> {
    return getThreadOwner(psid, target(config));
  },

  // ---- Messenger Calling (unified /calls) -----------------------------
  async callAction(args: CallActionArgs, config: MessengerSendConfig): Promise<CallActionResult> {
    return sendSocialCallAction(args, target(config));
  },
  async checkCallPermission(psid: string, config: MessengerSendConfig): Promise<SocialCallPermission> {
    return checkSocialCallPermission(psid, target(config));
  },
  async requestCallPermission(psid: string, config: MessengerSendConfig): Promise<{ messageId: string }> {
    return requestSocialCallPermission(psid, target(config));
  },
  async callFeatureEnabled(config: MessengerSendConfig): Promise<boolean> {
    return socialCallFeatureEnabled(target(config));
  },
  // Admin one-shot: route inbound calls to us (PARTNERS) + show the call icon,
  // then report Meta's feature status. Required before this inbox can RECEIVE
  // Messenger calls. Idempotent — same shape as WhatsApp's enableCalling.
  async enableCalling(config: MessengerSendConfig): Promise<{ ok: true; raw: unknown }> {
    return enableSocialCalling(target(config));
  },
};
