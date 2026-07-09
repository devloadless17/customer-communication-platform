import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";

import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { invalidateMessengerConfig } from "@/lib/providers/messenger-config";
import { getMetaConnection } from "@/lib/providers/meta-connection";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type { UpdateMessengerConfigInput } from "./messenger.schemas";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";
const CHANNEL = "messenger" as const;

/** Shape of `ChannelConnection.config` (non-secret) for Messenger. */
interface MessengerChannelConfig {
  pageId?: string;
  pageName?: string;
  appId?: string;
  verifyToken?: string;
}
/** Shape of `ChannelConnection.secrets` — envelope-encrypted ciphertext per field. */
interface MessengerChannelSecrets {
  pageAccessToken?: string;
  appSecret?: string;
}

/** Server→browser view for the admin connect form (never client→server). */
export interface MessengerConfigView {
  pageId: string | null;
  pageName: string | null;
  appId: string | null;
  verifyToken: string | null;
  /** Decrypted plaintext — server→browser only, for form pre-fill. */
  pageAccessToken: string | null;
  appSecret: string | null;
  /** True when secrets exist but decrypt failed (key rotated / corrupt). */
  credentialsUndecryptable: boolean;
}

function pruneUndefined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * Facebook Messenger connection settings — admin-only. Same credential model as
 * WhatsApp (a `ChannelConnection` row keyed (teamId, "messenger"); `config`
 * non-secret, `secrets` envelope-encrypted) but with Page fields instead of
 * phone/WABA. Kept as its own module so the stable WhatsApp onboarding is
 * untouched.
 */
@Injectable()
export class MessengerService {
  private readonly logger = new Logger(MessengerService.name);
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
        `could not decrypt messenger ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async getConfig(teamId: string): Promise<MessengerConfigView> {
    const conn = await this.db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: CHANNEL } },
      select: { config: true, secrets: true },
    });
    const config = (conn?.config ?? {}) as MessengerChannelConfig;
    const secrets = (conn?.secrets ?? {}) as MessengerChannelSecrets;

    const pageAccessToken = this.tryDecrypt(secrets.pageAccessToken ?? null, "pageAccessToken");
    const appSecret = this.tryDecrypt(secrets.appSecret ?? null, "appSecret");
    const credentialsUndecryptable =
      (secrets.pageAccessToken != null && pageAccessToken === null) ||
      (secrets.appSecret != null && appSecret === null);

    // Pre-mint a verify token on first read so the onboarding UI can show
    // "paste this into Meta" before any credentials are saved. Row created
    // inactive; updateConfig flips isActive. Same posture as WhatsApp.
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
          `could not pre-mint messenger verify token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      pageId: config.pageId ?? null,
      pageName: config.pageName ?? null,
      appId: config.appId ?? null,
      verifyToken,
      pageAccessToken,
      appSecret,
      credentialsUndecryptable,
    };
  }

  async updateConfig(
    teamId: string,
    input: UpdateMessengerConfigInput,
  ): Promise<{ config: { pageId: string; pageName: string | null; verifyToken: string } }> {
    const { pageId } = input;

    // Source the app-level credentials from the shared Meta App connection,
    // unless the admin overrode them on this form. The Page access token is
    // derived below from whichever token we resolve here.
    const meta = await getMetaConnection(teamId);
    const appSecret = input.appSecret?.trim() || meta?.appSecret || null;
    const sourceToken = input.pageAccessToken?.trim() || meta?.systemUserToken || null;
    const appId = input.appId?.trim() || meta?.appId || undefined;
    if (!appSecret || !sourceToken) {
      throw new BadRequestException({
        error: "meta_not_configured",
        detail:
          "Set up your Meta App connection first (Settings → Meta App: App secret + system-user token), then connect the channel.",
      });
    }

    // Validate the Page + token against Graph before persisting, so a typo
    // surfaces here instead of silently failing every send later. We ALSO ask
    // for `access_token`: Meta's "New Pages Experience" rejects user /
    // system-user tokens on Page-scoped calls (send, subscribe, profile) with
    // "A Page access token is required", so we derive the Page-scoped token
    // here and store THAT — the shared system-user token is fine and outbound
    // still works. This mirrors the Embedded-Signup user→Page token exchange.
    let pageName: string | undefined;
    let derivedPageToken: string | undefined;
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}?fields=name,access_token`,
        {
          headers: { authorization: `Bearer ${sourceToken}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new BadRequestException({
          error: "messenger_validation_failed",
          detail: body.slice(0, 300),
        });
      }
      const data = (await res.json()) as { name?: string; access_token?: string };
      pageName = typeof data.name === "string" ? data.name : undefined;
      derivedPageToken =
        typeof data.access_token === "string" && data.access_token.length > 0
          ? data.access_token
          : undefined;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadGatewayException({
        error: "messenger_validation_unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    // Prefer the derived Page token; fall back to the source token (it may
    // already be a Page token if `access_token` wasn't returned).
    const tokenToStore = derivedPageToken ?? sourceToken;

    // Verify token: prefer the shared Meta App token (one callback for all
    // channels), then the channel's existing one, else mint.
    const existing = await this.db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: CHANNEL } },
      select: { config: true },
    });
    const existingConfig = (existing?.config ?? {}) as MessengerChannelConfig;
    const verifyToken =
      input.verifyToken?.trim() ||
      meta?.verifyToken ||
      existingConfig.verifyToken ||
      randomBytes(24).toString("hex");

    const newConfig = pruneUndefined({
      pageId,
      pageName,
      appId,
      verifyToken,
    });
    const newSecrets: MessengerChannelSecrets = {
      pageAccessToken: encryptSecret(tokenToStore),
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

    invalidateMessengerConfig(teamId);
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "channels" });

    return { config: { pageId, pageName: pageName ?? null, verifyToken } };
  }

  async disconnect(teamId: string): Promise<void> {
    await this.db.channelConnection.deleteMany({ where: { teamId, channel: CHANNEL } });
    invalidateMessengerConfig(teamId);
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "channels" });
  }
}
