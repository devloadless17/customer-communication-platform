# Adding a Channel

Deep-dive companion to [CLAUDE.md](../CLAUDE.md). See also the engine-level [providers README](../apps/api/src/lib/providers/README.md).

The platform is **channel-agnostic by design**. Nothing outside the provider layer knows a Meta wire shape. Adding a channel is a bounded, additive change — it should never touch ingest, controllers, reducers, or the event bus.

## The core abstraction

- **`Channel`** enum (`prisma/schema.prisma`) — the one discriminator for "where is this from." Today: `whatsapp`. There is **no `provider`/`vendor` column** — which vendor implements a channel is an impl detail, never persisted. (Meta Cloud serves both WhatsApp and, in future, Instagram — they are *distinct channels* even though one API delivers them, which is exactly why the channel, not the vendor, is the discriminator.)
- **`MessagingProvider<SendConfig>`** interface (`packages/shared/src/providers/types.ts`) — a generic adapter with:
  - `name: Channel`
  - `capabilities: ProviderCapabilities` — declarative feature flags (`freeFormWindowMs`, `templates`, `readReceipts`, `typingIndicators`, `calling`) so channel-agnostic code branches on capability, never on `instanceof`.
  - `parseWebhook(payload) → NormalizedEvent[]` — a **pure** parser. Translates the vendor wire shape into the provider-agnostic `NormalizedEvent` union (`NormalizedInboundMessage | NormalizedStatusUpdate | NormalizedCallEvent | NormalizedReaction | NormalizedTemplateStatusUpdate | NormalizedOutboundEcho | NormalizedContactSync`). App code only ever sees `NormalizedEvent`.
  - Required `sendText`; optional `sendMedia`/`uploadMedia`/`sendTemplate`/`sendInteractive`/`markIncomingRead`/`sendTypingIndicator`/… and the WhatsApp Business Calling methods.
- **Registry** (`apps/api/src/lib/providers/index.ts`) — `getProviderBinding(channel)` returns `{ provider, getSendConfig(teamId) }`; throws `UnsupportedProviderError` for unregistered channels. `requireProviderMethod(...)` narrows an optional method, throwing `UnsupportedProviderOperationError` if a channel doesn't support it.
- **`ChannelConnection`** row (`prisma/schema.prisma`, `@@unique([teamId, channel])`) — per-(team, channel) credentials: `config` JSON (non-secret) + `secrets` JSON (envelope-encrypted). Loaded/cached by `apps/api/src/lib/providers/config.ts`.

The only implementation today is the `metaProvider` **object** (not a class) in `apps/api/src/lib/providers/meta.ts`.

**Current state.** Live channels: **WhatsApp, Messenger, Instagram**, and the first-party **Website widget** (`webchatwidget`) — each has a provider + onboarding. The website widget is the one channel with NO external vendor: visitor messages arrive over a public Socket.io namespace and outbound is delivered by the realtime fanout (see [webchatwidget.md](webchatwidget.md)). Designed-for / disabled: **Telegram, Email, SMS** — the enum value + `CHANNEL_CAPABILITIES` / `CHANNEL_IDENTITY_KIND` / `CHANNEL_LABEL` entries + badge already exist (`@ccp/shared/providers/capabilities`, `channel-badge.tsx`), but there's no provider/webhook/onboarding, so they're absent from `LIVE_CHANNELS` and the provider `REGISTRY`. Because of that, no row can carry them — the architecture is ready, the implementation is a focused follow-up. The Meta social channels (`messenger.ts`/`instagram.ts`) are thin wrappers over `meta-social.ts`; a genuinely different vendor (Telegram Bot API, etc.) is a full sibling provider.

## The recipe (add a channel)

1. **Enum value** — already present for telegram/email/sms (`prisma/schema.prisma` + `@ccp/shared/types` + migration). For a brand-new channel, add it here (additive migration) and fill its `CHANNEL_CAPABILITIES` / `CHANNEL_IDENTITY_KIND` / `CHANNEL_LABEL` entries (the `Record<Channel, …>` maps make omissions a compile error).
2. **Implement `MessagingProvider`** in `apps/api/src/lib/providers/<vendor>.ts` — `capabilities` (reference the shared map), `parseWebhook` (wire → `NormalizedEvent[]`; use `externalContactId` for non-phone identity), `sendText` + whatever the channel supports (`uploadMedia`/`sendMedia`, `fetchContactProfile`, …). No business logic — just translation.
3. **Config loader** `apps/api/src/lib/providers/<vendor>-config.ts` reading the `(teamId, channel)` `ChannelConnection` (ciphertext cache, decrypt-on-demand — mirror `messenger-config.ts`).
4. **Register** in `apps/api/src/lib/providers/index.ts` (`REGISTRY[<channel>]`) **and add the channel to `LIVE_CHANNELS`** in `@ccp/shared/providers/capabilities` so the UI stops treating it as "coming soon".
5. **Fanout rule** for any *new* event types (`apps/api/src/realtime/fanout-rules.ts`) — the `FanoutRuleMap` `Record` compile-errors until handled. Most channels reuse `message.*` / `conversation.*` and need nothing.
6. **Webhook + onboarding** — a webhook route (Meta products share `/webhooks/meta/:teamId` via object-dispatch; a non-Meta vendor like Telegram gets its own `/webhooks/<vendor>/:teamId` with its own auth, e.g. a secret token instead of HMAC) + a `team/<vendor>/` admin module and a `/settings/<vendor>` connect page (mirror `team/messenger/` + `settings/messenger/`).

Ingest, dedup (`@@unique([teamId, channel, externalId])` — note a channel whose message ids aren't globally unique, like Telegram's per-chat `message_id`, must compose a unique `externalId` such as `chatId_messageId`), realtime, workflows, broadcasts, and the `/v1` API all work unchanged because they operate on `NormalizedEvent` + `Channel`, never the vendor.

## Per-channel constraints (design targets)

| Channel | Free-form window | Proactive outbound | Media | Rate limit (start) | Verification |
|---|---|---|---|---|---|
| **WhatsApp** (Meta Cloud) | 24h customer-service window | Approved **templates** only outside 24h | image/video/audio/doc | ~80 msg/s, auto-scales w/ quality | Business verification (partner-led or Meta Verified for coexistence) |
| **Messenger** (Graph) | 24h | No templates; message tags / opt-in beyond 24h | image/video/attachments | high (per-Page) | FB App + `pages_messaging`; Page verified |
| **Instagram** (Graph) | 24h | No templates; business can only initiate after user contact | image/video/voice/stickers | high (Graph limits) | IG Business/Creator linked to a Page + `instagram_business_manage_messages` + App Review |
| **Website widget** (first-party) | none (live session) | No templates; visitor initiates | image/video/audio/voice/doc | per-IP token buckets | public **site key** + origin allow-list (no vendor). See [webchatwidget.md](webchatwidget.md) |
| **Telegram** (Bot API) | none (bot messages users who started the chat) | No templates | image/video/doc/polls | ~30 msg/s per bot | BotFather token; no business verification |
| **SMS** (Twilio/GSM) | none | Any text; TCPA/CAN-SPAM/GDPR opt-in/out | text (MMS carrier-dependent) | ~1 msg/s per number | provisioned number + A2P registration |
| **Email** (SMTP/API) | none | Templates/newsletters; unsubscribe required by law | attachments | very high | verified sending domain (SPF/DKIM) + opt-in |
| **Calling** (WhatsApp Business Calling) | 72h permission validity | permission request (1/24h, 2/7d caps) | audio (WebRTC) | — | calling enabled on the number |

Model each in the provider's `capabilities` (e.g. `freeFormWindowMs: 24*60*60*1000` for WhatsApp/Messenger/Instagram, `null` for Telegram/SMS/Email) so the reply box and broadcast rules derive their behavior from the capability, not from a hardcoded channel check.

## The Meta host decision (WhatsApp + Messenger + Instagram) — locked

**All three Meta channels run on `graph.facebook.com` via Facebook Login for Business — never `graph.instagram.com`.** Instagram has two mutually incompatible integration paths; we deliberately use the first:

| | **Instagram via Facebook Login** ← *ours* | Instagram API with Instagram Login |
|---|---|---|
| Host | `graph.facebook.com` | `graph.instagram.com` |
| Requires FB Page link | **Yes** (IG Business/Creator ↔ Page) | No (standalone IG) |
| Onboarding | Business Manager, centralized, multi-account | per-IG-account, consumer-style |
| Token namespace | same as WhatsApp + Messenger | separate |

Why this is the right (and only) choice here:
- **One rail for every Meta channel** — one Graph host, one token model, one webhook-signature model. `meta-graph.ts` / `meta-social.ts` assume this; `graph.instagram.com` would fork the provider layer for no gain.
- **It's what Embedded Signup / Tech-Provider onboarding is built on** — Meta's Embedded Signup runs on Facebook Login for Business and returns Business-Manager-scoped tokens, so **one** flow onboards a client's WhatsApp + Page/Messenger + linked Instagram together. The Instagram-Login path sits outside that flow.
- **It's what world-class inboxes (Respond.io, Trengo, Chatwoot) require** — IG Business linked to a Page, authenticated through Facebook.

Consequences baked into the code (don't regress):
- **Instagram onboarding takes the *Page id*, not a raw Instagram id.** `InstagramService.updateConfig` resolves `instagram_business_account{id,username}` from the Page — that derived id is the canonical `graph.facebook.com`-namespace id used by both inbound webhooks and outbound sends. Pasting a raw id (esp. a `graph.instagram.com`-namespace one) is impossible by construction. No linked IG account → hard reject (`instagram_not_linked_to_page`).
- **One app secret across all three Meta channels** — the webhook GET verify honors any of the team's channel verify tokens (`getTeamVerifyTokens`), and each channel's POST HMAC uses the same Meta app's secret. Wiring a channel through a *separate* Meta app (e.g. the standalone "Instagram" app with its own secret) breaks inbound HMAC.
- **The `messages` webhook field must be subscribed on that one app**, and in Development mode the *sender* must be an accepted app tester or Instagram withholds message content (delivering only empty `message_edit`/`read` companions).

When to revisit: only if a real customer needs a **Page-less Instagram creator** — then *add* a second `graph.instagram.com` provider binding behind the same `MessagingProvider` interface; never replace the Facebook path.

## Onboarding references

- WhatsApp today: [customer-onboarding-whatsapp.md](customer-onboarding-whatsapp.md), [whatsapp-coexistence.md](whatsapp-coexistence.md)
- Future embedded-signup / Tech-Provider path: [onboarding-future.md](onboarding-future.md)

Compliance discipline for outbound/broadcast: check opt-in/consent before every send, honor STOP/unsubscribe immediately, respect the per-channel window (templates vs free-form), and throttle to the channel's rate limit. Keep raw inbound payloads (`Message.rawPayload`) for debugging every channel.
