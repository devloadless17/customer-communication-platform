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

## The recipe (add a channel in 5 steps)

1. **Add the `Channel` enum value** (`prisma/schema.prisma`) + migration. Non-destructive.
2. **Implement `MessagingProvider`** for the vendor in `apps/api/src/lib/providers/<vendor>.ts` — set `capabilities`, write `parseWebhook` (wire → `NormalizedEvent[]`), implement `sendText` + whatever the channel supports. No business logic here; just translation.
3. **Register it** in `apps/api/src/lib/providers/index.ts`: add a `REGISTRY[<channel>] = { provider, getSendConfig }` entry, and a `get<Vendor>SendConfig(teamId)` that reads the `ChannelConnection` row.
4. **Add a fanout rule** for any *new* event types you introduce (`apps/api/src/realtime/fanout-rules.ts`) — the `FanoutRuleMap` `Record` makes this a compile error until handled. Most channels reuse the existing `message.*` / `conversation.*` events and need nothing here.
5. **Wire onboarding**: a settings page to create the `ChannelConnection` (paste credentials → encrypted `secrets`), plus a webhook route if inbound differs from `/webhooks/meta/:teamId`.

Ingest, dedup (`@@unique([teamId, channel, externalId])`), realtime, workflows, broadcasts, and the `/v1` API all work unchanged because they operate on `NormalizedEvent` + `Channel`, never the vendor.

## Per-channel constraints (design targets)

| Channel | Free-form window | Proactive outbound | Media | Rate limit (start) | Verification |
|---|---|---|---|---|---|
| **WhatsApp** (Meta Cloud) | 24h customer-service window | Approved **templates** only outside 24h | image/video/audio/doc | ~80 msg/s, auto-scales w/ quality | Business verification (partner-led or Meta Verified for coexistence) |
| **Messenger** (Graph) | 24h | No templates; message tags / opt-in beyond 24h | image/video/attachments | high (per-Page) | FB App + `pages_messaging`; Page verified |
| **Instagram** (Graph) | 24h | No templates; business can only initiate after user contact | image/video/voice/stickers | high (Graph limits) | IG Business/Creator linked to a Page + `instagram_business_manage_messages` + App Review |
| **Telegram** (Bot API) | none (bot messages users who started the chat) | No templates | image/video/doc/polls | ~30 msg/s per bot | BotFather token; no business verification |
| **SMS** (Twilio/GSM) | none | Any text; TCPA/CAN-SPAM/GDPR opt-in/out | text (MMS carrier-dependent) | ~1 msg/s per number | provisioned number + A2P registration |
| **Email** (SMTP/API) | none | Templates/newsletters; unsubscribe required by law | attachments | very high | verified sending domain (SPF/DKIM) + opt-in |
| **Calling** (WhatsApp Business Calling) | 72h permission validity | permission request (1/24h, 2/7d caps) | audio (WebRTC) | — | calling enabled on the number |

Model each in the provider's `capabilities` (e.g. `freeFormWindowMs: 24*60*60*1000` for WhatsApp/Messenger/Instagram, `null` for Telegram/SMS/Email) so the reply box and broadcast rules derive their behavior from the capability, not from a hardcoded channel check.

## Onboarding references

- WhatsApp today: [customer-onboarding-whatsapp.md](customer-onboarding-whatsapp.md), [whatsapp-coexistence.md](whatsapp-coexistence.md)
- Future embedded-signup / Tech-Provider path: [onboarding-future.md](onboarding-future.md)

Compliance discipline for outbound/broadcast: check opt-in/consent before every send, honor STOP/unsubscribe immediately, respect the per-channel window (templates vs free-form), and throttle to the channel's rate limit. Keep raw inbound payloads (`Message.rawPayload`) for debugging every channel.
