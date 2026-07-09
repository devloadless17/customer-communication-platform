import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import { getMetaConnection } from "@/lib/providers/meta-connection";

/**
 * Per-team Facebook Messenger config. Same model as WhatsApp
 * (lib/providers/config.ts): credentials live on a `ChannelConnection` row
 * keyed by (teamId, "messenger") — `config` holds non-secret fields, `secrets`
 * holds envelope-encrypted ciphertext per field. Kept in its own file (light
 * duplication over premature abstraction) so the WhatsApp loader stays
 * untouched and each channel's config shape is explicit.
 *
 * Messenger differs from WhatsApp: identity is a Page (`pageId`) + a Page
 * access token, there is NO phone number / WABA, and the same Meta app secret
 * verifies the inbound webhook HMAC. Same "cache ciphertext, decrypt-on-demand"
 * security posture as WhatsApp — decrypted tokens never outlive the request.
 */

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

export interface MessengerSendConfig {
  pageId: string;
  pageAccessToken: string;
  graphVersion: string;
}

export interface MessengerWebhookConfig {
  appSecret: string;
  verifyToken: string;
  /** The Page id every legit Messenger webhook carries in `entry[].id`. */
  pageId: string | null;
}

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";
const CONFIG_TTL_MS = 60_000;
const CONFIG_CACHE_MAX = 10_000;
const CONFIG_SWEEP_INTERVAL_MS = 5 * 60_000;

interface SendCipher {
  pageId: string;
  pageAccessTokenCipher: string;
}
interface WebhookCipher {
  appSecretCipher: string;
  verifyToken: string;
  pageId: string | null;
}

type CachedSend =
  | { kind: "ok"; cipher: SendCipher }
  | { kind: "err"; missing: readonly string[] };

const sendCache = new Map<string, { entry: CachedSend; exp: number }>();
const webhookCache = new Map<string, { value: WebhookCipher | null; exp: number }>();

function evictExpired<V extends { exp: number }>(map: Map<string, V>): void {
  const now = Date.now();
  for (const [k, v] of map) if (v.exp <= now) map.delete(k);
}
function evictOldestIfOverCap<V>(map: Map<string, V>, max: number): void {
  if (map.size < max) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

const sweeper = setInterval(() => {
  evictExpired(sendCache);
  evictExpired(webhookCache);
}, CONFIG_SWEEP_INTERVAL_MS);
sweeper.unref?.();

/** Drop cached Messenger credentials for a team. Call after the settings save. */
export function invalidateMessengerConfig(teamId: string): void {
  sendCache.delete(teamId);
  webhookCache.delete(teamId);
}

async function loadSendCipher(teamId: string): Promise<CachedSend> {
  const conn = await db.channelConnection.findUnique({
    where: { teamId_channel: { teamId, channel: "messenger" } },
    select: { config: true, secrets: true, isActive: true },
  });
  if (!conn || !conn.isActive) return { kind: "err", missing: ["not-connected"] };
  const config = (conn.config ?? {}) as MessengerChannelConfig;
  const secrets = (conn.secrets ?? {}) as MessengerChannelSecrets;
  const missing: string[] = [];
  if (!config.pageId) missing.push("pageId");
  if (!secrets.pageAccessToken) missing.push("pageAccessToken");
  if (missing.length > 0) return { kind: "err", missing };
  return {
    kind: "ok",
    cipher: { pageId: config.pageId!, pageAccessTokenCipher: secrets.pageAccessToken! },
  };
}

function materialize(teamId: string, cipher: SendCipher): MessengerSendConfig {
  let pageAccessToken: string;
  try {
    pageAccessToken = decryptSecret(cipher.pageAccessTokenCipher);
  } catch (err) {
    console.error(
      `[messenger-config] failed to decrypt send secrets for team=${teamId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw new ProviderNotConfiguredError(teamId, ["pageAccessToken (decrypt failed)"]);
  }
  return { pageId: cipher.pageId, pageAccessToken, graphVersion: DEFAULT_GRAPH_VERSION };
}

/** Send-side Messenger config. Throws ProviderNotConfigured when unconnected. */
export async function getMessengerSendConfig(teamId: string): Promise<MessengerSendConfig> {
  const hit = sendCache.get(teamId);
  if (hit && hit.exp > Date.now()) {
    if (hit.entry.kind === "err") {
      throw new ProviderNotConfiguredError(teamId, [...hit.entry.missing]);
    }
    return materialize(teamId, hit.entry.cipher);
  }
  const entry = await loadSendCipher(teamId);
  evictOldestIfOverCap(sendCache, CONFIG_CACHE_MAX);
  sendCache.set(teamId, { entry, exp: Date.now() + CONFIG_TTL_MS });
  if (entry.kind === "err") throw new ProviderNotConfiguredError(teamId, [...entry.missing]);
  return materialize(teamId, entry.cipher);
}

/** Webhook-side Messenger config (GET verify + POST HMAC). Null when unconfigured. */
export async function getMessengerWebhookConfig(
  teamId: string,
): Promise<MessengerWebhookConfig | null> {
  const hit = webhookCache.get(teamId);
  let cipher: WebhookCipher | null;
  if (hit && hit.exp > Date.now()) {
    cipher = hit.value;
  } else {
    const conn = await db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: "messenger" } },
      select: { config: true, secrets: true, isActive: true },
    });
    const config = (conn?.config ?? {}) as MessengerChannelConfig;
    const secrets = (conn?.secrets ?? {}) as MessengerChannelSecrets;
    cipher =
      conn && conn.isActive && secrets.appSecret && config.verifyToken
        ? {
            appSecretCipher: secrets.appSecret,
            verifyToken: config.verifyToken,
            pageId: config.pageId ?? null,
          }
        : null;
    evictOldestIfOverCap(webhookCache, CONFIG_CACHE_MAX);
    webhookCache.set(teamId, { value: cipher, exp: Date.now() + CONFIG_TTL_MS });
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
      pageId: cipher.pageId,
    };
  } catch (err) {
    console.error(
      `[messenger-config] failed to decrypt webhook secrets for team=${teamId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
