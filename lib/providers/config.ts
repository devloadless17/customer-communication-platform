import "server-only";

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
 * Loads the send-side Meta config for a team. Throws ProviderNotConfigured
 * if the admin hasn't pasted credentials yet — surface this to the agent so
 * the reply box can render an "connect WhatsApp" prompt instead of pretending
 * the send went through.
 */
export async function getMetaSendConfig(teamId: string): Promise<MetaSendConfig> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { metaPhoneNumberId: true, metaAccessToken: true },
  });
  if (!team) throw new ProviderNotConfiguredError(teamId, ["team-not-found"]);
  const missing: string[] = [];
  if (!team.metaPhoneNumberId) missing.push("phoneNumberId");
  if (!team.metaAccessToken) missing.push("accessToken");
  if (missing.length > 0) throw new ProviderNotConfiguredError(teamId, missing);
  return {
    phoneNumberId: team.metaPhoneNumberId!,
    accessToken: team.metaAccessToken!,
    graphVersion: DEFAULT_GRAPH_VERSION,
  };
}

/**
 * Loads the webhook-side config. Used by /api/webhooks/meta/[teamId] for
 * both the GET verify dance and POST HMAC verification.
 */
export async function getMetaWebhookConfig(
  teamId: string,
): Promise<MetaWebhookConfig | null> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { metaAppSecret: true, metaVerifyToken: true },
  });
  if (!team || !team.metaAppSecret || !team.metaVerifyToken) return null;
  return {
    appSecret: team.metaAppSecret,
    verifyToken: team.metaVerifyToken,
  };
}
