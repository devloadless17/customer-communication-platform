import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";

/**
 * Per-team provider configuration. CLAUDE.md rule #6: secrets live on the
 * Team row, not in env vars, so each customer can plug in their own Meta
 * app without us redeploying.
 *
 * The config is split into two shapes because the webhook route only needs
 * the verifier secret + verify token (it doesn't send), while the send/read
 * routes only need the access token + phone number id (they don't verify).
 * Splitting keeps each call site honest about what it actually touches.
 */

export interface MetaSendConfig {
  phoneNumberId: string;
  accessToken: string;
  graphVersion: string;
  /**
   * WhatsApp Business Account id. Required by the template catalog endpoint
   * (`/{wabaId}/message_templates`) but NOT required for sending text/media/
   * templates — those go through the phone-number-id. Optional here so the
   * send routes can ignore it; the templates sync route enforces presence.
   */
  wabaId?: string;
  /**
   * Meta App ID — required only by the resumable upload endpoint used when
   * creating a template with a media header. Optional everywhere else.
   */
  appId?: string;
}

export interface MetaWebhookConfig {
  appSecret: string;
  verifyToken: string;
  /** Optional — when set, every webhook's `entry[].changes[].value.metadata.phone_number_id`
   *  must match. Caching this here lets the controller's mismatch check
   *  reuse the same cached lookup as the appSecret read instead of paying
   *  a separate `db.team.findUnique` per webhook. */
  phoneNumberId: string | null;
}

export class ProviderNotConfiguredError extends Error {
  readonly teamId: string;
  constructor(teamId: string, missing: string[]) {
    super(
      `Team ${teamId} is missing WhatsApp config: ${missing.join(", ")}. ` +
        `Connect the number in /settings/whatsapp.`,
    );
    this.name = "ProviderNotConfiguredError";
    this.teamId = teamId;
  }
}

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";

/**
 * In-process credential cache.
 *
 * Team credentials change ~never, but the send/read/webhook paths all hit
 * the `Team` row on every request — that's a DB round-trip on the realtime
 * hot path for data that's effectively static. Cache it with a short TTL and
 * bust it explicitly when the settings page saves new credentials
 * (`invalidateProviderConfig`).
 *
 * SECURITY POSTURE — what we cache vs decrypt-on-demand
 * ------------------------------------------------------
 * The cache stores the *encrypted ciphertext* of secrets, NOT the
 * decrypted plaintext. Decryption happens per-call, inside the
 * `getMeta*Config` function, and the decrypted string never outlives
 * the caller's scope. Reason: holding decrypted access tokens / app
 * secrets in long-lived process memory undoes the DB-side envelope
 * encryption — a `process.memoryUsage()` heap snapshot, an OOM core
 * dump, or any post-mortem debugger lands every tenant's plaintext
 * credentials. Decrypt is microseconds (AES-256-GCM with a hot key);
 * the cache's real value is amortizing the DB roundtrip, which still
 * applies.
 *
 * Non-secret fields (`metaPhoneNumberId`, `metaWabaId`, `metaAppId`,
 * `metaVerifyToken`) are cached plaintext — they're either public
 * (phone number id is in every webhook payload) or shared-with-Meta
 * (verify token is the GET-challenge handshake value).
 *
 * Single-process only by design (CLAUDE.md: one VPS, one app instance).
 * The day a second instance shows up this moves to Redis alongside the
 * Socket.io adapter — and the same "store ciphertext, decrypt-on-demand"
 * invariant applies there.
 */
const CONFIG_TTL_MS = 60_000;
// Bound the per-team caches so a multi-tenant scale-up doesn't grow them
// unboundedly. 10k teams is comfortably above the documented "~5 tenants"
// trigger threshold from CLAUDE.md — entries past that get LRU-evicted
// on insert. Periodic sweep drops expired entries on top of that so
// memory stays bounded even before the cap kicks in.
const CONFIG_CACHE_MAX = 10_000;
const CONFIG_SWEEP_INTERVAL_MS = 5 * 60_000;

interface SendConfigCipher {
  phoneNumberId: string;
  accessTokenCipher: string;
  wabaId?: string;
  appId?: string;
}
interface WebhookConfigCipher {
  appSecretCipher: string;
  verifyToken: string;
  phoneNumberId: string | null;
}

type CachedSend =
  | { kind: "ok"; cipher: SendConfigCipher }
  | { kind: "err"; missing: readonly string[] };
const sendCache = new Map<string, { entry: CachedSend; exp: number }>();
const webhookCache = new Map<
  string,
  { value: WebhookConfigCipher | null; exp: number }
>();

function evictExpired<V extends { exp: number }>(map: Map<string, V>): void {
  const now = Date.now();
  for (const [k, v] of map) {
    if (v.exp <= now) map.delete(k);
  }
}
function evictOldestIfOverCap<V>(map: Map<string, V>, max: number): void {
  if (map.size < max) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

const configSweeper = setInterval(() => {
  evictExpired(sendCache);
  evictExpired(webhookCache);
}, CONFIG_SWEEP_INTERVAL_MS);
configSweeper.unref?.();

/** Drop cached credentials for a team. Call after the settings page writes. */
export function invalidateProviderConfig(teamId: string): void {
  sendCache.delete(teamId);
  webhookCache.delete(teamId);
}

async function loadSendCipher(teamId: string): Promise<CachedSend> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: {
      metaPhoneNumberId: true,
      metaAccessToken: true,
      metaWabaId: true,
      metaAppId: true,
    },
  });
  if (!team) return { kind: "err", missing: ["team-not-found"] };
  const missing: string[] = [];
  if (!team.metaPhoneNumberId) missing.push("phoneNumberId");
  if (!team.metaAccessToken) missing.push("accessToken");
  if (missing.length > 0) return { kind: "err", missing };
  return {
    kind: "ok",
    cipher: {
      phoneNumberId: team.metaPhoneNumberId!,
      // Store the CIPHERTEXT in cache, not the decrypted token. Decrypt
      // per-call so plaintext never lives longer than the request that
      // uses it. See the cache header comment for the security rationale.
      accessTokenCipher: team.metaAccessToken!,
      ...(team.metaWabaId ? { wabaId: team.metaWabaId } : {}),
      ...(team.metaAppId ? { appId: team.metaAppId } : {}),
    },
  };
}

function materializeSendConfig(
  teamId: string,
  cipher: SendConfigCipher,
): MetaSendConfig {
  let accessToken: string;
  try {
    // Stored as envelope-encrypted ciphertext (lib/crypto/envelope.ts).
    // decryptSecret() passes legacy plaintext rows through unchanged so the
    // first load after rollout still works; the next credential save in
    // /api/team/whatsapp rewrites the row as ciphertext.
    accessToken = decryptSecret(cipher.accessTokenCipher);
  } catch (err) {
    console.error(
      `[provider-config] failed to decrypt send secrets for team=${teamId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Surface as ProviderNotConfigured so callers (reply box, broadcast
    // runner) render the "reconnect WhatsApp" prompt instead of a 500.
    // ENCRYPTION_KEY rotation or ciphertext corruption land here.
    throw new ProviderNotConfiguredError(teamId, ["accessToken (decrypt failed)"]);
  }
  return {
    phoneNumberId: cipher.phoneNumberId,
    accessToken,
    graphVersion: DEFAULT_GRAPH_VERSION,
    ...(cipher.wabaId ? { wabaId: cipher.wabaId } : {}),
    ...(cipher.appId ? { appId: cipher.appId } : {}),
  };
}

/**
 * Loads the send-side Meta config for a team. Throws ProviderNotConfigured
 * if the admin hasn't pasted credentials yet — surface this to the agent so
 * the reply box can render an "connect WhatsApp" prompt instead of pretending
 * the send went through. The not-configured result is cached too (a team that
 * hasn't connected gets hammered with read/mark-read attempts on stale rows).
 *
 * The decrypted access token is produced fresh from the cached ciphertext
 * on every call — see the cache header comment for the security rationale.
 */
export async function getMetaSendConfig(teamId: string): Promise<MetaSendConfig> {
  const hit = sendCache.get(teamId);
  if (hit && hit.exp > Date.now()) {
    if (hit.entry.kind === "err") {
      throw new ProviderNotConfiguredError(teamId, [...hit.entry.missing]);
    }
    return materializeSendConfig(teamId, hit.entry.cipher);
  }
  const entry = await loadSendCipher(teamId);
  evictOldestIfOverCap(sendCache, CONFIG_CACHE_MAX);
  sendCache.set(teamId, { entry, exp: Date.now() + CONFIG_TTL_MS });
  if (entry.kind === "err") {
    throw new ProviderNotConfiguredError(teamId, [...entry.missing]);
  }
  return materializeSendConfig(teamId, entry.cipher);
}

/**
 * Loads the webhook-side config. Used by /api/webhooks/meta/[teamId] for
 * both the GET verify dance and POST HMAC verification.
 *
 * Returns null on missing-config OR on decrypt failure (corrupted ciphertext,
 * rotated ENCRYPTION_KEY) — the dispatcher maps that to 403 silently, which
 * is correct: Meta retries on non-2xx, so a 500 here would create a webhook
 * retry storm during an outage we can't fix from the request handler. The
 * underlying error is logged for ops.
 *
 * The decrypted app secret is produced fresh from the cached ciphertext on
 * every call — see the cache header comment for the security rationale.
 */
export async function getMetaWebhookConfig(
  teamId: string,
): Promise<MetaWebhookConfig | null> {
  const hit = webhookCache.get(teamId);
  let cipher: WebhookConfigCipher | null;
  if (hit && hit.exp > Date.now()) {
    cipher = hit.value;
  } else {
    const team = await db.team.findUnique({
      where: { id: teamId },
      select: {
        metaAppSecret: true,
        metaVerifyToken: true,
        metaPhoneNumberId: true,
      },
    });
    cipher =
      team && team.metaAppSecret && team.metaVerifyToken
        ? {
            appSecretCipher: team.metaAppSecret,
            verifyToken: team.metaVerifyToken,
            phoneNumberId: team.metaPhoneNumberId ?? null,
          }
        : null;
    evictOldestIfOverCap(webhookCache, CONFIG_CACHE_MAX);
    webhookCache.set(teamId, { value: cipher, exp: Date.now() + CONFIG_TTL_MS });
  }
  if (!cipher) return null;
  try {
    // App secret signs every inbound webhook (HMAC-SHA256). Stored
    // encrypted; legacy plaintext rows decrypt through unchanged.
    return {
      appSecret: decryptSecret(cipher.appSecretCipher),
      verifyToken: cipher.verifyToken,
      phoneNumberId: cipher.phoneNumberId,
    };
  } catch (err) {
    console.error(
      `[provider-config] failed to decrypt webhook secrets for team=${teamId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
