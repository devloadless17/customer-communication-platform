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

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v26.0";
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
export function invalidateMetaConnection(workspaceId: string): void {
  cache.delete(workspaceId);
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
  workspaceId: string,
): Promise<MetaConnectionResolved | null> {
  const hit = cache.get(workspaceId);
  let cipher: Cipher | null;
  if (hit && hit.exp > Date.now()) {
    cipher = hit.value;
  } else {
    const row = await db.metaConnection.findUnique({
      where: { workspaceId },
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
    cache.set(workspaceId, { value: cipher, exp: Date.now() + TTL_MS });
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
 * expose each connected ACCOUNT's own stored secret — so an account connected to
 * a DIFFERENT Meta app than the shared one (e.g. Instagram on its own app, or a
 * second WhatsApp number onboarded under its own app) still verifies.
 * `verifySignature` accepts any candidate; every one is a secret the team itself
 * configured, so this never widens trust beyond the team's own apps.
 *
 * WHY A SET, NOT ONE ACCOUNT'S SECRET. A workspace holds MANY accounts per
 * channel, and Meta signs an inbound webhook with the secret of whichever app
 * owns the account it came from. Resolving a single account's secret — the
 * DEFAULT's — meant a sibling's inbound failed HMAC and was dropped as forged:
 * silently, and permanently once Meta stopped retrying. The GET-challenge half
 * of this same handshake already collects tokens from every connection
 * (`getTeamVerifyTokens`); this is the POST half finally agreeing with it.
 *
 * Returns null only when there is no candidate at all — the one genuine
 * "this channel is not configured" case.
 */
export function resolveWebhookSecretCandidates(
  sharedSecret: string | null | undefined,
  ownSecrets: readonly string[],
): { appSecret: string; appSecretFallbacks: string[] } | null {
  // Shared first, so the overwhelmingly common case verifies on the first HMAC.
  // De-duplicated: a workspace whose accounts all sit on the shared app would
  // otherwise recompute the same digest once per account.
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const secret of [sharedSecret, ...ownSecrets]) {
    if (!secret || seen.has(secret)) continue;
    seen.add(secret);
    ordered.push(secret);
  }
  const [primary, ...fallbacks] = ordered;
  if (primary === undefined) return null;
  return { appSecret: primary, appSecretFallbacks: fallbacks };
}
