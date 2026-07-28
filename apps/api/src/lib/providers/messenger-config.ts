import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";
import { ProviderNotConfiguredError, ACCOUNT_UNRESOLVED } from "@/lib/providers/config";
import { TtlCache } from "@/lib/providers/config-cache";
import { getMetaConnection, resolveWebhookSecrets } from "@/lib/providers/meta-connection";

/**
 * Per-team Facebook Messenger config. Same model as WhatsApp
 * (lib/providers/config.ts): credentials live on a `ChannelConnection` row
 * keyed by (workspaceId, "messenger") — `config` holds non-secret fields, `secrets`
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
function sendKey(workspaceId: string, accountId?: string | null): string {
  return `${workspaceId}::${accountId ?? "default"}`;
}

export function invalidateMessengerConfig(workspaceId: string): void {
  sendCache.deletePrefix(`${workspaceId}::`);
  webhookCache.delete(workspaceId);
}

async function loadSendCipher(
  workspaceId: string,
  accountId?: string | null,
): Promise<CachedSend> {
  // SECURITY: workspaceId stays in the WHERE even with an explicit account, so a
  // mis-stamped/foreign id can never load another tenant's credentials.
  if (!accountId) {
    // Same ambiguity guard as WhatsApp (see lib/providers/config.ts): a null
    // account is `onDelete: SetNull` fallout from a disconnected Page, and
    // resolving it to the default would reply from a Page/handle the customer
    // never messaged. Unambiguous with one active account; refused with
    // several, and self-healing because ingest re-stamps on the next inbound.
    const active = await db.channelConnection.count({
      where: { workspaceId, channel: "messenger", isActive: true },
    });
    if (active > 1) return { kind: "err", missing: [ACCOUNT_UNRESOLVED] };
  }
  const conn = await db.channelConnection.findFirst({
    where: accountId
      ? { id: accountId, workspaceId, channel: "messenger" }
      : { workspaceId, channel: "messenger", isDefault: true },
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

function materialize(workspaceId: string, cipher: SendCipher): MessengerSendConfig {
  let pageAccessToken: string;
  try {
    pageAccessToken = decryptSecret(cipher.pageAccessTokenCipher);
  } catch (err) {
    console.error(
      `[messenger-config] failed to decrypt send secrets for team=${workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw new ProviderNotConfiguredError(workspaceId, ["pageAccessToken (decrypt failed)"], "messenger");
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
export async function getMessengerSendConfig(
  workspaceId: string,
  accountId?: string | null,
): Promise<MessengerSendConfig> {
  const key = sendKey(workspaceId, accountId);
  const hit = sendCache.get(key);
  if (hit) {
    if (hit.kind === "err") {
      throw new ProviderNotConfiguredError(workspaceId, [...hit.missing], "messenger");
    }
    return materialize(workspaceId, hit.cipher);
  }
  const entry = await loadSendCipher(workspaceId, accountId);
  sendCache.set(key, entry);
  if (entry.kind === "err") throw new ProviderNotConfiguredError(workspaceId, [...entry.missing], "messenger");
  return materialize(workspaceId, entry.cipher);
}

/** Webhook-side Messenger config (GET verify + POST HMAC). Null when unconfigured. */
export async function getMessengerWebhookConfig(
  workspaceId: string,
): Promise<MessengerWebhookConfig | null> {
  const hit = webhookCache.get(workspaceId);
  let cipher: WebhookCipher | null;
  if (hit !== undefined) {
    cipher = hit;
  } else {
    const conn = await db.channelConnection.findFirst({
      where: { workspaceId, channel: "messenger", isDefault: true },
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
    webhookCache.set(workspaceId, cipher);
  }
  if (!cipher) return null;
  try {
    // Prefer the shared Meta App secret (single source — rotation there applies
    // to every channel at once); fall back to the per-channel cipher for legacy
    // / pre-Meta-App rows. See getMetaWebhookConfig for the rationale.
    const meta = await getMetaConnection(workspaceId);
    return {
      ...resolveWebhookSecrets(meta?.appSecret, decryptSecret(cipher.appSecretCipher)),
      verifyToken: cipher.verifyToken,
      pageId: cipher.pageId,
    };
  } catch (err) {
    console.error(
      `[messenger-config] failed to decrypt webhook secrets for team=${workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
