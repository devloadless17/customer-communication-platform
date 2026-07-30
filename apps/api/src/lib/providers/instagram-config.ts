import { decryptSecret } from "@/lib/crypto/envelope";
import { db } from "@/lib/db";
import { ProviderNotConfiguredError, ACCOUNT_UNRESOLVED } from "@/lib/providers/config";
import { TtlCache } from "@/lib/providers/config-cache";
import { INBOX_SOURCES, type InboxSource } from "@ccp/shared/providers/capabilities";

/** Shared immutable empty set — the default answer, allocated once. */
const EMPTY_SOURCES: ReadonlySet<InboxSource> = new Set<InboxSource>();
import {
  getMetaConnection,
  resolveWebhookSecretCandidates,
} from "@/lib/providers/meta-connection";

/**
 * Per-team Instagram DM config. Same credential model as WhatsApp / Messenger
 * (a `ChannelConnection` row keyed (workspaceId, "instagram"); `config` non-secret,
 * `secrets` envelope-encrypted).
 *
 * Identity is the Instagram professional-account id (`igId`) — the value Meta
 * puts in `entry[].id` on an `object:"instagram"` webhook, and therefore the row's
 * `externalAccountId`. It is NOT self-sufficient: Instagram-via-Facebook-Login
 * rides the LINKED PAGE for both sending and webhook subscription, so `pageId` is
 * required too and `igAccessToken` holds a PAGE access token. (An older note here
 * said "no phone / no Page / no WABA"; the Page half of that has been false since
 * onboarding started deriving the account from the Page.) No phone, no WABA.
 *
 * The Meta app secret verifies the inbound webhook HMAC. "cache ciphertext,
 * decrypt on demand" posture — decrypted tokens never outlive the request.
 */

interface InstagramChannelConfig {
  igId?: string;
  igUsername?: string;
  /** The Facebook Page the IG account is linked to — the SEND target host. */
  pageId?: string;
  appId?: string;
  verifyToken?: string;
  /**
   * Which NON-DM sources this account lets into the inbox. Absent or empty =
   * direct messages only, which is the default and the product's core. See
   * {@link getInstagramInboxSources}.
   */
  inboxSources?: InboxSource[];
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
  /** This channel's app secret, for appsecret_proof on Graph calls. */
  appSecret?: string;
  /**
   * The Meta app this account is connected through. Not needed to SEND — it is
   * here because `/{page-id}/subscribed_apps` lists every app on the Page, so
   * reading "are we subscribed" requires knowing which node is ours. Optional:
   * rows stored before the id was captured have none.
   */
  appId?: string;
}

export interface InstagramWebhookConfig {
  /** First candidate to try — the shared Meta App secret when one is set. */
  appSecret: string;
  /** Every OTHER candidate: each active account's own stored secret. A SET, not
   *  one value — see `resolveWebhookSecretCandidates` for why. */
  appSecretFallbacks: string[];
}

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v26.0";

interface SendCipher {
  igId: string;
  pageId: string;
  /** Not a secret — cached alongside them so the subscription check needs no
   *  second read. See InstagramSendConfig.appId. */
  appId?: string;
  igAccessTokenCipher: string;
  /** This channel's OWN app secret cipher — for appsecret_proof (IG may be a
   *  DIFFERENT app than the shared one). Optional: proof skipped if absent. */
  appSecretCipher?: string;
}
/** Ciphertext of every ACTIVE account's own app secret. A list, not the default
 *  account's single value — an inbound signed by any of them must verify. */
type WebhookCipher = string[];

type CachedSend =
  | { kind: "ok"; cipher: SendCipher }
  | { kind: "err"; missing: readonly string[] };

// TTL/cap/sweep mechanics live in the shared TtlCache primitive (config-cache.ts).
const sendCache = new TtlCache<CachedSend>();
const webhookCache = new TtlCache<WebhookCipher>();
/** (workspace, account) → which non-DM sources it lets into the inbox. */
const inboxSourcesCache = new TtlCache<InboxSource[]>();

/**
 * Which NON-DM sources this Instagram account lets into the inbox.
 *
 * **Empty by default.** Direct messages are the core and are never gated — they
 * are why the channel was connected. Everything else is different work with
 * different reply rules and different volume, so an admin opts in per account (a
 * workspace can want comments on its support handle and not on its brand one).
 *
 * It has to live HERE rather than being left to the Meta dashboard. The
 * `comments` webhook is subscribed at the APP level, and one Meta app serves
 * every workspace on the shared connection — so unsubscribing there to satisfy
 * one admin would take comments away from every other workspace on that app. The
 * dashboard controls whether Meta SENDS them; this controls whether we FILE them.
 *
 * No account means no answer, and the answer is NONE. This preference is per
 * HANDLE, so resolving it from whichever row happens to be the workspace default
 * would file one handle's comments under another's wishes — the same class of
 * mistake as resolving inbound HMAC from the default account. Refusing is the
 * safe direction: the cost is a comment we don't file, not one filed against an
 * admin's explicit choice. (Unreachable on the live path anyway: a comment
 * carries `entry[].id`, so grouping always hands us a resolved connection.)
 *
 * Stored in `ChannelConnection.config` (no migration) and cached on the same TTL
 * as the other per-account reads, because it is consulted on the inbound path.
 */
export async function getInstagramInboxSources(
  workspaceId: string,
  accountId: string | null | undefined,
): Promise<ReadonlySet<InboxSource>> {
  if (!accountId) return EMPTY_SOURCES;
  const key = sendKey(workspaceId, accountId);
  const hit = inboxSourcesCache.get(key);
  if (hit !== undefined) return new Set(hit);
  const conn = await db.channelConnection.findFirst({
    where: { id: accountId, workspaceId, channel: "instagram" },
    select: { config: true },
  });
  const raw = ((conn?.config ?? {}) as InstagramChannelConfig).inboxSources;
  // Filter against the known list rather than trusting stored JSON: a value
  // written by an older build (or by hand) must not become an unknown source
  // that silently matches nothing downstream.
  const sources = Array.isArray(raw)
    ? raw.filter((v): v is InboxSource => (INBOX_SOURCES as readonly string[]).includes(v))
    : [];
  inboxSourcesCache.set(key, sources);
  return new Set(sources);
}

/** Cache key for one (workspace, account) pair. */
function sendKey(workspaceId: string, accountId?: string | null): string {
  return `${workspaceId}::${accountId ?? "default"}`;
}

/** Drop cached Instagram credentials + preferences for a team. Call after a save. */
export function invalidateInstagramConfig(workspaceId: string): void {
  sendCache.deletePrefix(`${workspaceId}::`);
  inboxSourcesCache.deletePrefix(`${workspaceId}::`);
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
    // account is `onDelete: SetNull` fallout from a disconnected handle, and
    // resolving it to the default would reply from a Page/handle the customer
    // never messaged. Unambiguous with one active account; refused with
    // several, and self-healing because ingest re-stamps on the next inbound.
    const active = await db.channelConnection.count({
      where: { workspaceId, channel: "instagram", isActive: true },
    });
    if (active > 1) return { kind: "err", missing: [ACCOUNT_UNRESOLVED] };
  }
  const conn = await db.channelConnection.findFirst({
    where: accountId
      ? { id: accountId, workspaceId, channel: "instagram" }
      : { workspaceId, channel: "instagram", isDefault: true },
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
      ...(config.appId ? { appId: config.appId } : {}),
      igAccessTokenCipher: secrets.igAccessToken!,
      ...(secrets.appSecret ? { appSecretCipher: secrets.appSecret } : {}),
    },
  };
}

function materialize(workspaceId: string, cipher: SendCipher): InstagramSendConfig {
  let igAccessToken: string;
  try {
    igAccessToken = decryptSecret(cipher.igAccessTokenCipher);
  } catch (err) {
    console.error(
      `[instagram-config] failed to decrypt send secrets for team=${workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw new ProviderNotConfiguredError(workspaceId, ["igAccessToken (decrypt failed)"], "instagram");
  }
  // App secret for appsecret_proof — best-effort; a decrypt failure must not
  // break sending (the proof is additive).
  let appSecret: string | undefined;
  if (cipher.appSecretCipher) {
    try {
      appSecret = decryptSecret(cipher.appSecretCipher);
    } catch {
      appSecret = undefined;
    }
  }
  return {
    igId: cipher.igId,
    pageId: cipher.pageId,
    igAccessToken,
    graphVersion: DEFAULT_GRAPH_VERSION,
    ...(appSecret ? { appSecret } : {}),
    ...(cipher.appId ? { appId: cipher.appId } : {}),
  };
}

/** Send-side Instagram config. Throws ProviderNotConfigured when unconnected. */
export async function getInstagramSendConfig(
  workspaceId: string,
  accountId?: string | null,
): Promise<InstagramSendConfig> {
  const key = sendKey(workspaceId, accountId);
  const hit = sendCache.get(key);
  if (hit) {
    if (hit.kind === "err") {
      throw new ProviderNotConfiguredError(workspaceId, [...hit.missing], "instagram");
    }
    return materialize(workspaceId, hit.cipher);
  }
  const entry = await loadSendCipher(workspaceId, accountId);
  sendCache.set(key, entry);
  if (entry.kind === "err") throw new ProviderNotConfiguredError(workspaceId, [...entry.missing], "instagram");
  return materialize(workspaceId, entry.cipher);
}

/** Webhook-side Instagram config (GET verify + POST HMAC). Null when unconfigured. */
export async function getInstagramWebhookConfig(
  workspaceId: string,
): Promise<InstagramWebhookConfig | null> {
  let cipher = webhookCache.get(workspaceId);
  if (cipher === undefined) {
    // EVERY active account, not the default one — see getMetaWebhookConfig.
    const conns = await db.channelConnection.findMany({
      where: { workspaceId, channel: "instagram", isActive: true },
      select: { secrets: true },
    });
    cipher = conns
      .map((c) => ((c.secrets ?? {}) as InstagramChannelSecrets).appSecret)
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    webhookCache.set(workspaceId, cipher);
  }

  // Per-candidate decrypt: one corrupt ciphertext must not silence the channel.
  const own: string[] = [];
  for (const c of cipher) {
    try {
      own.push(decryptSecret(c));
    } catch (err) {
      console.error(
        `[instagram-config] skipping undecryptable webhook secret for team=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Prefer the shared Meta App secret (single source — rotation there applies to
  // every channel at once); each account's own secret covers an account on a
  // different Meta app, and legacy / pre-Meta-App rows.
  const meta = await getMetaConnection(workspaceId);
  return resolveWebhookSecretCandidates(meta?.appSecret, own);
}
