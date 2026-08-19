import "server-only";

import { cache } from "react";


import { api } from "../../api-client";
import type {
  WhatsappConfigView,
} from "@ccp/shared/dtos";
import type {
  Channel,
  TemplateDto,
} from "@ccp/shared/types";
import type { InboxSource } from "@ccp/shared/providers/capabilities";

/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
// ---------------------------------------------------------------------------
// WhatsApp settings + templates
// ---------------------------------------------------------------------------

export async function getTeamWhatsappConfig(): Promise<WhatsappConfigView> {
  const { config } = await api<{ config: WhatsappConfigView }>("/api/workspace/whatsapp");
  return config;
}

/** One connected account on a channel — a workspace may have several. */
export interface ChannelAccountView {
  id: string;
  channel: string;
  externalAccountId: string;
  label: string | null;
  isDefault: boolean;
  isActive: boolean;
  needsReconnect: boolean;
  displayPhoneNumber: string | null;
  wabaId: string | null;
  /** WhatsApp only — the display name's review status at Meta (raw). A
   *  DECLINED/EXPIRED/NONE name voids the certificate → blocks registration. */
  nameStatus: string | null;
  createdAt: string;
  /**
   * Which Meta app this account runs on — `shared_app` (the workspace's shared
   * one, so a rotation there reaches it), `own_app` (a different app's
   * credentials, untouched by a shared rotation), or `unset` (no stored secret).
   * Admin-only; the app ID is public, the secret never leaves the server.
   */
  appBinding: "shared_app" | "own_app" | "unset";
  /** The Meta app id when known — this account's own, else the shared app's. */
  appId: string | null;
  /** WhatsApp only — per-number quality/throughput + the shared portfolio. */
  health: ChannelAccountHealth | null;
}

export interface ChannelAccountHealth {
  qualityRating: string | null;
  throughputLevel: string | null;
  /** Cloud API registration state (Meta `status`, raw) — non-CONNECTED means
   *  every send from this number fails. */
  registrationStatus: string | null;
  updatedAt: string | null;
  portfolio: {
    externalId: string | null;
    messagingTier: string | null;
    messagingDailyCap: number | null;
    verificationStatus: string | null;
    templateLimit: number;
    accountCount: number;
  } | null;
}

export async function listChannelAccounts(
  channel: "whatsapp" | "messenger" | "instagram",
): Promise<ChannelAccountView[]> {
  const { accounts } = await api<{ accounts: ChannelAccountView[] }>(
    `/api/workspace/channels/${channel}/accounts`,
  );
  return accounts;
}

/**
 * Display-only view of every connected account, across all channels — what an
 * AGENT is allowed to see so the inbox can attribute a thread to the number /
 * Page / handle it arrived on. No credentials cross this boundary.
 */
export interface ChannelAccountDirectoryEntry {
  id: string;
  channel: Channel;
  name: string;
  providerName: string | null;
  isDefault: boolean;
  isActive: boolean;
  /** Expired token: replies on this account's threads will fail until an
   *  admin reconnects. Drives the thread header's amber pill. */
  needsReconnect: boolean;
}

/**
 * `cache()`d because the provider now mounts in the APP layout while the inbox
 * layout still reads it for its own sub-sidebar — without this the two would
 * each pay the round trip on every inbox render.
 */
export const listChannelAccountDirectory = cache(
  async (): Promise<ChannelAccountDirectoryEntry[]> => {
    const { accounts } = await api<{ accounts: ChannelAccountDirectoryEntry[] }>(
      "/api/workspace/channel-accounts",
    );
    return accounts;
  },
);

/** Server→browser view for the Messenger connect form (mirrors the API shape). */
export interface MessengerConfigView {
  pageId: string | null;
  pageName: string | null;
  appId: string | null;
  verifyToken: string | null;
  /** `SECRET_SAVED_SENTINEL` when stored (and decryptable), else null — never
   *  the plaintext. Submitting it back keeps the stored value. */
  pageAccessToken: string | null;
  appSecret: string | null;
  /** True when the corresponding secret is stored and decryptable. */
  pageAccessTokenSet: boolean;
  appSecretSet: boolean;
  credentialsUndecryptable: boolean;
  needsReconnect: boolean;
  /** Webhooks we 403'd in the last 24h — inbound may be silently dropping. */
  webhookRejection: { at: string; reason: string } | null;
  /** Live Page↔app webhook subscription; null when it couldn't be checked. */
  webhookSubscription: {
    receivesMessages: boolean;
    subscribedFields: string[];
    missingFields: string[];
  } | null;
}

export async function getTeamMessengerConfig(): Promise<MessengerConfigView> {
  const { config } = await api<{ config: MessengerConfigView }>("/api/workspace/messenger");
  return config;
}

/** Server→browser view for the Instagram connect form (mirrors the API shape). */
export interface InstagramConfigView {
  /** Non-DM sources allowed into the inbox (default none; DMs are always on). */
  inboxSources: InboxSource[];
  /** Every non-DM source this channel can offer. */
  availableInboxSources: InboxSource[];
  igId: string | null;
  igUsername: string | null;
  pageId: string | null;
  pageName: string | null;
  appId: string | null;
  verifyToken: string | null;
  /** `SECRET_SAVED_SENTINEL` when stored (and decryptable), else null — never
   *  the plaintext. Submitting it back keeps the stored value. */
  igAccessToken: string | null;
  appSecret: string | null;
  /** True when the corresponding secret is stored and decryptable. */
  igAccessTokenSet: boolean;
  appSecretSet: boolean;
  credentialsUndecryptable: boolean;
  needsReconnect: boolean;
  /** Webhooks we 403'd in the last 24h — inbound may be silently dropping. */
  webhookRejection: { at: string; reason: string } | null;
  /** Live subscription of the LINKED PAGE (IG DMs ride it); null when unchecked. */
  webhookSubscription: {
    receivesMessages: boolean;
    subscribedFields: string[];
    missingFields: string[];
  } | null;
}

export async function getTeamInstagramConfig(): Promise<InstagramConfigView> {
  const { config } = await api<{ config: InstagramConfigView }>("/api/workspace/instagram");
  return config;
}

/** Server→browser view for the shared Meta App connection form. */
export interface MetaConfigView {
  appId: string | null;
  verifyToken: string | null;
  /** `SECRET_SAVED_SENTINEL` when stored (and decryptable), else null — never
   *  the plaintext. The form pre-fills with it and submits it back untouched,
   *  which the server reads as "keep the stored value". */
  appSecret: string | null;
  systemUserToken: string | null;
  /** True when the corresponding secret is stored and decryptable. */
  appSecretSet: boolean;
  systemUserTokenSet: boolean;
  credentialsUndecryptable: boolean;
}
export async function getTeamMetaConfig(): Promise<MetaConfigView> {
  const { config } = await api<{ config: MetaConfigView }>("/api/workspace/meta");
  return config;
}

/** One website chat widget (a team runs many). Mirrors the API's WidgetView. */
export interface WebchatWidgetView {
  id: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  config: {
    theme?: { primaryColor?: string; launcherColor?: string; userBubbleColor?: string };
    welcomeMessage?: string;
    headerTitle?: string;
    headerSubtitle?: string;
    suggestedQuestions?: string[];
    preChatFields?: {
      id: string;
      label: string;
      type: "text" | "name" | "email" | "phone";
      required: boolean;
      /** Workspace contact-field key the answer is saved to (`text` questions). */
      key?: string;
      /** Live options when `key` names a select field — server-attached, read-only. */
      options?: { id: string; name: string }[];
    }[];
    showBranding?: boolean;
    logoDataUrl?: string;
    agentAvatarDataUrl?: string;
    fontFamily?: "system" | "rounded" | "serif";
    themeMode?: "light" | "dark" | "auto";
    soundEnabled?: boolean;
    allowedMediaKinds?: Array<"image" | "video" | "audio" | "document">;
    awayMessage?: string;
    aiEnabled?: boolean;
    showHeader?: boolean;
    showAgentName?: boolean;
    phoneDialCode?: string;
    launcher?: "bubble" | "off" | "inline";
    position?: "right" | "left";
    launcherLabel?: string;
  };
  isActive: boolean;
  /** Host of the first real site that embedded this widget; null until observed. */
  firstSeenOrigin: string | null;
  conversationCount: number;
  createdAt: string;
}

export async function getTeamWebchatWidgets(): Promise<WebchatWidgetView[]> {
  const { widgets } = await api<{ widgets: WebchatWidgetView[] }>("/api/workspace/webchatwidget");
  return widgets;
}

export async function listWhatsappTemplates(accountId?: string | null): Promise<{
  templates: TemplateDto[];
  hasWabaId: boolean;
  hasAppId: boolean;
  connected: boolean;
}> {
  // Scoped when the caller knows which number it means. `connected` /
  // `hasWabaId` / `hasAppId` describe THAT account — unscoped they describe the
  // workspace default, so an edit page opened for a second number's template
  // could redirect to Settings because the DEFAULT number lacked a WABA id.
  const q = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
  return api(`/api/workspace/whatsapp/templates${q}`);
}

