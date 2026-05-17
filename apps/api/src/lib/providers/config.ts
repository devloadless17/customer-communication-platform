import "server-only";

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
 * Single-process only by design (CLAUDE.md: one VPS, one app instance). The
 * day a second instance shows up this moves to Redis alongside the Socket.io
 * adapter — until then a Map is correct and simpler.
 */
const CONFIG_TTL_MS = 60_000;

type CachedSend = { value: MetaSendConfig } | { error: ProviderNotConfiguredError };
const sendCache = new Map<string, { entry: CachedSend; exp: number }>();
const webhookCache = new Map<string, { value: MetaWebhookConfig | null; exp: number }>();

/** Drop cached credentials for a team. Call after the settings page writes. */
export function invalidateProviderConfig(teamId: string): void {
  sendCache.delete(teamId);
  webhookCache.delete(teamId);
}

async function loadMetaSendConfig(teamId: string): Promise<MetaSendConfig> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: {
      metaPhoneNumberId: true,
      metaAccessToken: true,
      metaWabaId: true,
      metaAppId: true,
    },
  });
  if (!team) throw new ProviderNotConfiguredError(teamId, ["team-not-found"]);
  const missing: string[] = [];
  if (!team.metaPhoneNumberId) missing.push("phoneNumberId");
  if (!team.metaAccessToken) missing.push("accessToken");
  if (missing.length > 0) throw new ProviderNotConfiguredError(teamId, missing);
  let accessToken: string;
  try {
    // Stored as envelope-encrypted ciphertext (lib/crypto/envelope.ts).
    // decryptSecret() passes legacy plaintext rows through unchanged so the
    // first load after rollout still works; the next credential save in
    // /api/team/whatsapp rewrites the row as ciphertext.
    accessToken = decryptSecret(team.metaAccessToken!);
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
    phoneNumberId: team.metaPhoneNumberId!,
    accessToken,
    graphVersion: DEFAULT_GRAPH_VERSION,
    ...(team.metaWabaId ? { wabaId: team.metaWabaId } : {}),
    ...(team.metaAppId ? { appId: team.metaAppId } : {}),
  };
}

/**
 * Loads the send-side Meta config for a team. Throws ProviderNotConfigured
 * if the admin hasn't pasted credentials yet — surface this to the agent so
 * the reply box can render an "connect WhatsApp" prompt instead of pretending
 * the send went through. The not-configured result is cached too (a team that
 * hasn't connected gets hammered with read/mark-read attempts on stale rows).
 */
export async function getMetaSendConfig(teamId: string): Promise<MetaSendConfig> {
  const hit = sendCache.get(teamId);
  if (hit && hit.exp > Date.now()) {
    if ("error" in hit.entry) throw hit.entry.error;
    return hit.entry.value;
  }
  try {
    const value = await loadMetaSendConfig(teamId);
    sendCache.set(teamId, { entry: { value }, exp: Date.now() + CONFIG_TTL_MS });
    return value;
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      sendCache.set(teamId, { entry: { error: err }, exp: Date.now() + CONFIG_TTL_MS });
    }
    throw err;
  }
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
 */
export async function getMetaWebhookConfig(
  teamId: string,
): Promise<MetaWebhookConfig | null> {
  const hit = webhookCache.get(teamId);
  if (hit && hit.exp > Date.now()) return hit.value;
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { metaAppSecret: true, metaVerifyToken: true },
  });
  let value: MetaWebhookConfig | null;
  if (!team || !team.metaAppSecret || !team.metaVerifyToken) {
    value = null;
  } else {
    try {
      // App secret signs every inbound webhook (HMAC-SHA256). Stored
      // encrypted; legacy plaintext rows decrypt through unchanged.
      value = {
        appSecret: decryptSecret(team.metaAppSecret),
        verifyToken: team.metaVerifyToken,
      };
    } catch (err) {
      console.error(
        `[provider-config] failed to decrypt webhook secrets for team=${teamId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      value = null;
    }
  }
  webhookCache.set(teamId, { value, exp: Date.now() + CONFIG_TTL_MS });
  return value;
}
