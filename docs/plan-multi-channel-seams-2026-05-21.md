# Plan — Multi-channel seam prep (2026-05-21)

**Status: IMPLEMENTED 2026-05-21 on branch `feat/multi-channel-seams`** (behavior-
preserving, both typechecks green, api smoke-booted clean). Not committed — held for
the pending architecture review. Sections 1-7 below are the original plan; what
actually shipped is summarized here.

### What shipped

**Send-side (sections 1-7):** `ProviderBinding`/`getProviderBinding`/
`requireProviderMethod` registry, `resolveContactChannel` (kills phone-as-identity),
capability-driven window (`freeFormWindowMs`, null=skip), provider stamped on every
message row + send-queue job, README recipe. Generalized: send-text/interactive/
template-internal, messages.service (text/media/forward), external-v1-messaging,
broadcast-runner, conversations.service (typing/mark-read by inbound provider).
`getMetaProvider()` now only at the Meta webhook controller + whatsapp.service admin ops.

**Read-side + channel ownership (added on top; corrected after user feedback that
"channel is conversation-related, not contact-related"):**
- **`Conversation.provider` column** (migration `20260521115436_add_conversation_provider`,
  `@default(meta_cloud)`) is the SOURCE OF TRUTH for a thread's channel. Stamped at
  creation: inbound = the ingesting provider param; interactive-send = resolved
  channel; broadcast / workflow-target / external-v1 ride the default (WhatsApp-only
  paths today). `Message.provider` mirrors it per row.
- `WorkflowMessageSnapshot.provider` + `WorkflowConversationSnapshot.provider`
  (both required) — apps/api + @ccp/shared mirrors, populated by the builders.
- Workflow condition field **`provider`** (label "Channel") on `message_received` +
  the 5 conversation_* triggers; resolver in `conditions.ts` reads
  `message.provider ?? conversation.provider` — NO contact fallback. FE builder
  mirror updated (value kind "channel" → CHANNEL_VALUES).
- Field tokens `$var.message.provider` + `$var.conversation.provider`.
- External `/v1`: `provider` on `ExternalMessage` (from row) AND
  `ExternalConversation` (from `conversation.provider`, not the contact).
- Outbound webhooks already carried `channel.source` — left as-is.

> **Channel-ownership rule:** channel belongs to the **conversation**
> (`Conversation.provider`), mirrored on `Message.provider`. NEVER derive it from
> `Contact.identityProvider` (null for phone-keyed WhatsApp contacts). Contacts stay
> siloed per channel (decided 2026-05-21), so contact.channel == conversation.channel
> today — but the conversation is the owner.
> **Send-side (completed 2026-05-21):** existing-conversation sends (send-*-internal,
> messages.service text+media, external-v1) read the binding + stamp the message from
> `conversation.provider`; `resolveContactChannel` supplies only the destination
> address. Create-capable sends (forward, broadcast) stamp the new conversation's
> provider and the messages inherit it. So `message.provider == conversation.provider`
> holds by construction on every path.
> **Migration note:** `migrate dev` regenerates a spurious
> `DROP INDEX Contact_customFields_gin_idx` (hand-written JSONB GIN index Prisma's DSL
> can't model) — strip it from every generated migration, and run `npx prisma generate`
> explicitly afterward (migrate dev's auto-generate didn't pick up the new column).

---

## Original plan (for reference)

## What this is (and is NOT)

**Goal:** make the codebase provider-agnostic at every seam so that adding a
*real* second channel later (Instagram DM / Telegram / SMS) is "implement
`MessagingProvider` + add one webhook controller + add config columns" — with
**zero** changes to ingest, send orchestration, or business logic.

**Non-goals (explicitly out of scope this pass):**
- No second provider implementation. `MetaProvider` stays the only impl.
- No new `ProviderName` enum values. The enum stays `{ meta_cloud }`.
- **No behavior change for WhatsApp.** This is a behavior-preserving refactor —
  every Meta send/receive must produce byte-identical results, just routed
  through generic abstractions. That's the acceptance bar.

> Context flag: this overrides the CLAUDE.md "multi-channel is deferred" rule —
> done deliberately at user request (2026-05-21). It also lands on top of the
> uncommitted local tangle that's pending architecture review
> ([[project_pending_architecture_review]]), so see **Open decision D** on the
> branch/commit boundary.

---

## Current state (evidence)

The expensive parts are already right ([[project_contacts_siloed_per_channel]]):
- `MessagingProvider<SendConfig>` interface with a `capabilities` block
  (`freeFormWindowMs | null`, `templates`, `readReceipts`, `typingIndicators`)
  and optional methods — [packages/shared/src/providers/types.ts:345-419](packages/shared/src/providers/types.ts#L345).
- Normalized ingest: `parseWebhook` → `NormalizedEvent[]` →
  `ingestEvents(teamId, provider, events)`, dedup on `(teamId, provider, externalId)`
  — [apps/api/src/lib/providers/ingest.ts](apps/api/src/lib/providers/ingest.ts).
- Schema identity model: `Contact.identityProvider` + `externalContactId`,
  `phoneNumber` nullable, dual unique constraints — [prisma/schema.prisma:439-529](prisma/schema.prisma#L439).

What's hardcoded to Meta/WhatsApp and blocks a clean drop-in:
- Registry is a stub: only `getMetaProvider()` — [apps/api/src/lib/providers/index.ts:14](apps/api/src/lib/providers/index.ts#L14).
- Per-contact send paths hardcode `getMetaProvider()`, `phoneNumber` as the
  destination, `provider: "meta_cloud"` on the row, and the 24h window —
  canonical example [send-text-internal.ts:88-152](apps/api/src/lib/messaging/send-text-internal.ts#L88).
- Config cache keyed by `teamId` only — [config.ts:113-117](apps/api/src/lib/providers/config.ts#L113).
- MIME allowlist is global, no provider context — [uploadthing.ts](apps/api/src/lib/blob-storage/uploadthing.ts).

---

## 1. Provider registry + config binding

### Problem
`getMetaProvider()` returns the singleton; there's no way to get "the provider
for channel X plus its matching config" in a type-safe pair. The interface is
generic over `SendConfig`, so a naive `getProvider(name): MessagingProvider<unknown>`
loses the config↔provider coupling.

### Fix — a `ProviderBinding` that couples provider + its config loader
[apps/api/src/lib/providers/index.ts](apps/api/src/lib/providers/index.ts):

```ts
interface ProviderBinding<C> {
  provider: MessagingProvider<C>;
  getSendConfig(teamId: string): Promise<C>;
}

const REGISTRY: Record<ProviderName, ProviderBinding<unknown>> = {
  meta_cloud: { provider: metaProvider, getSendConfig: getMetaSendConfig } as ProviderBinding<unknown>,
};

export function getProviderBinding(name: ProviderName): ProviderBinding<unknown> {
  const b = REGISTRY[name];
  if (!b) throw new UnsupportedProviderError(name);
  return b;
}

// Kept for genuinely Meta-only call sites (template sync, typing, mark-read).
export function getMetaProvider(): MessagingProvider<MetaSendConfig> { return metaProvider; }
```

The binding guarantees `provider` and `getSendConfig` share the same `C` at
construction; erasing to `unknown` for the lookup is sound because a generic
caller only ever feeds `getSendConfig`'s output straight into the *same
binding's* provider methods.

### Generic send helper
A thin `lib/messaging/dispatch.ts` so call sites don't repeat the bind+config+send dance:

```ts
export async function providerSendText(provider: ProviderName, teamId: string, args: SendTextArgs) {
  const b = getProviderBinding(provider);
  const cfg = await b.getSendConfig(teamId);
  return b.provider.sendText(args, cfg);
}
// + providerSendMedia / providerSendInteractive / providerSendTemplate, each
//   asserting capability/optional-method presence and throwing a typed error.
```

**Files:** `index.ts` (registry), new `dispatch.ts`. **Risk:** low — additive.

---

## 2. Config cache keyed by (provider, teamId)

### Problem
[config.ts:113-117](apps/api/src/lib/providers/config.ts#L113) keys `sendCache`
/ `webhookCache` by `teamId`. If a team ever runs two channels, keys collide.

### Fix
Change the cache key to `${provider}:${teamId}` (or a nested
`Map<ProviderName, Map<teamId, …>>`). Today only `meta_cloud` exists →
behavior identical. `invalidateProviderConfig(teamId)` clears all provider
entries for the team. **Risk:** low — internal key format only.

---

## 3. Channel resolution helper (kills the phone-as-identity assumption)

### Problem
Send paths inline `conversation.contact.phoneNumber` as the destination and
error `contact_has_no_phone` — [send-text-internal.ts:88-93,122](apps/api/src/lib/messaging/send-text-internal.ts#L88).
That's WhatsApp-only; an Instagram contact has `externalContactId`, not a phone.

### Fix
New `lib/providers/channel.ts`:

```ts
// contact: { phoneNumber, identityProvider, externalContactId }
export function resolveContactChannel(contact): { provider: ProviderName; to: string } {
  if (contact.identityProvider && contact.externalContactId)
    return { provider: contact.identityProvider, to: contact.externalContactId };
  if (contact.phoneNumber)
    return { provider: "meta_cloud", to: contact.phoneNumber };
  throw new NoDestinationError();
}
```

Send paths select `provider` + `to` from this, feed `to` to the dispatcher,
and stamp the resolved `provider` on the message row instead of the literal
`"meta_cloud"` ([send-text-internal.ts:152](apps/api/src/lib/messaging/send-text-internal.ts#L152)).

**Open decision A** — the error code `contact_has_no_phone` is consumed by the
FE reply box. Options: (a) rename to `contact_has_no_destination` and update the
FE, or (b) keep `contact_has_no_phone` as the meta_cloud-specific code and add
the generic one alongside. I lean (b) for stability.

---

## 4. Capability-driven window check

### Problem
[send-text-internal.ts:98](apps/api/src/lib/messaging/send-text-internal.ts#L98)
calls `computeWindowStatus(lastInboundAt)` with the default 24h. The window is
already parameterized in shared code; the provider already declares
`capabilities.freeFormWindowMs`. The send path just doesn't read it.

### Fix
`computeWindowStatus(lastInboundAt, new Date(), binding.provider.capabilities.freeFormWindowMs)`.
When `freeFormWindowMs === null` (a channel with no free-form window, e.g.
Telegram), **skip the window check + the template fallback entirely**. Meta
keeps `24h` → identical behavior. Same change in `send-interactive-internal`
and the media send path.

**Out of scope this pass:** the FE 24h window chip computes its own hardcoded
24h (apps/web). Generalizing it is **Open decision B** (backend-only vs include FE).

---

## 5. Which call sites get generalized (targeted, NOT blanket)

`getMetaProvider()` appears in ~8 files. Only **per-contact message sends** get
routed through the registry/resolver. Provider-specific **admin** ops stay on
`getMetaProvider()` directly — they live under /settings/whatsapp and are
legitimately WhatsApp-only until a second channel needs an equivalent.

| File | Action |
|---|---|
| [send-text-internal.ts](apps/api/src/lib/messaging/send-text-internal.ts) | ✅ generalize (registry + resolver + capability window) |
| [send-interactive-internal.ts](apps/api/src/lib/messaging/send-interactive-internal.ts) | ✅ generalize |
| [send-template-internal.ts](apps/api/src/lib/messaging/send-template-internal.ts) | ✅ generalize send; template *catalog* stays Meta |
| media send (messages.service.ts forward/media) | ✅ generalize send + row provider |
| [broadcast-runner.ts](apps/api/src/lib/broadcast-runner.ts) | ✅ generalize (resolve per recipient) |
| [external-v1-messaging.service.ts](apps/api/src/external/v1/external-v1-messaging.service.ts) | ✅ generalize |
| [conversations.service.ts](apps/api/src/conversations/conversations.service.ts) | review — mark-read/typing likely stay Meta |
| [whatsapp.service.ts](apps/api/src/team/whatsapp/whatsapp.service.ts) | ❌ stays Meta (template sync, settings, mark-read, typing) |

---

## 6. MIME rules by provider — lowest priority (Open decision B)

[uploadthing.ts](apps/api/src/lib/blob-storage/uploadthing.ts) `assertAllowedMime`
is global. Thread an optional provider/matrix param (defaulting to Meta's
current matrix) so a future channel with a different media set plugs in. Only
exercised once a non-Meta channel exists, so this can ship in this pass
behind a default or be deferred. Recommend: include the param, keep Meta
default → no behavior change.

---

## 7. Webhook ingest — no work, document only

Per-provider webhook controllers are by design. The Meta one stays at
`/webhooks/meta/:teamId`. A new channel adds its own controller that verifies
its signature, calls `provider.parseWebhook`, and hands off to the **existing**
`ingestEvents(teamId, provider, events)`. I'll add a short README note in
`lib/providers/` documenting the "to add a channel, do X/Y/Z" recipe so the
seam is discoverable.

---

## Verification (behavior-preserving bar)

1. `npm run typecheck && npm run api:typecheck` green.
2. Runtime check of the dispatcher: a `meta_cloud` send routes through
   `getProviderBinding` → identical Meta call (assert `to`/config unchanged).
3. Smoke-boot the api (when Docker/infra available — blocked locally today,
   [[feedback_smoke_boot_before_claiming_green]]) and send one real text +
   one media + verify an inbound still ingests.
4. Diff review: confirm no Meta behavior changed — only indirection added.

---

## Files touched (est. 9-12)
New: `lib/messaging/dispatch.ts`, `lib/providers/channel.ts`, `lib/providers/README.md`.
Edited: `lib/providers/index.ts`, `lib/providers/config.ts`, the 5-6 send call
sites in the table above. No schema migration. No FE (unless Open decision B
includes the window chip / reply-box error code).

---

## Open decisions (need answers before "go")
- **A. Error code:** rename `contact_has_no_phone` → generic, or keep + add? (I lean keep + add.)
- **B. Scope:** backend seams only, or also generalize the FE 24h window chip + MIME-by-provider this pass? (I lean backend-only + include the MIME param with a Meta default.)
- **C. Branch:** given the pending architecture review on uncommitted work, do this on a fresh branch off `main` so it's a reviewable, isolated commit boundary? (I lean yes — **Open decision D**.)
