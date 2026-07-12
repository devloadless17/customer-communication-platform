# Meta manual onboarding — every key, where it comes from

This is the field-by-field reference for connecting a team's **WhatsApp + Messenger + Instagram** by hand, until Embedded Signup automates it. All three run on **one Meta app**, **one app secret**, and (for Messenger/Instagram) **Page access tokens** — see [adding-a-channel.md → "The Meta host decision"](adding-a-channel.md).

## The working setup (what "good" looks like) — verified 2026-07-08

All three Meta channels are two-way through **one** Meta app (`graph.facebook.com`, Facebook-Login path):

| | Host | Send endpoint | Token type | Identity |
|---|---|---|---|---|
| **WhatsApp** | graph.facebook.com | `/{phoneNumberId}/messages` | system-user token (WABA scopes) | phone number |
| **Messenger** | graph.facebook.com | `/{PAGE_ID}/messages` (recipient PSID) | **Page** token (`EAA…`) | Facebook Page |
| **Instagram** | graph.facebook.com | `/{PAGE_ID}/messages` (recipient IGSID) | **Page** token (`EAA…`) | IG account **linked to that Page** |

The three non-negotiables that make it work:
1. **One app + one app secret** across all three (webhook HMAC uses it). Never the standalone "Instagram" app's separate id/secret.
2. **Page access tokens** (`EAA…`, derived from the system-user token) for Messenger **and** Instagram — because the Page is on the **New Pages Experience**.
3. **Both social channels send via `/{PAGE_ID}/messages`** — the recipient id (PSID vs IGSID) routes it to the right platform. Instagram does **not** use `/{igId}/messages` here.

Inbound is HMAC-verified and channel-agnostic; outbound uses the stored Page token. Our onboarding **auto-derives** the Page token from whatever you paste (`GET /{pageId}?fields=access_token`).

## The golden rules (learned the hard way)

1. **One app for everything.** Use the *main* app (its App ID + App secret) for all three channels — never the standalone "Instagram" app's separate id/secret. Webhook HMAC uses this one app secret.
2. **Page access tokens, not user/system-user tokens.** The Loadless Page is on Meta's **"New Pages Experience"**, which rejects user/system-user tokens on Page calls (`code 190 subcode 2069032` / `#210 "A page access token is required"`). Messenger **and** Instagram send through the Page, so both need an **`EAA…` Page token** — *not* an `IGAA…` Instagram-Login token (those only work on `graph.instagram.com`, which we don't use).
3. **Our onboarding auto-derives the Page token** from whatever you paste (`GET /{pageId}?fields=access_token`). If you paste a system-user token, we exchange it. If the derive is blocked, paste the `EAA…` Page token directly.
4. **App secret** verifies inbound webhook HMAC. **Verify token** is echoed on Meta's callback check — our settings page pre-mints one; paste it into Meta.
5. **Dev mode:** while the app is Unpublished, only app **testers/admins** can message you (Instagram: accept the invite *in the Instagram app*; Facebook: accept on *developers.facebook.com*). App Review lifts this for real customers.

## Where to get a Page access token

Derive it from your system-user token (non-expiring if the system user is):
```bash
curl "https://graph.facebook.com/v25.0/{PAGE_ID}?fields=access_token&access_token={SYSTEM_USER_TOKEN}"
```
The `access_token` in the response is the `EAA…` Page token. (Or: Business Settings → Pages → the Page → generate token; or the use-case "add a Page" flow.)

**Self-test any token before pasting** (this is exactly what our connect form validates):
```bash
# Messenger / the Page
curl "https://graph.facebook.com/v25.0/{PAGE_ID}?fields=name,access_token&access_token={TOKEN}"
# Send test (proves the token can actually message)
curl -X POST "https://graph.facebook.com/v25.0/{PAGE_ID}/messages?access_token={PAGE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"recipient":{"id":"{PSID}"},"messaging_type":"RESPONSE","message":{"text":"test"}}'
```

## WhatsApp

| Field | Where |
|---|---|
| Phone Number ID | App → WhatsApp → API Setup (or WhatsApp Manager → phone number) |
| WABA ID | Same API Setup screen / Business Settings → WhatsApp Accounts |
| Access token | System-user token with `whatsapp_business_messaging` + `whatsapp_business_management` |
| App secret | App Settings → Basic → App secret (Show) |
| Verify token | Pre-minted on our WhatsApp settings page — paste into App → WhatsApp → Configuration → Webhooks |

## Messenger

| Field | Where |
|---|---|
| **Page ID** | Business Settings → Accounts → **Pages** → Loadless (id under the name) — or `GET /me/accounts` |
| **Page access token** (`EAA…`) | Derived (paste system-user token, we exchange) or the self-test curl above |
| **App secret** | Main app → App Settings → Basic (same as WhatsApp/Instagram) |
| **App ID** (optional) | Same screen — informational |
| Verify token / callback URL | Pre-minted on our Messenger settings page → paste into App → **Messenger → Webhooks**, subscribe **`messages`**. The **Page subscription is now automatic**: saving the connection posts the union of every field our parser reads (`meta-page-subscription.ts`), and the settings page warns if `messages` is still missing. |

## Instagram (Business account **linked to the Page**)

| Field | Where |
|---|---|
| **Facebook Page ID** | The Loadless Page the Instagram is linked to (same as Messenger) — we derive the Instagram business-account id **from** it |
| **Access token** (`EAA…` **Page** token) | **Same Page token as Messenger** — Instagram-via-Facebook-Login sends through the Page. **Not** an `IGAA…` token |
| **App secret** | Main app secret |
| **App ID** (optional) | Main app id |
| Verify token / callback URL | Pre-minted → paste into the Instagram webhook config, subscribe **`messages`** |

Prereqs: the Instagram account is **Business/Creator**, **linked to the Loadless Page**, and (dev mode) the sender is an accepted **Instagram Tester**.

## Troubleshooting — every error we hit and the fix

Ordered roughly by where it bites in setup. The **token prefix tells you the type**: `EAA…` = Facebook token (user / system-user / **Page**); `IGAA…` = Instagram-Login token (only works on `graph.instagram.com` — never use here). A system-user `EAA…` and a Page `EAA…` look alike but are different tokens — the Page one is what sends.

| Symptom / Meta error | Cause | Fix |
|---|---|---|
| Meta: **"The callback URL or verify token couldn't be validated"** (GET verify → 403) | Our verifier used to require the connection be active + have an app secret before honoring the token | Fixed in code (`getTeamVerifyTokens` honors any stored verify token). Just make sure the token pasted into Meta matches the one on our settings page. |
| **Inbound webhooks all 403** (POST) | HMAC mismatch — the app secret stored ≠ the app that signs the webhook (e.g. main-app secret stored but webhook wired under the standalone `-IG` app) | Wire everything under the **one main app** and store **its** app secret. |
| Inbound arrives but only **`message_edit` / `read`** events (no `message`, no `sender`) | **Development mode**: the person messaging you isn't an accepted app **tester** | Add them as a tester and **accept the invite** — Instagram: in the IG app → Settings → Apps and websites → Tester invites. Facebook: on **developers.facebook.com** (not facebook.com). |
| No inbound at all for a channel — **and the other Meta channels still work** | The **Page isn't subscribed** to the app for `messages`. WhatsApp and Instagram subscribe separately, so only Messenger goes silent. Hit live on 2026-07-10: `subscribed_fields: ["name"]` — Meta had been sending **zero** `object:"page"` webhooks for days, and nothing in the app was dropping them. | **Press Edit → Save on the channel's settings page** — connecting now (re-)asserts the subscription (`ensurePageSubscribedToMessaging`), and the page shows a red banner whenever `messages` is missing. Manually: `POST /{pageId}/subscribed_apps?subscribed_fields=…&access_token=PAGE_TOKEN`. Verify with `GET /{pageId}/subscribed_apps`. |
| Messenger silently stops receiving right after you connect **Instagram** (or vice-versa) | `POST subscribed_apps` **REPLACES** the field set, and both channels share ONE Page — so posting only one channel's fields unsubscribes the other | We always GET the current set and POST the **union** (`meta-page-subscription.ts`). Never post a bare field list for a Page by hand. |
| **"Invalid OAuth access token — Cannot parse access token"** (190) | An **`IGAA…`** Instagram-Login token was used on `graph.facebook.com` | Use the **`EAA…` Page** token. |
| **"User access token is not supported… a Page access token is required for the new Pages experience"** (190 / subcode 2069032) or **"(#210) A page access token is required"** | Used a **system-user** token on a Page-scoped call; the Page is on the New Pages Experience | Use the **`EAA…` Page** token. Get it: `GET /{pageId}?fields=access_token&access_token=SYSTEM_USER_TOKEN`. |
| Outbound **"Send failed"** with **no failed row** in the inbox | Worker only persists on a **successful** Meta send; a rejection just fires a `send_failed` event | Real cause is one of the token errors above — fix the stored token. |
| Instagram outbound **"(#3) Application does not have the capability"** | Sending to `/{igId}/messages` (Instagram-Login pattern) instead of `/{PAGE_ID}/messages` | Fixed in code (Instagram now sends via the Page id). Ensure the stored token is the **Page** token. |
| **No channel logos on rows / everything looks like WhatsApp** | `mapConversation` wasn't returning the `channel` field | Fixed in code — the list now carries each conversation's channel. |
| Contact **names show as numbers** (PSID/IGSID) | Name enrichment needs a **working Page token** and runs on the **next inbound** message | Fix the token; names fill in when the next message arrives (enrichment never overwrites an agent-set name). |

**Fast diagnosis (from this repo):** the ngrok request inspector at `http://localhost:4040/api/requests/http` shows every webhook Meta sends with its status — a `403` means HMAC, a `200` with only `message_edit` means dev-mode tester, no `page`/`instagram` object at all means the Page isn't subscribed. Outbound failures are only in the API logs (the worker persists nothing on failure), so reproduce the send with the curl tests above to see Meta's exact error.

## When Embedded Signup lands

All of the above is captured automatically: one **Facebook Login for Business** flow (Embedded Signup v4) onboards a client's WhatsApp + Page/Messenger + linked Instagram together, exchanging their token for the Page-scoped tokens — the exact keys this doc gathers by hand. See [onboarding-future.md](onboarding-future.md).
