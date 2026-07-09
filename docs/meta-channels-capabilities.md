# Meta Channels — Capability & Gap Matrix

Single reference for what the three Meta channels (**WhatsApp**, **Facebook
Messenger**, **Instagram DM**) support in this codebase, what's deliberately
deferred, and where each behavior lives. All three run on the Graph API
(`graph.facebook.com`); the `Channel` enum is the only discriminator (no
`provider`/`vendor` column — §5). Behavior is **capability-driven**
(`packages/shared/src/providers/capabilities.ts`), never a hardcoded
`if (channel === "…")` in a hot path.

Legend: ✅ implemented · ➖ not applicable / no Meta API · 🔜 designed, backend
ready, UI deferred · ✋ deliberately out of scope.

---

## Messaging

| Capability | WhatsApp | Messenger | Instagram | Owner |
|---|---|---|---|---|
| Inbound text | ✅ | ✅ | ✅ | `meta.ts` / `meta-social.ts` |
| Inbound media (image/video/audio/doc) | ✅ | ✅ | ✅ | ingest + `downloadInboundMedia`/`downloadSocialMedia` |
| Per-channel media caps + mime allow-list | ✅ | ✅ | ✅ | `media-storage.ts` `mediaPolicyForChannel` |
| Outbound text | ✅ | ✅ | ✅ | provider `sendText` |
| Outbound media | ✅ (upload) | ✅ (upload) | ✅ (by URL) | `sendMedia` (+ `mediaSendByUrl`) |
| Message length cap (pre-send) | 4096 | 2000 | 1000 | capability `messageTextMaxChars` |
| Interactive quick-replies / list | ✅ | ✅ (quick-reply) | ✅ (quick-reply) | `sendInteractive` |
| Inbound interactive reply → workflow id | ✅ (button/list + template `type:button`) | ✅ (quick_reply + **postback**) | ✅ | parsers |
| Reactions (inbound) | ✅ | ✅ (`emoji`/`reaction`) | ✅ | `NormalizedReaction` |
| Read receipts | ✅ (per-message) | ✅ (mark_seen thread) | ✅ (per-mid) | `markIncomingRead` |
| Typing indicator | ✅ | ✅ (`typing_on`) | ✅ | `sendTypingIndicator` |
| Delivery / read status | ✅ | ✅ (delivery + watermark) | ✅ (per-mid) | status parse |
| Link preview (`preview_url`) | ✅ (auto on URL) | native | native | `sendText` |
| Human-Agent tag banding (24h→7d) | ➖ (templates only) | ✅ | ✅ | all 4 send paths incl. workflow `send-text-internal` |
| Channel-aware send-error classification | ✅ | ✅ | ✅ | `meta-send-error.ts` |
| Webhook field router + log-unknown | ✅ | ✅ | ✅ | parsers (fail-soft, still 200) |
| Webhook origin check (defense-in-depth) | ✅ phone_number_id | ✅ entry.id (Page) | ✅ entry.id (IG id) | `meta.controller.ts` |

### Caption follow-up (social)
Meta social can't carry an attachment + text in one send, so a media caption is
a follow-up text — now **retried once and logged** on failure
(`social.caption_dropped`) instead of silently swallowed.

---

## Templates (WhatsApp only)

| Capability | Status | Owner |
|---|---|---|
| Approved-template catalog + sync | ✅ | `whatsapp.service.ts` |
| Body params (positional `{{1}}`) | ✅ | `sendTemplate` |
| Named params (`parameter_format: NAMED`) | ✅ | `TemplateVariableSet.bodyNamed` |
| TEXT / media header params | ✅ | `TemplateVariableSet.header`/`headerMedia` |
| Dynamic buttons (URL suffix / copy-code / quick-reply) | ✅ | `TemplateVariableSet.buttons` |
| Component validation (reject unknown type) | ✅ | `parseComponents` throws, no silent drop |
| Lifecycle webhooks: status update | ✅ | `message_template_status_update` |
| Lifecycle webhooks: category migration | ✅ | `template_category_update` → updates local category |
| Lifecycle webhooks: quality band | ✅ (logged) | `message_template_quality_update` — informational; a pause arrives as a status update |

Messenger / Instagram have **no** approved-template catalog (`templates:false`).

---

## Calling

| Capability | WhatsApp | Messenger | Instagram |
|---|---|---|---|
| Voice calling | ✅ (Cloud API, WebRTC) | ✅ (Messenger Calling API, GA, WebRTC) | ➖ **no Meta API** |
| `capabilities.calling` | true | **true** | false (button hidden) |
| Place / answer / reject / end | ✅ (method-per-action + webhook SDP) | ✅ (unified `POST /{page-id}/calls`, sync SDP) | ➖ |
| Permission model | our 72h ledger + `is_permanent` grants | Meta 7-day opt-in (`checkCallPermission`/`requestCallPermission`) | ➖ |
| Receive inbound calls in this inbox | ✅ (webhook) | ✅ requires `ring_target=PARTNERS` | ➖ |
| Enable/setup endpoint | `enableCalling` (Cloud API) | `enableCalling` → routing PARTNERS + call icon | ➖ |
| UI call button | ✅ | ✅ (capability-gated, channel-aware label) | hidden |

- **Instagram calling is intentionally off** — Meta ships no Instagram calling
  API as of 2026. The button is hidden by the `calling:false` capability.
- **`ring_target=PARTNERS`** on `messenger_call_settings` is REQUIRED to receive
  inbound Messenger calls here (else they only ring Meta Business Inbox).
  Set by the admin `POST /api/calls/admin/enable?channel=messenger`.
- Kill-switch `DISABLE_CALLING=1` (was `DISABLE_WHATSAPP_CALLING`, still honored)
  dark-stops call ingest for **all** channels without a redeploy.
- Video / screen-share tracks, SIP, recording, transcription, voicemail: ✋ out.
- `CALLS_SKIP_PREFLIGHT=1` (non-prod only) bypasses OUR permission/window/cap
  pre-flight for QA; Meta still enforces its own rules at `placeCall`.

---

## Customer identity (unified)

| Capability | Status | Owner |
|---|---|---|
| Contact → Customer rollup (person across channels) | ✅ | schema `Contact.customerId` |
| Auto-merge on exact phone/email (deterministic only) | ✅ | `IdentityService.resolveCustomerId` |
| Resolution at ingest hot path (immediate, not sweeper-delayed) | ✅ | `ingest.ts` (inbound + echo) run in-tx |
| Drift sweeper backstop | ✅ | `customer-link-drift.ts` |
| Manual reversible merge / split | ✅ | `CustomersService.link`/`unlink` |
| Merge / split audit trail (persisted) | ✅ | `CustomerIdentityEvent` model |
| BSUID / @username forward-compat (Meta 2026) | 🔜 columns + parse + resolve + send-address ready; NULL today | `Contact.bsuid`/`username`, `NormalizedContactIdentity` |
| Social identity enrichment (name + @username + profile_pic → avatar) | ✅ | `fetchSocialProfile` + `enrichSocialContactNames` |
| Instagram rich signals (`follower_count`, `is_verified_user`, follows-business / business-follows) | ✅ | `Contact.socialProfile` JSON → contact-panel "Instagram" row |
| Avatar durability — social `profile_pic` is a short-lived signed CDN URL, so it's **downloaded into R2** (`avatars/contact-{id}`) + served same-origin `GET /api/contacts/:id/avatar?v=<hash>`, never hotlinked | ✅ | `captureRemoteContactAvatar` |
| On-demand profile **Sync** (backfill + pull a changed photo/follower count) | ✅ | `POST /api/contacts/:id/sync-profile` → `enrichSocialContactNames({forceAvatar})`, panel ⟳ button |
| Customer avatar rendered on **every** surface (inbox list, thread header, panel, contacts page, picker, person-hub, search) | ✅ | shared `<AvatarImage>` + initials fallback |
| **Person hub** — every channel as a mini conversation row (last msg + time + unread + status), current-channel highlight, one-click open per channel, person unread total | ✅ | `CustomersService.loadProfile` + `linked-channels.tsx` |
| **Editable person name** (`Customer.name`) | ✅ | `CustomersService.rename` + `PATCH /api/customers/:id` |
| **Search dedup** — a multi-channel person shows ONCE with a clickable channel-badge cluster (not N duplicate rows) | ✅ (global search) | `searchContacts` rollup + `ContactSearchHit.channels` |
| Orphan-`Customer` reaper (CAS-miss cleanup) | ✅ | `customer-link-drift.ts` |
| Best-channel resolver wired into workflow targets — `customer` (static id) + **`trigger_customer`** (dynamic: the trigger's person, best channel) with a builder radio | ✅ | `bestChannelForCustomer` + `steps/target.ts` (`resolveCustomerBestChannel`) |
| Per-`Customer` omnichannel **broadcast** targeting — reach each PERSON once on their best live channel (deduped across channels) | ✅ | `Broadcast.targetMode='customer'` → `resolveCustomerRecipients` (`bestChannelForCustomer` per person) + per-recipient channel routing in `broadcast-runner.ts`; "People (best channel)" mode in the new-broadcast form |
| Contacts-list page rollup by `Customer` + person-level field lift | ✋ not yet — small follow-ups | — |

**What Meta actually exposes per channel** (drives what auto-populates a contact):

| Field | WhatsApp | Messenger | Instagram |
|---|---|---|---|
| Strong id | phone (real E.164) | PSID (opaque, per-page) | IGSID (opaque, per-app) |
| Display name | ✅ profile name | ✅ `name` | ✅ `name` |
| `@username` | — | — | ✅ `username` |
| Avatar | ❌ (none in webhook) | ✅ `profile_pic` | ✅ `profile_pic` |
| Phone / Email | phone = the id; no email | ❌ both | ❌ both |
| Extra signals | — | — | `follower_count`, `is_verified_user`, follow-relationship |

Consequence: **Phone/Email can never be auto-filled for Messenger/Instagram** — Meta doesn't expose them (a PSID/IGSID is deliberately opaque). Only WhatsApp yields a deterministic strong key, so cross-channel auto-merge of a social contact to a WhatsApp one is impossible from Meta data and stays manual. Enrichment is inbound-gated (runs on a new inbound); the Sync button back-fills contacts that predate it.

---

## Receive enhancements

| Enhancement | Status | Notes |
|---|---|---|
| Native-inbox social echo (`is_echo`) | ✅ | Business replies typed in Meta's own Page/IG inbox mirror into the shared inbox as outbound `origin:"business_app"` with a channel-aware "via … app" chip — the social equivalent of WhatsApp Coexistence. `meta-social.ts` + `ingestOutboundEcho` (channel-agnostic). |
| Message unsend / delete | ✅ | Customer unsend (Messenger/IG `is_deleted`) live-tombstones the bubble as "This message was deleted" (row kept, body preserved). Full pipeline: `Message.deletedAt`/`editedAt` → `NormalizedMessageCorrection` → `ingestMessageCorrection` → `message.updated` → `message:updated` socket frame → `applyMessageUpdated` reducer → `Ban` tombstone + "(edited)" marker on the bubble. WhatsApp inbound edit/revoke parse deferred (Cloud API doesn't reliably deliver it) — pipeline ready. |
| Structured media rendering | ✅ WhatsApp + Instagram | Shared location → **map-pin card** ("Open in Maps"); contact card → **vCard card**. **Instagram story mention / reply / share → a story card** (`structuredFromStory` in `meta-social.ts`). `Message.structured` (`MessageStructured` discriminated union) set at ingest, rendered by `message-bubble/structured-block.tsx`. Placeholder body still stored for search/preview. |
| Ad / deep-link attribution | ✅ WhatsApp + Messenger/Instagram | Click-to-WhatsApp/Messenger `referral` + m.me/`ref` deep-links → a **"From your ad · <headline>"** chip (links to the ad, `clickId` for ad-platform matching). `Message.attribution` (`MessageAttribution`); parse = `attributionForMessage` (WhatsApp) / `attributionFromSocialReferral` (social, message + postback level); `AdAttributionChip` bubble. |

The only receive-enhancement tail left is **WhatsApp inbound edit/revoke parse**
(Cloud API doesn't reliably deliver it — pipeline ready). Messenger/IG
ad-attribution + IG story cards are **done**, not deferred.

---

## Deliberately out of scope

Marketing / MM-Lite / max-price / ACO · marketing opt-out (`user_preferences`) ·
authentication/OTP templates · carousel/LTO/coupon/catalog templates · onboarding
automation (Embedded Signup, Facebook-Login-for-Business embedded flow,
pre-verified numbers, number registration/verify/two-step PIN, partner WABA
creation) · Groups API · Direct Send · video & screen-share calling · SIP /
recording / transcription / voicemail · Handover Protocol / `standby` /
`is_owner` thread control · page-level config (personas, custom/thread labels,
persistent menu, ice breakers, moderation, page-health).
