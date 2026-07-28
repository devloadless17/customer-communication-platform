import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";
import { TtlCache } from "@/lib/providers/config-cache";
import { getMetaConnection, resolveWebhookSecrets } from "@/lib/providers/meta-connection";
import type { Channel } from "@ccp/shared/types";
import { getCountryFromPhone } from "@ccp/shared/utils";

/**
 * Per-team provider configuration. CLAUDE.md rule #6: secrets live in the DB,
 * not in env vars, so each customer can plug in their own Meta app without us
 * redeploying. They live on a `ChannelConnection` row keyed by (workspaceId,
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
  /** See MetaSendConfig.messagingAccountId — opt-in, unset for everyone. */
  messagingAccountId?: string;
  appId?: string;
  verifyToken?: string;
  /**
   * OUR per-number call-recording policy (Meta stores no such setting —
   * recording is a per-call opt-in on connect/accept, so the standing choice
   * lives here). Applied by CallsService to every placed/answered call on
   * this number. `purpose` + `announcementLanguage` are required by the
   * provider whenever recording is enabled.
   */
  callRecording?: {
    enabled?: boolean;
    purpose?: string;
    announcementLanguage?: string;
  };
  /** Same policy shape for transcription — an independent provider feature
   *  with its own webhook/artifact/pricing; see callRecording above. */
  callTranscription?: {
    enabled?: boolean;
    purpose?: string;
    announcementLanguage?: string;
  };
  /**
   * OUR written consent notice, auto-sent into the chat around
   * recorded/transcribed calls (before dialing on outbound, at answer on
   * inbound). Exists because the provider's SPOKEN announcement has no Arabic
   * voice — this message is ours and can be fully Arabic, and it leaves
   * durable in-thread proof of notice the voice line can't.
   */
  callConsentMessage?: string;
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
   * Meta's Messaging Account id, for the account-model split (WABA → WhatsApp
   * Business Account + Messaging Account). Sent as `messaging_account_id` on
   * Messages API calls to say WHICH account to bill.
   *
   * OPT-IN, and unset for everyone by default — that is deliberate. It is
   * optional at Phase 1 and only *required* when one app holds SEVERAL
   * Messaging Accounts on one number, which a single-integration workspace
   * never has. Meanwhile the parameter belongs to a beta that is "subject to
   * change", and Graph rejects an unrecognised body field with `#100`, failing
   * the whole send. So the wire stays byte-identical until a tenant who
   * actually needs it sets one.
   *
   * The value is the Messaging Account id — which IS the existing WABA id, so
   * for most tenants it would equal `wabaId`. It is stored separately rather
   * than derived, because "the account that owns our templates" and "the
   * account to bill" are only the same thing until they aren't.
   */
  messagingAccountId?: string;
  /**
   * Meta App ID — required only by the resumable upload endpoint used when
   * creating a template with a media header. Optional everywhere else.
   */
  appId?: string;
  /**
   * The business phone number in display form (e.g. "+1 555-0100").
   *
   * Needed because business-initiated calling eligibility is decided by OUR
   * number's country, not the customer's — a business number in a blocked
   * market cannot place calls anywhere, while an eligible one can call
   * customers in any supported country. Optional: a connection saved before
   * this was captured has none, and the caller treats unknown as "allow" and
   * lets Meta be the authority.
   */
  displayPhoneNumber?: string;
}

export interface MetaWebhookConfig {
  appSecret: string;
  /** Secondary secret to also try during HMAC verify (channel on its own app). */
  appSecretFallback?: string;
  verifyToken: string;
  /** Optional — when set, every webhook's `entry[].changes[].value.metadata.phone_number_id`
   *  must match. Caching this here lets the controller's mismatch check
   *  reuse the same cached lookup as the appSecret read instead of paying
   *  a separate `db.workspace.findUnique` per webhook. */
  phoneNumberId: string | null;
}

// Human channel names for error copy (settings paths are the enum values). Kept
// local so this low-level module needs no shared UI-label dep; the three live
// channels are the only ones a loader throws for today.
const CHANNEL_DISPLAY_NAME: Partial<Record<Channel, string>> = {
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  webchatwidget: "Website chat",
};

export class ProviderNotConfiguredError extends Error {
  readonly workspaceId: string;
  readonly channel: Channel;
  constructor(workspaceId: string, missing: string[], channel: Channel = "whatsapp") {
    const label = CHANNEL_DISPLAY_NAME[channel] ?? channel;
    super(
      `Team ${workspaceId} is missing ${label} config: ${missing.join(", ")}. ` +
        `Reconnect it in /settings/${channel}.`,
    );
    this.name = "ProviderNotConfiguredError";
    this.workspaceId = workspaceId;
    this.channel = channel;
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
 * The TTL/cap/sweep mechanics live in the shared `TtlCache` primitive
 * (config-cache.ts); this file only owns the WhatsApp config shape + loaders.
 */
interface SendConfigCipher {
  phoneNumberId: string;
  accessTokenCipher: string;
  wabaId?: string;
  messagingAccountId?: string;
  appId?: string;
  displayPhoneNumber?: string;
}
interface WebhookConfigCipher {
  appSecretCipher: string;
  verifyToken: string;
  phoneNumberId: string | null;
}

type CachedSend =
  | { kind: "ok"; cipher: SendConfigCipher }
  | { kind: "err"; missing: readonly string[] };
const sendCache = new TtlCache<CachedSend>();
const webhookCache = new TtlCache<WebhookConfigCipher | null>();

/**
 * Cache key for a send config. A workspace may hold SEVERAL accounts on a
 * channel, so credentials are cached per ACCOUNT; `default` is the workspace's
 * default account. Caching per workspace alone would hand one number's token to
 * a send meant for another.
 */
function sendKey(workspaceId: string, accountId?: string | null): string {
  return `${workspaceId}::${accountId ?? "default"}`;
}

/** Drop cached credentials for a workspace (every account). Call after writes. */
export function invalidateProviderConfig(workspaceId: string): void {
  sendCache.deletePrefix(`${workspaceId}::`);
  webhookCache.delete(workspaceId);
}

async function loadSendCipher(
  workspaceId: string,
  accountId?: string | null,
): Promise<CachedSend> {
  // SECURITY: `workspaceId` stays in the WHERE even when an explicit account is
  // named. `accountId` can originate from a stored row, so scoping by it alone
  // would let a mis-stamped/foreign id load ANOTHER tenant's credentials.
  if (!accountId) {
    // NO ACCOUNT NAMED. Falling straight through to the default is only safe
    // when there IS no other choice.
    //
    // `Conversation.channelConnectionId` and `Broadcast.channelConnectionId`
    // are both `onDelete: SetNull`, so disconnecting a number silently nulls
    // every thread and campaign bound to it — and a null here used to resolve
    // to `isDefault: true`. The customer then got a reply (or a whole
    // campaign) from a number they never messaged, with no 24h window there,
    // which is exactly what `channel-accounts.service.remove()`'s docstring
    // promises cannot happen ("they become unsendable rather than silently
    // falling back to a sibling number"). It also quietly undid the §2
    // per-thread account fix by nulling the column the send paths read.
    //
    // With one active account the fallback is unambiguous and stays. With
    // several, refuse: the next inbound re-stamps the thread's account
    // (ingest re-stamps whenever it differs), so this is self-healing rather
    // than terminal.
    const active = await db.channelConnection.count({
      where: { workspaceId, channel: "whatsapp", isActive: true },
    });
    if (active > 1) return { kind: "err", missing: ["account-unresolved"] };
  }
  const conn = await db.channelConnection.findFirst({
    where: accountId
      ? { id: accountId, workspaceId, channel: "whatsapp" }
      : { workspaceId, channel: "whatsapp", isDefault: true },
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
      ...(config.messagingAccountId
        ? { messagingAccountId: config.messagingAccountId }
        : {}),
      ...(config.appId ? { appId: config.appId } : {}),
      ...(config.displayPhoneNumber
        ? { displayPhoneNumber: config.displayPhoneNumber }
        : {}),
    },
  };
}

function materializeSendConfig(
  workspaceId: string,
  cipher: SendConfigCipher,
): MetaSendConfig {
  let accessToken: string;
  try {
    // Stored as envelope-encrypted ciphertext (lib/crypto/envelope.ts).
    // decryptSecret() passes legacy plaintext rows through unchanged so the
    // first load after rollout still works; the next credential save in
    // /api/workspace/whatsapp rewrites the row as ciphertext.
    accessToken = decryptSecret(cipher.accessTokenCipher);
  } catch (err) {
    console.error(
      `[provider-config] failed to decrypt send secrets for team=${workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Surface as ProviderNotConfigured so callers (reply box, broadcast
    // runner) render the "reconnect WhatsApp" prompt instead of a 500.
    // ENCRYPTION_KEY rotation or ciphertext corruption land here.
    throw new ProviderNotConfiguredError(workspaceId, ["accessToken (decrypt failed)"]);
  }
  return {
    phoneNumberId: cipher.phoneNumberId,
    accessToken,
    graphVersion: DEFAULT_GRAPH_VERSION,
    ...(cipher.wabaId ? { wabaId: cipher.wabaId } : {}),
    ...(cipher.messagingAccountId
      ? { messagingAccountId: cipher.messagingAccountId }
      : {}),
    ...(cipher.appId ? { appId: cipher.appId } : {}),
    ...(cipher.displayPhoneNumber
      ? { displayPhoneNumber: cipher.displayPhoneNumber }
      : {}),
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
export async function getMetaSendConfig(
  workspaceId: string,
  accountId?: string | null,
): Promise<MetaSendConfig> {
  const key = sendKey(workspaceId, accountId);
  const hit = sendCache.get(key);
  if (hit) {
    if (hit.kind === "err") {
      throw new ProviderNotConfiguredError(workspaceId, [...hit.missing]);
    }
    return materializeSendConfig(workspaceId, hit.cipher);
  }
  const entry = await loadSendCipher(workspaceId, accountId);
  sendCache.set(key, entry);
  if (entry.kind === "err") {
    throw new ProviderNotConfiguredError(workspaceId, [...entry.missing]);
  }
  return materializeSendConfig(workspaceId, entry.cipher);
}

/**
 * The ISO country of a team's own WhatsApp business number, or null when we
 * don't know it (no connection, or no display number captured at onboarding).
 *
 * Exists so the domain layer can answer "may this team place business-initiated
 * calls?" — eligibility follows OUR number's country, not the customer's —
 * without unpacking the opaque send-config credential blob.
 *
 * Reads the row directly rather than going through the 60s send-config cache:
 * this is not a hot path (a call is a deliberate human action), and a stale
 * answer here means an admin who just reconnected with a new number watches
 * the Call button stay wrong for a minute with nothing to explain it.
 */
export async function getBusinessNumberCountry(
  workspaceId: string,
  accountId?: string | null,
): Promise<string | null> {
  // Per-account when the caller knows which number is acting (a thread's
  // bound connection, the settings page's picker); the workspace default
  // otherwise. Eligibility is per NUMBER — two numbers in one workspace can
  // sit in different countries.
  const conn = await db.channelConnection.findFirst({
    where: accountId
      ? { id: accountId, workspaceId, channel: "whatsapp" }
      : { workspaceId, channel: "whatsapp", isDefault: true },
    select: { config: true },
  });
  const config = (conn?.config ?? {}) as MetaChannelConfig;
  // Unknown country ⇒ the caller treats it as "don't gate" and lets the
  // provider be the authority.
  return getCountryFromPhone(config.displayPhoneNumber ?? null);
}

/**
 * Loads the webhook-side config. Used by /api/webhooks/meta/[workspaceId] for
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
export async function getTeamVerifyTokens(workspaceId: string): Promise<string[]> {
  const [conns, meta] = await Promise.all([
    db.channelConnection.findMany({ where: { workspaceId }, select: { config: true } }),
    getMetaConnection(workspaceId),
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
  workspaceId: string,
): Promise<MetaWebhookConfig | null> {
  const hit = webhookCache.get(workspaceId);
  let cipher: WebhookConfigCipher | null;
  if (hit !== undefined) {
    cipher = hit;
  } else {
    const conn = await db.channelConnection.findFirst({
      where: { workspaceId, channel: "whatsapp", isDefault: true },
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
    webhookCache.set(workspaceId, cipher);
  }
  if (!cipher) return null;
  try {
    // App secret signs every inbound webhook (HMAC-SHA256). Prefer the shared
    // Meta App connection (the single source — an app-secret rotation there
    // takes effect on every channel immediately, no per-channel resync), and
    // fall back to the per-channel cipher for legacy / pre-Meta-App rows.
    const meta = await getMetaConnection(workspaceId);
    return {
      ...resolveWebhookSecrets(meta?.appSecret, decryptSecret(cipher.appSecretCipher)),
      verifyToken: cipher.verifyToken,
      phoneNumberId: cipher.phoneNumberId,
    };
  } catch (err) {
    console.error(
      `[provider-config] failed to decrypt webhook secrets for team=${workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
