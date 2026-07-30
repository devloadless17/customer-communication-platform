/**
 * Which Meta app is an account actually on?
 *
 * Meta's model is one app ↔ many accounts: a single Meta app can serve every
 * WhatsApp number, Page and Instagram account a workspace connects. This product
 * therefore keeps ONE shared app config per workspace (`MetaConnection`) whose
 * credentials are copied onto each `ChannelConnection` as it is connected — but an
 * account may instead carry credentials from a DIFFERENT app, which is how a
 * workspace onboards an asset that lives under someone else's Meta app.
 *
 * The distinction is not cosmetic, and it already drives real behaviour: a shared
 * secret rotation must carry through to the accounts on the shared app and must
 * NOT touch the ones on their own, because overwriting those would leave Meta
 * signing their webhooks with a secret we no longer hold — dropping every inbound
 * for that account as forged.
 *
 * There is no `appId`-based test available: the shared app's `appId` is optional
 * and an account may never have been given one, whereas the secret is what every
 * account must have to work at all. So the SECRET is the identity, and this is the
 * one definition of the comparison — `resyncChannels` (deciding what a rotation
 * touches) and the settings UI (telling an admin which app each account is on)
 * both call it, so the answer an admin reads can never disagree with the answer
 * the rotation acts on.
 *
 * Pure and secret-safe: it compares two plaintext secrets and returns a label.
 * Neither value is returned, logged, or otherwise escapes.
 */

export type MetaAppBinding =
  /** Uses the workspace's shared Meta app — a rotation there reaches this account. */
  | "shared_app"
  /** Carries credentials from a different Meta app; the shared app doesn't apply. */
  | "own_app"
  /** No stored secret at all — nothing to compare, and nothing signing its webhooks. */
  | "unset";

/**
 * ⚠️ EMBEDDED SIGNUP TRIGGER — read this before wiring ES up.
 *
 * Everything below assumes the BYO-app model: the workspace pastes a Meta app, and
 * each account stores a copy of that app's secret. Under Embedded Signup that
 * inverts. Meta's docs are explicit that a Tech Provider has exactly ONE app — its
 * own ("your app ID… your app secret" for the code exchange) — and that "all
 * webhooks for all of your onboarded business customers will be sent to your app's
 * callback URL". So for an ES-onboarded account:
 *
 *   - the signing secret is the PLATFORM app's (`META_APP_SECRET` in env, already
 *     used by the app-level webhook route), NOT a value on the row;
 *   - the per-customer credential is the customer-scoped BUSINESS token, which we
 *     already store on `WhatsappBusinessAccount.secrets.accessToken` — the right
 *     granularity, since Meta scopes that token to the onboarded client;
 *   - there is no system-user token at all ("Tech Providers… should use business
 *     tokens exclusively").
 *
 * An ES account therefore has NO own `appSecret`, and this function would call it
 * `unset` — which the settings UI renders as the warning "No Meta app credentials".
 * That would be a false alarm on the happy path, on every ES account.
 *
 * The fix when ES lands is a fourth value, `platform_app`, chosen BEFORE the
 * unset check for any account onboarded via ES (the discriminator already exists:
 * `WhatsappPortfolio.source === "embedded_signup"`). Deliberately not built now —
 * nothing can produce such a row yet, so the branch would be untestable.
 */

/**
 * @param ownAppSecret   the account's own decrypted `secrets.appSecret`, or null
 * @param sharedAppSecret the workspace's shared Meta app secret, or null. Pass the
 *   PREVIOUS shared secret when classifying across a rotation — by the time the new
 *   one is stored, comparing against it would call every account "own app".
 */
export function classifyMetaAppBinding(
  ownAppSecret: string | null,
  sharedAppSecret: string | null,
): MetaAppBinding {
  if (!ownAppSecret) return "unset";
  // No shared app configured, yet this account has a secret — it can only have
  // come from its own app.
  if (!sharedAppSecret) return "own_app";
  return ownAppSecret === sharedAppSecret ? "shared_app" : "own_app";
}
