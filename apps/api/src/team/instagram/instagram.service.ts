import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";

import { decryptSecret, encryptSecret } from "@/lib/crypto/envelope";
import { invalidateInstagramConfig } from "@/lib/providers/instagram-config";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type { UpdateInstagramConfigInput } from "./instagram.schemas";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";
const CHANNEL = "instagram" as const;

interface InstagramChannelConfig {
  igId?: string;
  igUsername?: string;
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
  appId: string | null;
  verifyToken: string | null;
  igAccessToken: string | null;
  appSecret: string | null;
  credentialsUndecryptable: boolean;
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
      appId: config.appId ?? null,
      verifyToken,
      igAccessToken,
      appSecret,
      credentialsUndecryptable,
    };
  }

  async updateConfig(
    teamId: string,
    input: UpdateInstagramConfigInput,
  ): Promise<{ config: { igId: string; igUsername: string | null; verifyToken: string } }> {
    const { igId, igAccessToken, appSecret, appId } = input;

    // Validate the IG account + token against Graph before persisting.
    let igUsername: string | undefined;
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(igId)}?fields=username`,
        {
          headers: { authorization: `Bearer ${igAccessToken}` },
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
      const data = (await res.json()) as { username?: string };
      igUsername = typeof data.username === "string" ? data.username : undefined;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadGatewayException({
        error: "instagram_validation_unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const existing = await this.db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: CHANNEL } },
      select: { config: true },
    });
    const existingConfig = (existing?.config ?? {}) as InstagramChannelConfig;
    const verifyToken =
      input.verifyToken?.trim() ||
      existingConfig.verifyToken ||
      randomBytes(24).toString("hex");

    const newConfig = pruneUndefined({
      igId,
      igUsername,
      appId: appId?.trim() ? appId.trim() : undefined,
      verifyToken,
    });
    const newSecrets: InstagramChannelSecrets = {
      igAccessToken: encryptSecret(igAccessToken),
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
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "channels" });

    return { config: { igId, igUsername: igUsername ?? null, verifyToken } };
  }

  async disconnect(teamId: string): Promise<void> {
    await this.db.channelConnection.deleteMany({ where: { teamId, channel: CHANNEL } });
    invalidateInstagramConfig(teamId);
    await this.bus.publish({ type: "team.catalog_changed", teamId, scope: "channels" });
  }
}
