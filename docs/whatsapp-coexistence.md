# WhatsApp Coexistence — go-live runbook

**One number, both surfaces.** Coexistence lets the *same* WhatsApp number run on the
**WhatsApp Business App (phone)** and the **Cloud API (this system)** at the same time.
Replies the owner sends from the phone mirror into the shared inbox; the inbox can also
back-fill up to ~180 days of past chats (something the plain Cloud API cannot do).

> **Status (2026-07-06):** the **sync engine (Phase A) is built, verified, and in the
> codebase.** It is dormant until a coexistence number's webhooks start arriving — no code
> change is needed to "turn it on." What remains is **Meta approval + onboarding the number**
> (this doc), and *optionally* the in-app self-serve onboarding UI (Phase B, below).

---

## TL;DR decision

There is **no refactor** ahead. To go live you need, in order:

1. **Meta Tech Provider approval** with Embedded Signup + Coexistence enabled. *(Meta-side review; not code.)*
2. **Subscribe 3 webhook fields** in the Meta App Dashboard: `smb_message_echoes`, `history`, `smb_app_state_sync`. *(Dashboard clicks; not code.)*
3. **Onboard the number to coexistence** — pick ONE path:
   - **Path A — manual / BSP (near-zero code):** onboard via Meta's flow or a BSP, then paste the credentials into **Settings → WhatsApp**. The sync engine does the rest. History backfill only happens if the onboarding call triggers it (a BSP does this for you).
   - **Path B — in-app self-serve QR button (Phase B build, ~1–2 days):** build the Embedded Signup coexistence flow so the owner (or a customer) onboards from inside the app. Needed if you want self-serve onboarding at SaaS scale. Also depends on step 1.

If you just want *your own* number working, **Path A is the half-day path.** Path B is a product feature for onboarding *other* businesses later.

---

## ⚠️ Gotcha to resolve BEFORE onboarding

Your number is currently on the Cloud API the **non-coexistence** way. A number already
registered on the Cloud API cannot simply re-attach the phone app. To get coexistence you
must go through **Meta's coexistence onboarding path** (the number starts on the WhatsApp
Business App, then you onboard it via the coexistence Embedded Signup entry point / BSP).
Confirm the exact migration steps with Meta / your BSP for a number that's *already* on
Cloud API — this is the one operational unknown. The code receiver works regardless of how
the flip is done.

Other constraints to expect (all Meta-side, none require code):
- **Throughput drops** while coexisting (~5–20 mps). Fine for a shared inbox.
- **OBA blue badge unsupported** on coexistence numbers (Meta Verified for Business instead).
- **Companion devices unlink** on onboarding (Windows/WearOS unsupported; re-link iPhone/Android/Mac after).
- **History sync must be triggered within 24h** of onboarding or the number must be off/re-onboarded.
- **24h customer-service window + templates** still apply exactly as today.

---

## Path A — manual / BSP onboarding (the fast path)

1. **Meta approval** (step 1 above) is in place.
2. In the **Meta App Dashboard → WhatsApp → Configuration → Webhook fields**, subscribe:
   `messages` (already), **`smb_message_echoes`**, **`history`**, **`smb_app_state_sync`**.
   (The in-app Settings → WhatsApp page prints this reminder too.)
3. Onboard the number to coexistence via Meta's flow or your BSP. Ensure the **history sync
   is triggered within 24h** (BSPs do this automatically; confirm with yours).
4. In **Settings → WhatsApp**, paste `phoneNumberId`, `accessToken`, `appSecret`
   (+ optional `wabaId`, `appId`). This writes the `ChannelConnection` row the receiver reads.
5. Verify (see **Verification** below).

That's it — no code change. Live phone replies start mirroring immediately; past chats
back-fill over the following minutes (chunked, quiet, archived as `closed`).

---

## Path B — in-app Embedded Signup coexistence flow (deferred build)

Build this when you want customers to self-onboard (SaaS scale). **~1–2 days, not a refactor.**
Mount point already stubbed: `embeddedSignupCard` in
`apps/web/src/app/(app)/settings/whatsapp/whatsapp-settings.tsx` ("Coming soon", disabled).

Build checklist:
1. **Frontend:** wire the stubbed card to the Facebook JS SDK Embedded Signup flow using the
   **coexistence entry point** (customer scans a QR in their WhatsApp Business App to authorize).
2. **Backend — token exchange:** exchange the returned code → long-lived access token.
3. **Backend — subscribe fields programmatically:** call Graph `POST /{wabaId}/subscribed_apps`
   to subscribe `messages` + `smb_message_echoes` + `history` + `smb_app_state_sync`
   (removes the manual dashboard step for onboarded numbers).
4. **Backend — trigger history sync** via the SMB App Data API **within 24h** of onboarding
   (this is what makes the `history` webhook fire — Path A relies on the BSP doing it).
5. **Persist credentials:** reuse `whatsapp.service.ts` `updateConfig`'s encrypt-and-upsert
   path — no new storage. Everything Embedded Signup returns (phoneNumberId, wabaId, appId,
   accessToken) already fits the `ChannelConnection` row.
6. **HMAC nuance:** in a Tech-Provider model the webhook signature is the **platform app
   secret** (one), not a per-team `appSecret`. For the single-tenant pilot they're the same
   value, so nothing breaks now — but when onboarding a *second* business, make webhook
   verification (`getMetaWebhookConfig` / `verifySignature` in `meta.controller.ts`) fall
   back to the platform app secret for coexistence numbers.

Nothing in Path B changes the receiver — it only automates what Path A does by hand.

---

## What's already built (Phase A — the receiver)

Handles the three coexistence webhooks; dormant until they arrive.

| Webhook field | What it does in our system | Key code |
|---|---|---|
| `smb_message_echoes` | Owner's phone-sent reply → outbound row (`direction:out`, `senderUserId:null`, `origin:business_app`), keyed on the customer (`to`, **not** `from`=business). Clears team unread (owner saw it). No automation re-fire. Inbox shows a "· via WhatsApp app" chip. | `ingestOutboundEcho` in `apps/api/src/lib/providers/ingest.ts`; parser branch in `apps/api/src/lib/providers/meta.ts` |
| `history` | Past-180d backfill → routed to the `coexistence-history` BullMQ worker. **Quiet** ingest: no unread bump, no automation/webhook fanout, no per-message socket frame; backfilled-only threads land `closed`. Handles the decline case (error `2593109`). | `containsHistory`/enqueue in `apps/api/src/webhooks/meta/meta.controller.ts`; `apps/api/src/lib/coexistence/history-{queue,worker}.ts`; `ingestHistoricalMessage` in `ingest.ts` |
| `smb_app_state_sync` | Names an **existing** unnamed contact from the phone address book. Never creates a contact; never clobbers an agent-set name. | `ingestContactSync` in `ingest.ts` |

Supporting pieces:
- **Schema:** `MessageOrigin { api business_app }` enum + `Message.origin` column
  (in the `0_init` baseline).
- **Wire/UI:** `origin` on the shared `Message` type + `mapMessage`; "via WhatsApp app"
  chip in `apps/web/src/features/inbox/components/message-bubble.tsx`.
- **Worker lifecycle:** `apps/api/src/coexistence/coexistence-worker.service.ts`
  (registered in `WebhooksModule`, gated by `RUN_WORKER_INLINE`).

### Known limitations (accepted, documented in code — not bugs)
- **History media older than 14 days** renders as a "📎 Media" placeholder — Meta only
  re-sends the real binary for messages within 14 days of onboarding. Live phone-sent media
  downloads fully.
- **A brand-new thread the owner *starts* from the phone** live-splices via the
  `message.sent` `newConversation` frame; if that frame is missed it still appears on the
  next list fetch (the row is always written correctly).

---

## Verification (after onboarding, or to re-test the receiver anytime)

The receiver was verified end-to-end on 2026-07-06 by driving the real parser + ingest
against the dev DB (echo, echo-idempotency, echo-of-API-send dedupe, history quiet-backfill,
contact-name sync, decline). To re-run that style of check, replay a signed payload:

1. Ensure a `ChannelConnection` exists for the team (Settings → WhatsApp) so
   `getMetaWebhookConfig` returns a config.
2. `POST` a crafted webhook body to `/webhooks/meta/{teamId}` with header
   `X-Hub-Signature-256: sha256=<HMAC-SHA256(rawBody, appSecret)>`.
3. Assert in the DB:
   - echo → one `direction:out`, `origin:business_app` row keyed on the customer; unread cleared; re-POST is a no-op.
   - history → contact/conversation created `closed`, correct directions, unread untouched.
   - state_sync → names an unnamed contact only.

Post-onboarding smoke test: send yourself a message from the **phone app** → it should
appear in the inbox as an outbound "via WhatsApp app" bubble within a second.

---

## Multi-channel (Instagram / Messenger / Telegram) — future, unrelated to coexistence

Architecture is ready: a new channel = a new `Channel` enum value + a registered
`MessagingProvider` + a `ChannelConnection` row (`getProviderBinding(channel)`). **Before
shipping channel #2**, fix the channel-blind contact lookup (the `TODO` in
`ingestInboundMessage`, `ingest.ts` — it keys on `phoneNumber` only). Out of scope until a
pilot asks and WhatsApp depth is done (per CLAUDE.md).

---

*Related: [customer-onboarding-whatsapp.md](customer-onboarding-whatsapp.md),
[onboarding-future.md](onboarding-future.md). Memory: `whatsapp-coexistence`.*
