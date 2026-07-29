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
const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com";

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
  private async resyncChannels(workspaceId: string): Promise<string[]> {
    const conns = await this.db.channelConnection.findMany({
      where: { workspaceId, isActive: true },
      select: { channel: true, config: true },
    });
    const resynced: string[] = [];
    for (const conn of conns) {
      const config = (conn.config ?? {}) as { phoneNumberId?: string; pageId?: string };
      try {
        if (conn.channel === "whatsapp" && config.phoneNumberId) {
          await this.whatsapp.updateConfig(workspaceId, { phoneNumberId: config.phoneNumberId });
        } else if (conn.channel === "messenger" && config.pageId) {
          await this.messenger.updateConfig(workspaceId, { pageId: config.pageId });
        } else if (conn.channel === "instagram" && config.pageId) {
          await this.instagram.updateConfig(workspaceId, { pageId: config.pageId });
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

  async getConfig(workspaceId: string): Promise<MetaConnectionView> {
    const row = await this.db.metaConnection.findUnique({
      where: { workspaceId },
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
          where: { workspaceId },
          create: { workspaceId, config: mergedConfig as Prisma.InputJsonValue, secrets: {} },
          update: { config: mergedConfig as Prisma.InputJsonValue },
        });
        // Drop the cached snapshot so the shared loader picks up the newly minted
        // verify token immediately (its 60s TTL would otherwise serve stale null).
        invalidateMetaConnection(workspaceId);
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
    workspaceId: string,
    input: UpdateMetaConnectionInput,
  ): Promise<{ verifyToken: string; resynced: string[]; warnings: string[] }> {
    const { appId, appSecret, systemUserToken } = input;

    // Validate the token against Graph before persisting — a bad token here
    // would silently break every Meta channel. Bearer header, NOT an
    // `access_token=` query param: every other Graph call in the codebase uses
    // the header, and a token in a query string is one access-log or proxy
    // line away from leaking.
    try {
      const res = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/me?fields=id`, {
        headers: { authorization: `Bearer ${systemUserToken}` },
        signal: AbortSignal.timeout(20_000),
      });
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

    // Inspect the token's granted permissions + lifetime via debug_token.
    // Catches a mis-scoped or expiring token at PASTE time, with a named fix —
    // instead of as Meta code-200 "permissions error" failures scattered
    // across template sync, health polling and sends weeks later.
    const warnings = await this.inspectToken(
      appId?.trim() || null,
      appSecret,
      systemUserToken,
    );

    const existing = await this.db.metaConnection.findUnique({
      where: { workspaceId },
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
      where: { workspaceId },
      create: {
        workspaceId,
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
      },
      update: {
        config: newConfig as Prisma.InputJsonValue,
        secrets: newSecrets as Prisma.InputJsonValue,
      },
    });

    invalidateMetaConnection(workspaceId);

    // Re-apply the new shared creds to every connected channel so a token
    // rotation takes effect everywhere immediately (no per-channel reconnect).
    const resynced = await this.resyncChannels(workspaceId);
    return { verifyToken, resynced, warnings };
  }

  /**
   * Verify what the pasted token can actually DO, using Graph's `debug_token`
   * endpoint (Access Tokens / Permissions docs). The bearer is the app access
   * token `appId|appSecret` — both arrive in the same submission, so a valid
   * pair can always inspect its own app's tokens.
   *
   * BLOCKS (BadRequest) only on the one DEFINITIVE dead-end: `is_valid: false`
   * (expired / revoked) — that token is dead for every channel.
   *
   * Everything else is a WARNING, never a block, because this credential is
   * SHARED by WhatsApp, Messenger and Instagram: a Messenger-only workspace
   * legitimately pastes a token with no `whatsapp_*` scopes, and refusing it
   * would break their onboarding. Warned:
   *   - missing `whatsapp_business_messaging` / `whatsapp_business_management`
   *     → WhatsApp sending, template sync and the webhook subscription will
   *       fail with Meta code 200;
   *   - missing `business_management` → the business portfolio can't resolve,
   *     so the shared 24h budget + template-limit panels read "not resolved"
   *     and broadcasts send ungated (lib/providers/README.md);
   *   - a USER-type token or one with an expiry → works today, dies quietly
   *     later (User tokens live hours; the onboarding doc says non-expiring
   *     system-user token).
   *
   * Anything INDETERMINATE — no appId to build the app token, network failure,
   * unexpected shape — skips silently (fail-open, one log line). Validation
   * must never be the thing that blocks a working credential rotation.
   */
  private async inspectToken(
    appId: string | null,
    appSecret: string,
    systemUserToken: string,
  ): Promise<string[]> {
    if (!appId) {
      return [
        "App ID was left empty, so the token's permissions couldn't be verified. Fill it in to catch a mis-scoped token at save time.",
      ];
    }
    let data: {
      is_valid?: unknown;
      type?: unknown;
      expires_at?: unknown;
      scopes?: unknown;
    };
    try {
      const res = await fetch(
        `${GRAPH_BASE}/${GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(systemUserToken)}`,
        {
          headers: { authorization: `Bearer ${appId}|${appSecret}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        // Wrong app id for this token, a Graph blip, whatever — indeterminate.
        this.logger.warn(`debug_token inspection skipped (http ${res.status})`);
        return [];
      }
      const body = (await res.json()) as { data?: typeof data };
      if (!body?.data || typeof body.data !== "object") return [];
      data = body.data;
    } catch (err) {
      this.logger.warn(
        `debug_token inspection skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }

    const outcome = evaluateDebugTokenData(data);
    if (outcome.invalidDetail) {
      throw new BadRequestException({
        error: "meta_token_invalid",
        detail: outcome.invalidDetail,
      });
    }
    return outcome.warnings;
  }

  async disconnect(workspaceId: string): Promise<void> {
    await this.db.metaConnection.deleteMany({ where: { workspaceId } });
    invalidateMetaConnection(workspaceId);
  }
}

/**
 * The pure decision over a parsed `debug_token` payload — what blocks, what
 * warns, what passes. Split from the fetch so the spec exercises exactly the
 * rules `inspectToken` enforces (same pattern as `sendBackoffDelayMs`).
 *
 * `invalidDetail` non-null = the ONE blocking outcome (`is_valid: false` —
 * the token is dead for every channel). Scope gaps are warnings, never
 * blocks: the credential is shared by WhatsApp / Messenger / Instagram and a
 * Messenger-only workspace legitimately has no `whatsapp_*` scopes.
 */
export function evaluateDebugTokenData(data: {
  is_valid?: unknown;
  type?: unknown;
  expires_at?: unknown;
  scopes?: unknown;
}): { invalidDetail: string | null; warnings: string[] } {
  if (data.is_valid === false) {
    return {
      invalidDetail:
        "Meta reports this token is expired or revoked (debug_token is_valid=false). Generate a fresh system-user token and paste that instead.",
      warnings: [],
    };
  }
  const warnings: string[] = [];
  if (Array.isArray(data.scopes)) {
    const scopes = data.scopes.filter((s): s is string => typeof s === "string");
    const missingWhatsapp = [
      "whatsapp_business_messaging",
      "whatsapp_business_management",
    ].filter((s) => !scopes.includes(s));
    if (missingWhatsapp.length > 0) {
      warnings.push(
        `The token is missing ${missingWhatsapp.join(" + ")} — WhatsApp sending, template sync and account webhooks will fail until the system user regenerates it with ${missingWhatsapp.length > 1 ? "those permissions" : "that permission"}.`,
      );
    }
    if (!scopes.includes("business_management")) {
      warnings.push(
        "The token is missing business_management — the business portfolio can't be resolved, so the shared 24h messaging budget and template limits won't show and broadcasts send ungated.",
      );
    }
  }
  if (typeof data.type === "string" && data.type.toUpperCase() === "USER") {
    warnings.push(
      "This is a personal User token — it expires within hours. Create a system user in Business settings and generate a non-expiring token instead.",
    );
  }
  if (typeof data.expires_at === "number" && data.expires_at > 0) {
    warnings.push(
      `This token expires ${new Date(data.expires_at * 1000).toISOString().slice(0, 10)} — every Meta channel stops working that day. Prefer a never-expiring system-user token.`,
    );
  }
  return { invalidDetail: null, warnings };
}
