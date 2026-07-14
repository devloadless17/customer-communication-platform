import { createHmac } from "node:crypto";

/**
 * Meta's `appsecret_proof` — an extra layer that binds a Graph API call to
 * knowledge of the app secret, so a leaked/exfiltrated access token can't be
 * replayed from anywhere. Meta's documented formula is the HMAC-SHA256 of the
 * ACCESS TOKEN keyed by the APP SECRET, hex-encoded, sent as `appsecret_proof`.
 *
 * CRITICAL: the app secret must belong to the app that ISSUED the token. Each
 * channel stores the secret of the app it was onboarded with (WhatsApp/Messenger
 * = the shared Meta app; Instagram may be a DIFFERENT app), so callers pass the
 * CHANNEL'S OWN app secret, not the shared one.
 *
 * Additive + backwards-safe: Meta accepts a correct proof whether or not the
 * app's "Require App Secret" setting is on. Gated OFF by default (opt in with
 * META_APPSECRET_PROOF=1) — turn it on TOGETHER with the Meta app's "Require App
 * Secret" and confirm with one live send, since the local Graph mock can't
 * validate the proof. Off by default means shipping this is zero-risk: no proof
 * is appended until you opt in.
 */
const ENABLED = process.env.META_APPSECRET_PROOF === "1";

export function appsecretProofEnabled(): boolean {
  return ENABLED;
}

export function appsecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

/**
 * Append `appsecret_proof` to a Graph URL. No-op when disabled or when the app
 * secret / token is missing (never breaks a call by half-applying).
 */
export function withAppsecretProof(
  url: string,
  accessToken: string | undefined,
  appSecret: string | undefined,
): string {
  if (!ENABLED || !accessToken || !appSecret) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}appsecret_proof=${appsecretProof(accessToken, appSecret)}`;
}
