import { createHmac, randomBytes } from "node:crypto";

/**
 * Outbound webhook wire-schema version. Stamped BOTH in the JSON body (as `v`)
 * and the `X-CCP-Webhook-Version` header so a future v2 envelope can ship
 * without silently breaking partners that parse v1. Bump ONLY on a breaking
 * body-shape change; additive fields stay v1.
 */
export const WEBHOOK_WIRE_VERSION = 1;

/**
 * Signing for outbound webhook deliveries — symmetric HMAC-SHA256 over the
 * raw JSON body. Receivers verify by recomputing the digest with the
 * shared secret and comparing in constant time.
 *
 * Wire format on the header:
 *   X-CCP-Signature: t=<unix-seconds>,v1=<hex>
 *
 * The timestamp inside the header prevents trivial replay attacks — a
 * vigilant receiver can reject deliveries older than ~5 minutes.
 *
 * The body the digest covers is the EXACT bytes we POST — never an
 * un-stringified object the receiver re-serializes (subtle whitespace
 * differences break signature equality).
 */
export function signWebhookBody(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signed = `${timestamp}.${body}`;
  const digest = createHmac("sha256", secret).update(signed).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

/**
 * Generate a fresh shared secret for a new webhook. 32 bytes is the
 * upper bound HMAC-SHA256 benefits from; more buys no real security.
 *
 * Prefix matches our `TeamApiKey` convention (`ccp_`) so partner code can
 * pattern-match: if it starts with `ccp_whsec_`, it's a webhook secret.
 */
export function generateWebhookSecret(): string {
  return `ccp_whsec_${randomBytes(24).toString("base64url")}`;
}
