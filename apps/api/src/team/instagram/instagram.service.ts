import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";

import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { invalidateInstagramConfig } from "@/lib/providers/instagram-config";
import {
  ensurePageSubscribedToMessaging,
  getPageSubscription,
} from "@/lib/providers/meta-page-subscription";
import { getMetaConnection } from "@/lib/providers/meta-connection";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type { UpdateInstagramConfigInput } from "./instagram.schemas";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";
const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com";
const CHANNEL = "instagram" as const;

interface InstagramChannelConfig {
  igId?: string;
  igUsername?: string;
  /** The Facebook Page the Instagram account is linked to (source of igId). */
  pageId?: string;
  pageName?: string;
  appId?: string;
  verifyToken?: string;
}
interface InstagramChannelSecrets {
  igAccessToken?: string;
  appSecret?: string;
}

/** Server→browser view for the admin connect form (never client→server). */
export interface InstagramConfigView {
  igId: string | null;
  igUsername: string | null;
  pageId: string | null;
  pageName: string | null;
  appId: string | null;
  verifyToken: string | null;
  igAccessToken: string | null;
  appSecret: string | null;
  credentialsUndecryptable: boolean;
  /**
   * Live subscription of the LINKED PAGE to the app. Instagram DMs ride the Page,
   * so an unsubscribed Page means no inbound — same failure mode as Messenger.
   * `null` when it couldn't be checked.
   */
  webhookSubscription: {
    receivesMessages: boolean;
    subscribedFields: string[];
    missingFields: string[];
  } | null;
}

function pruneUndefined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * Instagram DM connection settings — admin-only. Same credential model as
 * WhatsApp / Messenger (a `ChannelConnection` row keyed (teamId, "instagram");
 * `config` non-secret, `secrets` envelope-encrypted) but with IG account fields.
 */
@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  private tryDecrypt(cipher: string | null, label: string): string | null {
    if (cipher == null) return null;
    try {
      return decryptSecret(cipher);
    } catch (err) {
      this.logger.warn(
        `could not decrypt instagram ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async getConfig(teamId: string): Promise<InstagramConfigView> {
    const conn = await this.db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: CHANNEL } },
      select: { config: true, secrets: true },
    });
    const config = (conn?.config ?? {}) as InstagramChannelConfig;
    const secrets = (conn?.secrets ?? {}) as InstagramChannelSecrets;

    const igAccessToken = this.tryDecrypt(secrets.igAccessToken ?? null, "igAccessToken");
    const appSecret = this.tryDecrypt(secrets.appSecret ?? null, "appSecret");
    const credentialsUndecryptable =
      (secrets.igAccessToken != null && igAccessToken === null) ||
      (secrets.appSecret != null && appSecret === null);

    // Instagram DMs are delivered through the LINKED PAGE, so an unsubscribed
    // Page is the same silent "connected but no inbound" failure as Messenger.
    // Best-effort read; never fatal.
    let webhookSubscription: InstagramConfigView["webhookSubscription"] = null;
    if (config.pageId && igAccessToken) {
      try {
        const status = await getPageSubscription(config.pageId, igAccessToken, GRAPH_VERSION);
        webhookSubscription = {
          receivesMessages: status.receivesMessages,
          subscribedFields: status.subscribedFields,
          missingFields: status.missingFields,
        };
      } catch (err) {
        this.logger.warn(
          `[${teamId}] could not read instagram page subscription: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let verifyToken = config.verifyToken ?? null;
    if (verifyToken == null) {
      const minted = randomBytes(24).toString("hex");
      try {
        const mergedConfig = pruneUndefined({ ...config, verifyToken: minted });
        await this.db.channelConnection.upsert({
          where: { teamId_channel: { teamId, channel: CHANNEL } },
          create: {
            teamId,
            channel: CHANNEL,
            config: mergedConfig as Prisma.InputJsonValue,
            secrets: {},
            isActive: false,
          },
          update: { config: mergedConfig as Prisma.InputJsonValue },
        });
        verifyToken = minted;
      } catch (err) {
        this.logger.warn(
          `could not pre-mint instagram verify token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      igId: config.igId ?? null,
      igUsername: config.igUsername ?? null,
      pageId: config.pageId ?? null,
      pageName: config.pageName ?? null,
      appId: config.appId ?? null,
      verifyToken,
      igAccessToken,
      appSecret,
      credentialsUndecryptable,
      webhookSubscription,
    };
  }

  async updateConfig(
    teamId: string,
    input: UpdateInstagramConfigInput,
  ): Promise<{
    config: { igId: string; igUsername: string | null; pageId: string; verifyToken: string };
  }> {
    const { pageId } = input;

    // Source app-level credentials from the shared Meta App connection unless
    // overridden on this form. The Page access token is derived below.
    const meta = await getMetaConnection(teamId);
    const appSecret = input.appSecret?.trim() || meta?.appSecret || null;
    const sourceToken = input.igAccessToken?.trim() || meta?.systemUserToken || null;
    const appId = input.appId?.trim() || meta?.appId || undefined;
    if (!appSecret || !sourceToken) {
      throw new BadRequestException({
        error: "meta_not_configured",
        detail:
          "Set up your Meta App connection first (Settings → Meta App: App secret + system-user token), then connect the channel.",
      });
    }

    // Resolve the Instagram business account FROM the Page. This is the whole
    // point of taking a Page id: `instagram_business_account.id` is the
    // canonical Instagram id in the graph.facebook.com namespace — the same one
    // that arrives on inbound webhooks and that outbound sends must target — so
    // a mismatched Instagram-Login id can't be entered by hand. If the Page has
    // no linked Instagram account, we reject with an actionable error instead of
    // silently connecting something that will never receive a DM.
    let igId: string;
    let igUsername: string | undefined;
    let pageName: string | undefined;
    let derivedPageToken: string | undefined;
    try {
      const res = await fetch(
        `${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(pageId)}` +
          `?fields=name,access_token,instagram_business_account{id,username}`,
        {
          headers: { authorization: `Bearer ${sourceToken}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new BadRequestException({
          error: "instagram_validation_failed",
          detail: body.slice(0, 300),
        });
      }
      const data = (await res.json()) as {
        name?: string;
        access_token?: string;
        instagram_business_account?: { id?: string; username?: string };
      };
      const iba = data.instagram_business_account;
      if (!iba?.id) {
        throw new BadRequestException({
          error: "instagram_not_linked_to_page",
          detail:
            "This Facebook Page has no linked Instagram Business/Creator account. In the Instagram app or Page settings, link a professional Instagram account to this Page, then reconnect.",
        });
      }
      igId = iba.id;
      igUsername = typeof iba.username === "string" ? iba.username : undefined;
      pageName = typeof data.name === "string" ? data.name : undefined;
      // Instagram-via-Facebook-Login sends over graph.facebook.com/{igId}/messages,
      // which — like Messenger — is a Page-scoped call that the New Pages
      // Experience only accepts with a PAGE access token. Derive it from the
      // Page and store THAT, so a pasted system-user token still sends.
      derivedPageToken =
        typeof data.access_token === "string" && data.access_token.length > 0
          ? data.access_token
          : undefined;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadGatewayException({
        error: "instagram_validation_unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    // Fail loudly if we couldn't get a Page token and none was pasted — storing
    // the shared system-user token would mark the channel connected but leave it
    // unsendable (New Pages Experience rejects it). See messenger.service.
    if (!derivedPageToken && !input.igAccessToken?.trim()) {
      throw new BadRequestException({
        error: "page_token_derivation_failed",
        detail:
          "Couldn't get a Page access token for this Page from your Meta App system-user token. Assign the system user to this Page (Business Settings → Pages → Add People) with a messaging task, or paste a Page access token directly.",
      });
    }
    const tokenToStore = derivedPageToken ?? sourceToken;

    const existing = await this.db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: CHANNEL } },
      select: { config: true },
    });
    const existingConfig = (existing?.config ?? {}) as InstagramChannelConfig;
    const verifyToken =
      input.verifyToken?.trim() ||
      meta?.verifyToken ||
      existingConfig.verifyToken ||
      randomBytes(24).toString("hex");

    const newConfig = pruneUndefined({
      igId,
      igUsername,
      pageId,
      pageName,
      appId,
      verifyToken,
    });
    const newSecrets: InstagramChannelSecrets = {
      igAccessToken: encryptSecret(tokenToStore),
      appSecret: encryptSecret(appSecret),
    };

    await this.db.channelConnection.upsert({
      where: { teamId_channel: { teamId, channel: CHANNEL } },
      create: {
        teamId,
        channel: CHANNEL,
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
        isActive: true,
      },
      update: {
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
        isActive: true,
      },
    });

    invalidateInstagramConfig(teamId);

    // Instagram DMs ride the linked Page, so the Page must be subscribed to the
    // app. The helper posts the UNION of existing + required fields — critical
    // here, because a plain replace would unsubscribe Messenger from the SAME
    // Page. Best-effort; `getConfig` surfaces the truth.
    const sub = await ensurePageSubscribedToMessaging(pageId, tokenToStore, GRAPH_VERSION);
    if (!sub.ok) {
      this.logger.warn(
        `[${teamId}] instagram connected but page subscription failed for page=${pageId}: ${sub.error}`,
      );
    }

    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "channels" });

    return { config: { igId, igUsername: igUsername ?? null, pageId, verifyToken } };
  }

  async disconnect(teamId: string): Promise<void> {
    await this.db.channelConnection.deleteMany({ where: { teamId, channel: CHANNEL } });
    invalidateInstagramConfig(teamId);
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "channels" });
  }
}
