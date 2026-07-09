import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";
import { getMetaConnection } from "@/lib/providers/meta-connection";

/**
 * Per-team provider configuration. CLAUDE.md rule #6: secrets live in the DB,
 * not in env vars, so each customer can plug in their own Meta app without us
 * redeploying. They live on a `ChannelConnection` row keyed by (teamId,
 * provider) — `config` holds non-secret fields, `secrets` holds the
 * envelope-encrypted ciphertext per field. Adding a channel = a new row, not
 * a new column-set on Team.
 *
 * The config is split into two shapes because the webhook route only needs
 * the verifier secret + verify token (it doesn't send), while the send/read
 * routes only need the access token + phone number id (they don't verify).
 * Splitting keeps each call site honest about what it actually touches.
 */

/** Shape of `ChannelConnection.config` (non-secret) for the meta_cloud provider. */
interface MetaChannelConfig {
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  wabaId?: string;
  appId?: string;
  verifyToken?: string;
}
/** Shape of `ChannelConnection.secrets` — envelope-encrypted ciphertext per field. */
interface MetaChannelSecrets {
  accessToken?: string;
  appSecret?: string;
}

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
  const conn = await db.channelConnection.findUnique({
    where: { teamId_channel: { teamId, channel: "whatsapp" } },
    select: { config: true, secrets: true, isActive: true },
  });
  if (!conn || !conn.isActive) return { kind: "err", missing: ["not-connected"] };
  const config = (conn.config ?? {}) as MetaChannelConfig;
  const secrets = (conn.secrets ?? {}) as MetaChannelSecrets;
  const missing: string[] = [];
  if (!config.phoneNumberId) missing.push("phoneNumberId");
  if (!secrets.accessToken) missing.push("accessToken");
  if (missing.length > 0) return { kind: "err", missing };
  return {
    kind: "ok",
    cipher: {
      phoneNumberId: config.phoneNumberId!,
      // Store the CIPHERTEXT in cache, not the decrypted token. Decrypt
      // per-call so plaintext never lives longer than the request that
      // uses it. See the cache header comment for the security rationale.
      accessTokenCipher: secrets.accessToken!,
      ...(config.wabaId ? { wabaId: config.wabaId } : {}),
      ...(config.appId ? { appId: config.appId } : {}),
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
/**
 * Every connected Meta channel's verify token for a team, read straight from
 * the ChannelConnection config — for ALL channels, regardless of whether the
 * connection is active or has an app secret yet.
 *
 * Used ONLY by the GET subscription handshake. Meta's setup order is "verify
 * the callback URL first, finish the connection after", and answering a verify
 * challenge needs nothing but the token — the app secret is only for POST HMAC.
 * So honoring a token here (even for a placeholder connection that only has a
 * pre-minted verify token) grants NO message access: the POST path still
 * independently requires the per-channel app secret to accept any payload.
 */
export async function getTeamVerifyTokens(teamId: string): Promise<string[]> {
  const [conns, meta] = await Promise.all([
    db.channelConnection.findMany({ where: { teamId }, select: { config: true } }),
    getMetaConnection(teamId),
  ]);
  const tokens = conns
    .map((c) => (c.config as { verifyToken?: unknown } | null)?.verifyToken)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  // The shared Meta-app verify token — lets a team verify its ONE callback URL
  // right after setting up the Meta App, before any channel is connected.
  if (meta?.verifyToken) tokens.push(meta.verifyToken);
  return tokens;
}

export async function getMetaWebhookConfig(
  teamId: string,
): Promise<MetaWebhookConfig | null> {
  const hit = webhookCache.get(teamId);
  let cipher: WebhookConfigCipher | null;
  if (hit && hit.exp > Date.now()) {
    cipher = hit.value;
  } else {
    const conn = await db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: "whatsapp" } },
      select: { config: true, secrets: true, isActive: true },
    });
    const config = (conn?.config ?? {}) as MetaChannelConfig;
    const secrets = (conn?.secrets ?? {}) as MetaChannelSecrets;
    cipher =
      conn && conn.isActive && secrets.appSecret && config.verifyToken
        ? {
            appSecretCipher: secrets.appSecret,
            verifyToken: config.verifyToken,
            phoneNumberId: config.phoneNumberId ?? null,
          }
        : null;
    evictOldestIfOverCap(webhookCache, CONFIG_CACHE_MAX);
    webhookCache.set(teamId, { value: cipher, exp: Date.now() + CONFIG_TTL_MS });
  }
  if (!cipher) return null;
  try {
    // App secret signs every inbound webhook (HMAC-SHA256). Prefer the shared
    // Meta App connection (the single source — an app-secret rotation there
    // takes effect on every channel immediately, no per-channel resync), and
    // fall back to the per-channel cipher for legacy / pre-Meta-App rows.
    const meta = await getMetaConnection(teamId);
    return {
      appSecret: meta?.appSecret ?? decryptSecret(cipher.appSecretCipher),
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
