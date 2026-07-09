import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";

import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { invalidateMetaConnection } from "@/lib/providers/meta-connection";

import { DbService } from "../../db/db.service";
import { InstagramService } from "../instagram/instagram.service";
import { MessengerService } from "../messenger/messenger.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import type { UpdateMetaConnectionInput } from "./meta.schemas";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";

interface MetaConnConfig {
  appId?: string;
  verifyToken?: string;
  graphVersion?: string;
}
interface MetaConnSecrets {
  appSecret?: string;
  systemUserToken?: string;
}

/** Server→browser view for the Meta App connect form (never client→server). */
export interface MetaConnectionView {
  appId: string | null;
  verifyToken: string | null;
  appSecret: string | null;
  systemUserToken: string | null;
  credentialsUndecryptable: boolean;
}

function pruneUndefined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * The team's shared Meta-app credentials — admin-only. One row per team
 * (`MetaConnection`); `config` non-secret (appId, verifyToken), `secrets`
 * envelope-encrypted (appSecret, systemUserToken). Every Meta channel sources
 * its app-level credentials from here, so they're entered once.
 */
@Injectable()
export class MetaService {
  private readonly logger = new Logger(MetaService.name);
  constructor(
    private readonly db: DbService,
    private readonly whatsapp: WhatsappService,
    private readonly messenger: MessengerService,
    private readonly instagram: InstagramService,
  ) {}

  /**
   * Re-apply the (just-saved) shared credentials to every already-connected
   * channel: re-run each channel's connect with its stored identity so it
   * re-sources the new App secret / verify token and re-derives its Page token
   * from the new system-user token. Fail-soft per channel — one channel's Graph
   * error never blocks the others or the save. Returns the channels that
   * re-synced, so the UI can confirm ("Updated WhatsApp, Messenger").
   */
  private async resyncChannels(teamId: string): Promise<string[]> {
    const conns = await this.db.channelConnection.findMany({
      where: { teamId, isActive: true },
      select: { channel: true, config: true },
    });
    const resynced: string[] = [];
    for (const conn of conns) {
      const config = (conn.config ?? {}) as { phoneNumberId?: string; pageId?: string };
      try {
        if (conn.channel === "whatsapp" && config.phoneNumberId) {
          await this.whatsapp.updateConfig(teamId, { phoneNumberId: config.phoneNumberId });
        } else if (conn.channel === "messenger" && config.pageId) {
          await this.messenger.updateConfig(teamId, { pageId: config.pageId });
        } else if (conn.channel === "instagram" && config.pageId) {
          await this.instagram.updateConfig(teamId, { pageId: config.pageId });
        } else {
          continue;
        }
        resynced.push(conn.channel);
      } catch (err) {
        this.logger.warn(
          `resync ${conn.channel} after Meta App update failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return resynced;
  }

  private tryDecrypt(cipher: string | null, label: string): string | null {
    if (cipher == null) return null;
    try {
      return decryptSecret(cipher);
    } catch (err) {
      this.logger.warn(
        `could not decrypt meta ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async getConfig(teamId: string): Promise<MetaConnectionView> {
    const row = await this.db.metaConnection.findUnique({
      where: { teamId },
      select: { config: true, secrets: true },
    });
    const config = (row?.config ?? {}) as MetaConnConfig;
    const secrets = (row?.secrets ?? {}) as MetaConnSecrets;

    const appSecret = this.tryDecrypt(secrets.appSecret ?? null, "appSecret");
    const systemUserToken = this.tryDecrypt(secrets.systemUserToken ?? null, "systemUserToken");
    const credentialsUndecryptable =
      (secrets.appSecret != null && appSecret === null) ||
      (secrets.systemUserToken != null && systemUserToken === null);

    // Pre-mint a verify token on first read so the admin can paste the ONE
    // callback URL + verify token into Meta before entering credentials.
    let verifyToken = config.verifyToken ?? null;
    if (verifyToken == null) {
      const minted = randomBytes(24).toString("hex");
      try {
        const mergedConfig = pruneUndefined({ ...config, verifyToken: minted });
        await this.db.metaConnection.upsert({
          where: { teamId },
          create: { teamId, config: mergedConfig as Prisma.InputJsonValue, secrets: {} },
          update: { config: mergedConfig as Prisma.InputJsonValue },
        });
        verifyToken = minted;
      } catch (err) {
        this.logger.warn(
          `could not pre-mint meta verify token: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { appId: config.appId ?? null, verifyToken, appSecret, systemUserToken, credentialsUndecryptable };
  }

  async updateConfig(
    teamId: string,
    input: UpdateMetaConnectionInput,
  ): Promise<{ verifyToken: string; resynced: string[] }> {
    const { appId, appSecret, systemUserToken } = input;

    // Validate the token against Graph before persisting — a bad token here
    // would silently break every Meta channel.
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/me?fields=id&access_token=${encodeURIComponent(systemUserToken)}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) {
        const body = await res.text();
        throw new BadRequestException({
          error: "meta_token_invalid",
          detail: body.slice(0, 300),
        });
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadGatewayException({
        error: "meta_validation_unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const existing = await this.db.metaConnection.findUnique({
      where: { teamId },
      select: { config: true },
    });
    const existingConfig = (existing?.config ?? {}) as MetaConnConfig;
    const verifyToken =
      input.verifyToken?.trim() ||
      existingConfig.verifyToken ||
      randomBytes(24).toString("hex");

    const newConfig = pruneUndefined({
      appId: appId?.trim() ? appId.trim() : undefined,
      verifyToken,
    });
    const newSecrets: MetaConnSecrets = {
      appSecret: encryptSecret(appSecret),
      systemUserToken: encryptSecret(systemUserToken),
    };

    await this.db.metaConnection.upsert({
      where: { teamId },
      create: {
        teamId,
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
      },
      update: {
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
      },
    });

    invalidateMetaConnection(teamId);

    // Re-apply the new shared creds to every connected channel so a token
    // rotation takes effect everywhere immediately (no per-channel reconnect).
    const resynced = await this.resyncChannels(teamId);
    return { verifyToken, resynced };
  }

  async disconnect(teamId: string): Promise<void> {
    await this.db.metaConnection.deleteMany({ where: { teamId } });
    invalidateMetaConnection(teamId);
  }
}
