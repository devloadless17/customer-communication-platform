import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";
import { platformAppSecrets } from "@/lib/providers/app-level-webhook";
import { TtlCache } from "@/lib/providers/config-cache";
import {
  getMetaConnection,
  resolveWebhookSecretCandidates,
} from "@/lib/providers/meta-connection";
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
  // NO `wabaId` HERE. It used to live in this JSON blob *and* in a column, with
  // the send-config loader reading the JSON while template scoping read the
  // column — two copies of one fact that could drift. The
  // `WhatsappBusinessAccount` FK is now the single authority and this loader
  // joins it.
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
   * HOW call artifacts are produced for this number:
   *   - "inapp" (DEFAULT — maintainer decision 2026-07-28): the agent's
   *     BROWSER records (silently — no announcement), uploads to our R2, and
   *     the transcript comes from our own Whisper pipeline (Arabic-native).
   *     Consent is the business's responsibility; the written consent notice
   *     above is the built-in way to give it when wanted.
   *   - "meta": explicit opt-in to the provider's built-in features — every
   *     call opens with Meta's spoken consent announcement (no Arabic voice)
   *     and artifacts arrive ~1min post-call.
   */
  callArtifactMode?: "meta" | "inapp";
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
   * META's WhatsApp Business Account id, joined from
   * `ChannelConnection.wabaAccount.externalWabaId`. Required by the template
   * catalog endpoint (`/{wabaId}/message_templates`) but NOT required for
   * sending text/media/templates — those go through the phone-number-id.
   *
   * Undefined means this number has NO WABA linked. That is a hard refusal for
   * anything template-shaped, never "no opinion": the old `""` sentinel made the
   * cross-account guard a no-op, so any template was sendable from any account.
   */
  wabaId?: string;
  /**
   * OUR `WhatsappBusinessAccount.id` for the same WABA. Carried alongside
   * `wabaId` so template scoping can key on the FK without a second query, while
   * every outward-facing DTO keeps emitting Meta's `wabaId` (never our cuid).
   */
  wabaAccountId?: string;
  /**
   * Meta's Messaging Account id, for the account-model split (WABA → WhatsApp
   * Business Account (WAAC, the phone number) + Messaging Account (templates,
   * billing, webhook subscriptions — and it KEEPS the WABA's id)). Sent as
   * `messaging_account_id` on Messages API calls to say WHICH account to bill —
   * see `messagingAccountField`, which documents why that spelling and NOT the
   * `paid_messaging_account_id` the guide pages still show (changelog 2026-06-16
   * made the latter a deprecated alias).
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
   * THIS ACCOUNT'S OWN Meta app secret, used only to compute `appsecret_proof`
   * on Graph calls (never sent to Meta itself).
   *
   * It must be the secret of the app that ISSUED `accessToken`, which is why it
   * is read from the connection's own `secrets` rather than the workspace's
   * shared Meta app: an account onboarded under a different app signs with that
   * app's secret, and using the shared one would make every proof invalid for
   * exactly those accounts.
   *
   * Optional and best-effort. The proof is ADDITIVE — Meta accepts a call
   * without it unless the app has "Require App Secret" enabled — so a missing or
   * undecryptable secret must degrade to "no proof" and never block a send.
   */
  appSecret?: string;
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
  /** First candidate to try — the shared Meta App secret when one is set. */
  appSecret: string;
  /** Every OTHER candidate: each active account's own stored secret. A SET, not
   *  one value — see `resolveWebhookSecretCandidates` for why. */
  appSecretFallbacks: string[];
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

/** The sentinel a loader returns when NO account was named and the workspace
 *  has more than one live account on the channel, so the fallback would be a
 *  guess. Exported because it is a distinct, actionable condition — not a
 *  missing credential. */
export const ACCOUNT_UNRESOLVED = "account-unresolved";

export class ProviderNotConfiguredError extends Error {
  readonly workspaceId: string;
  readonly channel: Channel;
  /** True when the ONLY problem is that we could not tell which account to use.
   *  Callers map this to different copy (and a different fix) than a genuinely
   *  disconnected channel. */
  readonly accountUnresolved: boolean;
  constructor(workspaceId: string, missing: string[], channel: Channel = "whatsapp") {
    const label = CHANNEL_DISPLAY_NAME[channel] ?? channel;
    const unresolved = missing.includes(ACCOUNT_UNRESOLVED);
    // `account-unresolved` is NOT a configuration problem, and saying it is
    // sends an admin to reconnect a perfectly healthy integration. The channel
    // is connected; what is missing is which of several accounts THIS thread
    // belongs to — normally because the account it was bound to was
    // disconnected (`onDelete: SetNull` nulls the column on every thread that
    // pointed at it). Refusing is correct: replying from a sibling number the
    // customer never contacted has no service window and shows an unknown
    // sender. But the message has to say that, and say what actually clears it.
    super(
      unresolved
        ? `This conversation isn't linked to one of your ${label} accounts, so ` +
          `there's no way to tell which one to reply from. This usually means ` +
          `the account it belonged to was disconnected. It re-links itself as ` +
          `soon as the customer sends another message; to reply right now, use ` +
          `a template from the account you want to own the thread.`
        : `${label} isn't fully connected: ${missing.join(", ")}. ` +
          `Reconnect it in /settings/${channel}.`,
    );
    this.name = "ProviderNotConfiguredError";
    this.workspaceId = workspaceId;
    this.channel = channel;
    this.accountUnresolved = unresolved;
  }
}

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v26.0";

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
  /**
   * Which ROW the access token above came from — and therefore which app
   * secret may sign for it. A token and its `appsecret_proof` secret are a
   * PAIR issued by one Meta app: a WABA-row business token (Embedded Signup)
   * is issued by the PLATFORM app, so it pairs with `META_APP_SECRET` — never
   * with the connection row's own secret, which belongs to a different app
   * and would 400 every signed call. Carried per-cipher so the pairing is
   * chosen in ONE branch at load time and can't silently cross.
   */
  tokenSource: "connection" | "waba";
  /** The app secret belonging to the SAME row as `accessTokenCipher` (see
   *  `tokenSource`). Ciphertext in cache (never plaintext) exactly like the
   *  token — see the cache header. */
  appSecretCipher?: string;
  wabaId?: string;
  wabaAccountId?: string;
  messagingAccountId?: string;
  appId?: string;
  displayPhoneNumber?: string;
}
/** Ciphertext of every ACTIVE account's own app secret on the channel. Cached as
 *  a list (not the default account's single value) so an inbound webhook signed
 *  by any of the workspace's accounts verifies. */
type WebhookConfigCipher = string[];

type CachedSend =
  | { kind: "ok"; cipher: SendConfigCipher }
  | { kind: "err"; missing: readonly string[] };
const sendCache = new TtlCache<CachedSend>();
const webhookCache = new TtlCache<WebhookConfigCipher>();

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
    if (active > 1) return { kind: "err", missing: [ACCOUNT_UNRESOLVED] };
  }
  const conn = await db.channelConnection.findFirst({
    where: accountId
      ? { id: accountId, workspaceId, channel: "whatsapp" }
      : { workspaceId, channel: "whatsapp", isDefault: true },
    select: {
      config: true,
      secrets: true,
      isActive: true,
      // The WABA is the authority on the template catalog AND — under Embedded
      // Signup — on the access token, which is issued once per (customer, WABA)
      // rather than once per phone number. Joining it here means the id we fetch
      // templates with and the FK we key template rows by come from the same
      // row, so they cannot disagree.
      wabaAccount: { select: { id: true, externalWabaId: true, secrets: true } },
    },
  });
  if (!conn || !conn.isActive) return { kind: "err", missing: ["not-connected"] };
  const config = (conn.config ?? {}) as MetaChannelConfig;
  const secrets = (conn.secrets ?? {}) as MetaChannelSecrets;
  const wabaSecrets = (conn.wabaAccount?.secrets ?? {}) as MetaChannelSecrets;
  // WABA token wins when present: an ES tenant stores ONE customer-scoped token
  // on the WABA instead of a copy per number, so rotation touches one row.
  //
  // The token and its app secret are chosen as a PAIR in this one branch —
  // see SendConfigCipher.tokenSource. Before 2026-08-13 the token could come
  // from the WABA row while the secret always came from the connection row;
  // nothing writes WhatsappBusinessAccount.secrets.accessToken until Embedded
  // Signup ships, so the cross-pairing was unreachable — this fences it
  // before it can happen silently.
  const pair = wabaSecrets.accessToken
    ? {
        accessTokenCipher: wabaSecrets.accessToken,
        tokenSource: "waba" as const,
        ...(wabaSecrets.appSecret ? { appSecretCipher: wabaSecrets.appSecret } : {}),
      }
    : secrets.accessToken
      ? {
          accessTokenCipher: secrets.accessToken,
          tokenSource: "connection" as const,
          // The account's OWN app secret (not the shared app's) — see
          // MetaSendConfig.appSecret for why that distinction is load-bearing.
          ...(secrets.appSecret ? { appSecretCipher: secrets.appSecret } : {}),
        }
      : null;
  const missing: string[] = [];
  if (!config.phoneNumberId) missing.push("phoneNumberId");
  if (!pair) missing.push("accessToken");
  if (missing.length > 0 || !pair) return { kind: "err", missing };
  return {
    kind: "ok",
    cipher: {
      phoneNumberId: config.phoneNumberId!,
      // Store the CIPHERTEXT in cache, not the decrypted token. Decrypt
      // per-call so plaintext never lives longer than the request that
      // uses it. See the cache header comment for the security rationale.
      ...pair,
      ...(conn.wabaAccount ? { wabaId: conn.wabaAccount.externalWabaId } : {}),
      ...(conn.wabaAccount ? { wabaAccountId: conn.wabaAccount.id } : {}),
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
  let appSecret: string | undefined;
  if (cipher.appSecretCipher) {
    try {
      appSecret = decryptSecret(cipher.appSecretCipher);
    } catch {
      // Swallowed on purpose — see the spread below.
      appSecret = undefined;
    }
  }
  if (!appSecret && cipher.tokenSource === "waba") {
    // A WABA-row business token (Embedded Signup) is issued by the PLATFORM
    // app, so the proof secret is META_APP_SECRET — the same env the
    // app-level webhook route verifies with. NEVER the connection row's own
    // secret: that belongs to a different Meta app, and a proof signed with
    // it 400s every call the token itself would have authorized. (First
    // entry = the current secret; later entries exist only for rotation
    // verify-windows.)
    appSecret = platformAppSecrets()[0];
  }
  return {
    phoneNumberId: cipher.phoneNumberId,
    accessToken,
    graphVersion: DEFAULT_GRAPH_VERSION,
    ...(cipher.wabaId ? { wabaId: cipher.wabaId } : {}),
    ...(cipher.wabaAccountId ? { wabaAccountId: cipher.wabaAccountId } : {}),
    ...(cipher.messagingAccountId
      ? { messagingAccountId: cipher.messagingAccountId }
      : {}),
    ...(cipher.appId ? { appId: cipher.appId } : {}),
    // Best-effort, deliberately unlike the access token above: the token is
    // fatal to decrypt-fail (a silent send-nothing is worse than a loud error),
    // but the proof is additive, so a bad app secret must degrade to "no proof"
    // rather than take the channel down.
    ...(appSecret ? { appSecret } : {}),
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
 * Every ACTIVE WhatsApp number's country, for workspace-wide capability flags.
 *
 * Business-initiated calling eligibility is a per-NUMBER fact, but some UI
 * questions are workspace-wide ("should the Call button exist at all?"). Those
 * were answered from the DEFAULT number, so a workspace whose default sits in a
 * blocked market hid the button on every thread — including threads bound to a
 * perfectly eligible second number — while the real per-thread gate
 * (`calls.service.ts`, which passes the thread's account) disagreed with no way
 * to reconcile them.
 *
 * A `null` entry means "unknown", which callers treat as "don't gate".
 */
export async function getActiveWhatsappCountries(
  workspaceId: string,
): Promise<(string | null)[]> {
  const conns = await db.channelConnection.findMany({
    where: { workspaceId, channel: "whatsapp", isActive: true },
    select: { config: true },
  });
  return conns.map((c) =>
    getCountryFromPhone(((c.config ?? {}) as MetaChannelConfig).displayPhoneNumber ?? null),
  );
}

/**
 * Loads the webhook-side config. Used by the NestJS webhook controller
 * (`POST|GET /webhooks/meta/:workspaceId`) for both the GET verify dance and
 * POST HMAC verification.
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
  let cipher = webhookCache.get(workspaceId);
  if (cipher === undefined) {
    // EVERY active account, not the default one. Meta signs with the secret of
    // whichever app owns the account the event came from, so resolving only the
    // default silently 403'd (and permanently lost) all inbound on siblings.
    const conns = await db.channelConnection.findMany({
      where: { workspaceId, channel: "whatsapp", isActive: true },
      select: { secrets: true },
    });
    cipher = conns
      .map((c) => ((c.secrets ?? {}) as MetaChannelSecrets).appSecret)
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    webhookCache.set(workspaceId, cipher);
  }

  // Decrypt each candidate SEPARATELY. One corrupt/rotated-key ciphertext must
  // not take the whole channel down — the previous single try/catch around the
  // default's decrypt returned null, meaning a healthy sibling sitting right
  // there could not verify a thing.
  const own: string[] = [];
  for (const c of cipher) {
    try {
      own.push(decryptSecret(c));
    } catch (err) {
      console.error(
        `[provider-config] skipping undecryptable whatsapp webhook secret for team=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // The shared Meta App secret is the primary signer and is enough on its own —
  // it must be consulted even when NO account carries its own secret, which the
  // old `cipher === null` early-return skipped entirely.
  const meta = await getMetaConnection(workspaceId);
  return resolveWebhookSecretCandidates(meta?.appSecret, own);
}
