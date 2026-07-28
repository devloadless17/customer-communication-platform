# Onboarding — future direction (WhatsApp Embedded Signup)

> Read this before re-opening the onboarding question. Today's flow is the
> polished manual paste (see `apps/web/src/app/(app)/settings/whatsapp/whatsapp-settings.tsx`
> — 3 visible fields + advanced disclosure). This doc captures the canonical
> SaaS answer that we deferred until the pilot is happy.

## Why it's paused

The proper fix is **WhatsApp Embedded Signup** — customer clicks "Connect with
Facebook", does a scoped Facebook Login flow, picks/creates a WABA + phone
number, and Meta returns a short-lived auth code we exchange for a long-lived
System User token. No credential pasting. No Meta-dashboard configuration on
the customer side.

The blocker is **Meta Tech Provider gating**. To launch Embedded Signup we need:

- Business verification (Meta Business Manager — typically 2–5 business days,
  can stretch to weeks)
- 2FA enabled on the business account
- App Review approval for `whatsapp_business_messaging` +
  `whatsapp_business_management` scopes
- Tech Provider Access Verification

Realistic timeline: **4–8 weeks of waiting on Meta**, plus ~2–3 weeks of dev once
approval lands. The dev work is mostly OAuth plumbing — straightforward, but
gated behind that wait.

The UI placeholder already exists at
[whatsapp-settings.tsx](../apps/web/src/app/(app)/settings/whatsapp/whatsapp-settings.tsx)
(the "Coming soon" `embeddedSignupCard`). That's where the activation drops in.

## Schema delta when Embedded Signup ships

### Move to env (app-wide, not per-team)

| Today (per-team column) | Tomorrow (env) |
|---|---|
| `Team.metaAppId` | `META_APP_ID` |
| `Team.metaAppSecret` | `META_APP_SECRET` |

Embedded Signup uses **our** Meta app's credentials on behalf of every
customer's WABA. There's exactly one Loadless Meta app; pasting different
`app_id` / `app_secret` per team becomes meaningless.

### Per-team store collapses to 3 fields

| Today | Tomorrow |
|---|---|
| `metaPhoneNumberId` | `metaPhoneNumberId` (unchanged — comes from the OAuth response) |
| `metaWabaId` | `metaWabaId` (unchanged — comes from the OAuth response) |
| `metaAccessToken` | `metaSystemUserToken` (long-lived System User token) |
| `metaAppSecret` | — *(removed; env)* |
| `metaAppId` | — *(removed; env)* |
| `metaVerifyToken` | — *(removed; `/subscribed_apps` auto-subscribes the webhook, no handshake)* |
| `metaDisplayPhoneNumber` | `metaDisplayPhoneNumber` (unchanged) |

All three remaining per-team values get populated **atomically** from the OAuth
callback, not pasted by the admin.

### Migration strategy

Keep the existing columns through a transition window. The manual-paste path
stays as a fallback (some customers may not want to OAuth into our app, or may
be running on a different Meta business than the one their WhatsApp lives on).
Both paths read through
[apps/api/src/lib/providers/config.ts](../apps/api/src/lib/providers/config.ts),
which already abstracts column access via `getMetaSendConfig(teamId)` /
`getMetaWebhookConfig(teamId)` — only those readers need updating to prefer the
new columns when present and fall back to the legacy columns otherwise.

## What's preserved (zero rework)

- **Webhook URL shape**: `{origin}/webhooks/meta/{teamId}` — Embedded Signup
  subscribes via `POST /{waba-id}/subscribed_apps`, which calls **the same URL
  pattern** we already serve. No subscriber re-configuration.
- **`MessagingProvider` interface** — `MetaProvider` in
  [apps/api/src/lib/providers/meta.ts](../apps/api/src/lib/providers/meta.ts)
  reads from the config object returned by `getMetaSendConfig`. Swap the
  config columns; provider code is untouched.
- **HMAC verification** ([apps/api/src/webhooks/meta/meta.controller.ts](../apps/api/src/webhooks/meta/meta.controller.ts))
  — app secret moves to env; the verification logic stays identical.
- **Envelope encryption** — `metaSystemUserToken` is encrypted with the same
  `ENCRYPTION_KEY` envelope as today's access token.

## Templates, broadcasts, calling — all keep working

| Feature | Today's requirement | Embedded Signup |
|---|---|---|
| Send text/media | phoneNumberId + accessToken | phoneNumberId + systemUserToken |
| Mark read | phoneNumberId + accessToken | phoneNumberId + systemUserToken |
| Templates (list/create/delete) | wabaId + accessToken | wabaId + systemUserToken |
| Template header media upload | wabaId + appId + accessToken | wabaId + `META_APP_ID` + systemUserToken |
| Broadcasts | (same as send) | (same as send) |
| WhatsApp Business Calling API (post-launch) | phoneNumberId + accessToken | phoneNumberId + systemUserToken |

One token, three per-team values, one webhook URL — covers everything we
currently ship + the calling path.

## Implementation pointers

When you come back to build this:

1. **Meta JS SDK** — drop their script + call `FB.login({ scope:
   'whatsapp_business_messaging,whatsapp_business_management', extras: { ... } })`.
   The `extras` object configures the embedded experience (pre-fill business
   name, default settings). Returns `{ authResponse: { code } }`.
2. **Backend exchange** — `POST https://graph.facebook.com/v25.0/oauth/access_token`
   with `client_id` + `client_secret` (our app's, from env) + `code` →
   short-lived user token. Then `POST .../oauth/access_token` again with the
   short-lived token → long-lived System User token (~60 day rolling).
3. **Webhook subscription** — `POST /{waba-id}/subscribed_apps` with the
   System User token. Subscribes our app to the customer's WABA, pointing at
   the same `/webhooks/meta/{teamId}` URL we already use.
4. **Phone registration** — `POST /{phone-number-id}/register` (the Cloud API
   register call), pin chosen by the customer during the JS SDK flow.
5. **Activation point in UI** — wire up the existing `embeddedSignupCard` in
   [whatsapp-settings.tsx](../apps/web/src/app/(app)/settings/whatsapp/whatsapp-settings.tsx).
   Remove the `disabled` attribute, swap "Coming soon" for "Connect with
   Facebook", and bind the click to the FB.login flow.
6. **Disconnect hygiene** — extend
   [apps/api/src/workspace-settings/whatsapp/whatsapp.service.ts](../apps/api/src/workspace-settings/whatsapp/whatsapp.service.ts)
   `disconnect` to revoke the System User token via Graph API
   (`DELETE /{user-id}/permissions`) when present.

## Fallback if Tech Provider review stalls indefinitely

If Meta won't approve us for Tech Provider status (rare but possible for solo
shops with limited business history), the next-best option is **partnering
with a Business Service Provider** — 360Dialog, Infobip, Twilio, etc. They're
already approved Tech Providers and expose their own Embedded Signup we can
embed. Cost: ~$0.01–0.05/message margin + ~$50–200/month subscription.
Disadvantage: vendor lock-in and margin compression. Only pull this lever
if Meta says no twice.
