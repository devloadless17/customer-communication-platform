import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import { TtlCache } from "@/lib/providers/config-cache";
import { getMetaConnection } from "@/lib/providers/meta-connection";

/**
 * Per-team Instagram DM config. Same credential model as WhatsApp / Messenger
 * (a `ChannelConnection` row keyed (teamId, "instagram"); `config` non-secret,
 * `secrets` envelope-encrypted). Identity is the Instagram business account id
 * (`igId`) + an Instagram access token; no phone / no Page / no WABA. The Meta
 * app secret verifies the inbound webhook HMAC. "cache ciphertext, decrypt on
 * demand" posture — decrypted tokens never outlive the request.
 */

interface InstagramChannelConfig {
  igId?: string;
  igUsername?: string;
  /** The Facebook Page the IG account is linked to — the SEND target host. */
  pageId?: string;
  appId?: string;
  verifyToken?: string;
}
interface InstagramChannelSecrets {
  igAccessToken?: string;
  appSecret?: string;
}

export interface InstagramSendConfig {
  igId: string;
  /**
   * The linked Facebook Page id. Instagram-via-Facebook-Login sends through the
   * PAGE (`POST /{pageId}/messages`, recipient = IGSID) with a Page access
   * token — `/{igId}/messages` is the graph.instagram.com (Instagram-Login)
   * pattern and returns `(#3)` here. So sends target the Page, like Messenger.
   */
  pageId: string;
  igAccessToken: string;
  graphVersion: string;
}

export interface InstagramWebhookConfig {
  appSecret: string;
  verifyToken: string;
  igId: string | null;
}

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";

interface SendCipher {
  igId: string;
  pageId: string;
  igAccessTokenCipher: string;
}
interface WebhookCipher {
  appSecretCipher: string;
  verifyToken: string;
  igId: string | null;
}

type CachedSend =
  | { kind: "ok"; cipher: SendCipher }
  | { kind: "err"; missing: readonly string[] };

// TTL/cap/sweep mechanics live in the shared TtlCache primitive (config-cache.ts).
const sendCache = new TtlCache<CachedSend>();
const webhookCache = new TtlCache<WebhookCipher | null>();

/** Drop cached Instagram credentials for a team. Call after the settings save. */
export function invalidateInstagramConfig(teamId: string): void {
  sendCache.delete(teamId);
  webhookCache.delete(teamId);
}

async function loadSendCipher(teamId: string): Promise<CachedSend> {
  const conn = await db.channelConnection.findUnique({
    where: { teamId_channel: { teamId, channel: "instagram" } },
    select: { config: true, secrets: true, isActive: true },
  });
  if (!conn || !conn.isActive) return { kind: "err", missing: ["not-connected"] };
  const config = (conn.config ?? {}) as InstagramChannelConfig;
  const secrets = (conn.secrets ?? {}) as InstagramChannelSecrets;
  const missing: string[] = [];
  if (!config.igId) missing.push("igId");
  // pageId is the send host now — a connection saved before Page-based
  // onboarding won't have it and must reconnect (surfaces as not-configured).
  if (!config.pageId) missing.push("pageId (reconnect Instagram)");
  if (!secrets.igAccessToken) missing.push("igAccessToken");
  if (missing.length > 0) return { kind: "err", missing };
  return {
    kind: "ok",
    cipher: {
      igId: config.igId!,
      pageId: config.pageId!,
      igAccessTokenCipher: secrets.igAccessToken!,
    },
  };
}

function materialize(teamId: string, cipher: SendCipher): InstagramSendConfig {
  let igAccessToken: string;
  try {
    igAccessToken = decryptSecret(cipher.igAccessTokenCipher);
  } catch (err) {
    console.error(
      `[instagram-config] failed to decrypt send secrets for team=${teamId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw new ProviderNotConfiguredError(teamId, ["igAccessToken (decrypt failed)"]);
  }
  return {
    igId: cipher.igId,
    pageId: cipher.pageId,
    igAccessToken,
    graphVersion: DEFAULT_GRAPH_VERSION,
  };
}

/** Send-side Instagram config. Throws ProviderNotConfigured when unconnected. */
export async function getInstagramSendConfig(teamId: string): Promise<InstagramSendConfig> {
  const hit = sendCache.get(teamId);
  if (hit) {
    if (hit.kind === "err") {
      throw new ProviderNotConfiguredError(teamId, [...hit.missing]);
    }
    return materialize(teamId, hit.cipher);
  }
  const entry = await loadSendCipher(teamId);
  sendCache.set(teamId, entry);
  if (entry.kind === "err") throw new ProviderNotConfiguredError(teamId, [...entry.missing]);
  return materialize(teamId, entry.cipher);
}

/** Webhook-side Instagram config (GET verify + POST HMAC). Null when unconfigured. */
export async function getInstagramWebhookConfig(
  teamId: string,
): Promise<InstagramWebhookConfig | null> {
  const hit = webhookCache.get(teamId);
  let cipher: WebhookCipher | null;
  if (hit !== undefined) {
    cipher = hit;
  } else {
    const conn = await db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: "instagram" } },
      select: { config: true, secrets: true, isActive: true },
    });
    const config = (conn?.config ?? {}) as InstagramChannelConfig;
    const secrets = (conn?.secrets ?? {}) as InstagramChannelSecrets;
    cipher =
      conn && conn.isActive && secrets.appSecret && config.verifyToken
        ? {
            appSecretCipher: secrets.appSecret,
            verifyToken: config.verifyToken,
            igId: config.igId ?? null,
          }
        : null;
    webhookCache.set(teamId, cipher);
  }
  if (!cipher) return null;
  try {
    // Prefer the shared Meta App secret (single source — rotation there applies
    // to every channel at once); fall back to the per-channel cipher for legacy
    // / pre-Meta-App rows. See getMetaWebhookConfig for the rationale.
    const meta = await getMetaConnection(teamId);
    return {
      appSecret: meta?.appSecret ?? decryptSecret(cipher.appSecretCipher),
      verifyToken: cipher.verifyToken,
      igId: cipher.igId,
    };
  } catch (err) {
    console.error(
      `[instagram-config] failed to decrypt webhook secrets for team=${teamId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
