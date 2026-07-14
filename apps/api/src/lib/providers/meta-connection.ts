import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";

/**
 * The team's ONE shared Meta-app connection (App ID + App secret + system-user
 * token + verify token) that powers every Meta channel. Channel config loaders
 * read their app-level credentials from here and fall back to the legacy
 * per-channel `ChannelConnection.secrets` only when this row is absent — so a
 * team set up before this table keeps working until they fill it in.
 *
 * Same "cache ciphertext, decrypt per call" posture as the channel configs:
 * decrypted secrets never outlive the request.
 */

interface MetaConnConfig {
  appId?: string;
  verifyToken?: string;
  graphVersion?: string;
}
interface MetaConnSecrets {
  appSecret?: string;
  systemUserToken?: string;
}

export interface MetaConnectionResolved {
  appId: string | null;
  verifyToken: string | null;
  /** Decrypted — verifies inbound webhook HMAC (all Meta channels). */
  appSecret: string | null;
  /** Decrypted — the root token WhatsApp sends with and Page tokens derive from. */
  systemUserToken: string | null;
  graphVersion: string;
}

interface Cipher {
  appId: string | null;
  verifyToken: string | null;
  appSecretCipher: string | null;
  systemUserTokenCipher: string | null;
  graphVersion: string;
}

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";
const TTL_MS = 60_000;
const CACHE_MAX = 10_000;
const SWEEP_MS = 5 * 60_000;

const cache = new Map<string, { value: Cipher | null; exp: number }>();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
}, SWEEP_MS);
sweeper.unref?.();

/** Drop the cached Meta connection for a team. Call after the settings save. */
export function invalidateMetaConnection(teamId: string): void {
  cache.delete(teamId);
}

function tryDecrypt(cipher: string | null): string | null {
  if (cipher == null) return null;
  try {
    return decryptSecret(cipher);
  } catch {
    return null;
  }
}

/**
 * Resolve the shared Meta credentials for a team. `null` when no connection
 * exists; individual fields are `null` when not yet set. Never throws.
 */
export async function getMetaConnection(
  teamId: string,
): Promise<MetaConnectionResolved | null> {
  const hit = cache.get(teamId);
  let cipher: Cipher | null;
  if (hit && hit.exp > Date.now()) {
    cipher = hit.value;
  } else {
    const row = await db.metaConnection.findUnique({
      where: { teamId },
      select: { config: true, secrets: true },
    });
    if (!row) {
      cipher = null;
    } else {
      const config = (row.config ?? {}) as MetaConnConfig;
      const secrets = (row.secrets ?? {}) as MetaConnSecrets;
      cipher = {
        appId: config.appId ?? null,
        verifyToken: config.verifyToken ?? null,
        appSecretCipher: secrets.appSecret ?? null,
        systemUserTokenCipher: secrets.systemUserToken ?? null,
        graphVersion: config.graphVersion ?? DEFAULT_GRAPH_VERSION,
      };
    }
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(teamId, { value: cipher, exp: Date.now() + TTL_MS });
  }
  if (!cipher) return null;
  return {
    appId: cipher.appId,
    verifyToken: cipher.verifyToken,
    appSecret: tryDecrypt(cipher.appSecretCipher),
    systemUserToken: tryDecrypt(cipher.systemUserTokenCipher),
    graphVersion: cipher.graphVersion,
  };
}

/**
 * Candidate app secrets for inbound webhook HMAC verification. Prefer the shared
 * Meta App secret (rotating it there covers every channel at once), but ALSO
 * expose the channel's OWN stored secret as a fallback — so a channel connected
 * to a DIFFERENT Meta app than the shared one (e.g. Instagram on its own app,
 * signed with that app's secret) still verifies. `verifySignature` accepts
 * either candidate; both are secrets the team itself configured.
 */
export function resolveWebhookSecrets(
  sharedSecret: string | null | undefined,
  ownSecret: string,
): { appSecret: string; appSecretFallback?: string } {
  if (sharedSecret && sharedSecret !== ownSecret) {
    return { appSecret: sharedSecret, appSecretFallback: ownSecret };
  }
  return { appSecret: sharedSecret ?? ownSecret };
}
