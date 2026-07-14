import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import { TtlCache } from "@/lib/providers/config-cache";
import { getMetaConnection, resolveWebhookSecrets } from "@/lib/providers/meta-connection";

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
  /** This channel's app secret, for appsecret_proof on Graph calls. */
  appSecret?: string;
}

export interface MessengerWebhookConfig {
  appSecret: string;
  /** Secondary secret to also try during HMAC verify (channel on its own app). */
  appSecretFallback?: string;
  verifyToken: string;
  /** The Page id every legit Messenger webhook carries in `entry[].id`. */
  pageId: string | null;
}

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";

interface SendCipher {
  pageId: string;
  pageAccessTokenCipher: string;
  /** This channel's OWN app secret cipher — for appsecret_proof on send. The
   *  proof must use the secret of the app that issued the token; each channel
   *  stores that alongside its token. Optional: proof is skipped if absent. */
  appSecretCipher?: string;
}
interface WebhookCipher {
  appSecretCipher: string;
  verifyToken: string;
  pageId: string | null;
}

type CachedSend =
  | { kind: "ok"; cipher: SendCipher }
  | { kind: "err"; missing: readonly string[] };

// TTL/cap/sweep mechanics live in the shared TtlCache primitive (config-cache.ts).
const sendCache = new TtlCache<CachedSend>();
const webhookCache = new TtlCache<WebhookCipher | null>();

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
    cipher: {
      pageId: config.pageId!,
      pageAccessTokenCipher: secrets.pageAccessToken!,
      ...(secrets.appSecret ? { appSecretCipher: secrets.appSecret } : {}),
    },
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
    throw new ProviderNotConfiguredError(teamId, ["pageAccessToken (decrypt failed)"], "messenger");
  }
  // App secret for appsecret_proof — best-effort: a decrypt failure must NOT
  // break sending (the proof is additive), so fall back to no proof.
  let appSecret: string | undefined;
  if (cipher.appSecretCipher) {
    try {
      appSecret = decryptSecret(cipher.appSecretCipher);
    } catch {
      appSecret = undefined;
    }
  }
  return {
    pageId: cipher.pageId,
    pageAccessToken,
    graphVersion: DEFAULT_GRAPH_VERSION,
    ...(appSecret ? { appSecret } : {}),
  };
}

/** Send-side Messenger config. Throws ProviderNotConfigured when unconnected. */
export async function getMessengerSendConfig(teamId: string): Promise<MessengerSendConfig> {
  const hit = sendCache.get(teamId);
  if (hit) {
    if (hit.kind === "err") {
      throw new ProviderNotConfiguredError(teamId, [...hit.missing], "messenger");
    }
    return materialize(teamId, hit.cipher);
  }
  const entry = await loadSendCipher(teamId);
  sendCache.set(teamId, entry);
  if (entry.kind === "err") throw new ProviderNotConfiguredError(teamId, [...entry.missing], "messenger");
  return materialize(teamId, entry.cipher);
}

/** Webhook-side Messenger config (GET verify + POST HMAC). Null when unconfigured. */
export async function getMessengerWebhookConfig(
  teamId: string,
): Promise<MessengerWebhookConfig | null> {
  const hit = webhookCache.get(teamId);
  let cipher: WebhookCipher | null;
  if (hit !== undefined) {
    cipher = hit;
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
    webhookCache.set(teamId, cipher);
  }
  if (!cipher) return null;
  try {
    // Prefer the shared Meta App secret (single source — rotation there applies
    // to every channel at once); fall back to the per-channel cipher for legacy
    // / pre-Meta-App rows. See getMetaWebhookConfig for the rationale.
    const meta = await getMetaConnection(teamId);
    return {
      ...resolveWebhookSecrets(meta?.appSecret, decryptSecret(cipher.appSecretCipher)),
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
