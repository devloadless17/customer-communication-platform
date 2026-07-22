# Messaging providers — how to add a channel

This directory is the seam between the app and an external messaging channel.
Today there's exactly one provider (Meta WhatsApp Cloud), but the app routes
through the abstraction so a second channel (Instagram DM, Telegram, SMS, …)
drops in without touching ingest, send orchestration, or business logic.

## The pieces

| File | Role |
|---|---|
| `@ccp/shared/providers/types.ts` | `MessagingProvider<SendConfig>` interface + `ProviderCapabilities` + normalized event/arg shapes. The contract every channel implements. |
| `meta.ts` | The Meta WhatsApp Cloud implementation. |
| `config.ts` | Per-team Meta credential loader (`getMetaSendConfig`) + cache. Each provider gets its OWN config module + cache (no shared key — so "same team, two channels" can't collide). |
| `index.ts` | The **registry**: `ProviderBinding` (provider + its config loader, coupled), `getProviderBinding(name)`, `requireProviderMethod(...)`, and the Meta-only `getMetaProvider()`. |
| `channel.ts` | `resolveContactChannel(contact)` → `{ provider, to }`. The ONE place "phone number == identity" lives. |
| `ingest.ts` | Provider-agnostic inbound pipeline: `ingestEvents(workspaceId, provider, events)`. Dedup on `(workspaceId, provider, externalId)`. |

## Recipe — adding `telegram` (example)

1. **Schema:** add `telegram` to the `ProviderName` enum in `prisma/schema.prisma`,
   `prisma migrate dev`. (Contact identity already supports it:
   `identityProvider` + `externalContactId`, both nullable.)
2. **Implement the provider:** `telegram.ts` exporting a
   `MessagingProvider<TelegramSendConfig>` — at minimum `name`, `capabilities`
   (`freeFormWindowMs: null` if the channel has no free-form window),
   `parseWebhook`, and `sendText`. Implement the optional methods
   (`sendMedia`, `sendInteractive`, `sendTemplate`, `markIncomingRead`,
   `sendTypingIndicator`, `fetchMedia`) only for what the channel supports.
3. **Config loader:** `telegram-config.ts` with `getTelegramSendConfig(workspaceId)`
   reading per-team credentials (mirror `config.ts`'s ciphertext-cache pattern;
   keep your own cache — don't share Meta's).
4. **Register the binding** in `index.ts`:
   ```ts
   const REGISTRY: Record<ProviderName, ProviderBinding> = {
     meta_cloud: { provider: metaProvider, getSendConfig: getMetaSendConfig } as ProviderBinding,
     telegram:   { provider: telegramProvider, getSendConfig: getTelegramSendConfig } as ProviderBinding,
   };
   ```
5. **Webhook controller:** add `webhooks/telegram/telegram.controller.ts` at
   `/webhooks/telegram/:workspaceId` that verifies the channel's signature, calls
   `telegramProvider.parseWebhook(payload)`, and hands off to the SAME
   `ingestEvents(workspaceId, "telegram", events)`. Nothing in ingest changes.

That's it. The send paths already select the provider from the contact's
channel via `resolveContactChannel` + `getProviderBinding`, gate the free-form
window on `capabilities.freeFormWindowMs`, and stamp the resolved provider on
every message row.

## What is deliberately NOT abstracted (yet)

- **Per-channel SEND-time media validation.** The Meta-specific media checks
  (sticker must be `image/webp`, the WhatsApp audio MIME set, the
  `;codecs=opus` strip) live inline in `messages/messages.service.ts`. When a
  second channel adds media send, move those behind a provider method/capability
  rather than reading them here. NOTE: the blob-storage allowlist in
  `lib/blob-storage/mime-guard.ts` is a STORAGE-level security boundary (it
  excludes e.g. SVG for XSS) and is intentionally channel-agnostic — don't make
  it provider-aware; that's the wrong layer.
- **Per-channel error normalization.** `normalizeMetaSendError` is Meta-specific.
  A new channel would add its own; the send call sites catch the typed result.
- **Broadcasts** are bound to `meta_cloud` by design (`broadcast-runner.ts`):
  they send pre-approved WhatsApp templates, which is a Meta capability. A
  "broadcast over channel X" is a separate feature, not per-recipient routing.

## Behavior note

This whole layer was generalized as a behavior-preserving refactor — with only
`meta_cloud` registered, every send routes identically to the old hardcoded
path. `getProviderBinding("meta_cloud").provider` IS `metaProvider`.
