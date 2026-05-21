# External API + Webhook payload consistency pass (2026-05-20)

Status: implemented, awaiting deploy. **Breaking** changes to the `/v1` contract
(intentional — pilot stage, chosen clean-over-compat).

## What changed & why

Three gaps reported: (1) contact info present on some responses, missing on
others; (2) message media gave `kind: "image"` but no URL / mime / filename;
(3) assignee was a bare id with no name.

### Assignee → object (replaces bare id)
Everywhere an assignee/account-manager appears, it's now a hydrated object (or
`null`), not an id:
```json
"assignee": { "id": "usr_abc", "name": "Sara Kassem", "email": "sara@acme.com" }
```
- `/v1`: `ExternalContact.assignedUserId` and `ExternalConversation.assignedUserId`
  are **removed**; both now carry `assignee`.
- Webhooks already used assignee objects (`conversation.assigned`,
  `contact.assignee_changed`); unchanged.

### Media → object (replaces flat kind/caption)
Messages now carry a full `media` object (or `null` for text):
```json
"media": {
  "kind": "image",
  "url": "https://utfs.io/f/…",        // public CDN, directly downloadable
  "mimeType": "image/png",              // → derive the extension
  "filename": "invoice.pdf",            // documents only; null for camera media
  "sizeBytes": 48213,
  "durationMs": null,                   // audio/video only
  "thumbnailUrl": null,
  "caption": "see attached"
}
```
- `/v1`: `ExternalMessage.mediaKind` + `mediaCaption` **removed** → `media`.
  URL is `Message.mediaUrl` (raw CDN) — fetchable with no session.
- Webhooks: `PublicMessage.media_kind` + `media_caption` **removed** → `media`
  (snake_case fields). `url` + `thumbnail_url` are filled by the subscriber
  from the CDN columns (the framework-agnostic mapper can't query the DB —
  same enrichment role as `channel`).

### Contact consistency
- `/v1`: every **conversation** now embeds its `contact` (+ assignee). So
  `GET /v1/conversations`, `GET /v1/conversations/:id`, `GET /v1/conversations/:id/messages`,
  and `GET /v1/messages/:id` all carry the contact. Message-primary responses
  return `{ message, conversation }` so contact context is one hop, never zero.
- Webhooks: `message.received` already embeds full contact. `message.sent`
  keeps **contact_id only** — deliberate (see `MessageSentEvent` doc-comment:
  the outbound echo is kept lightweight, no DB roundtrip; the partner usually
  initiated the send and has context). Override later if a partner needs it.

## Files touched
- `apps/api/src/lib/external-shapes.ts` — new `ExternalAssignee`, `ExternalMedia`;
  reshaped serializers; `EXTERNAL_CONTACT_INCLUDE` / `EXTERNAL_CONVERSATION_INCLUDE`
  shared Prisma includes (root-cause fix: every query now hydrates the same relations).
- `apps/api/src/external/v1/external-v1.service.ts` — all contact reads use the
  shared include + `contactRowToExternal`.
- `apps/api/src/external/v1/external-v1-messaging.service.ts` — conversations +
  message-list/get embed contact via `conversationRowToExternal`.
- `packages/shared/src/outbound-webhooks/public-events.ts` — `PublicMedia`;
  `PublicMessage.media`.
- `apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts` —
  `enrichMediaUrls()` fills CDN urls (one batched lookup per event).

## Follow-ups (not done)
- Webhook `message.received` embeds a conversation whose `assignee` is an
  object with `name`/`email` = null (it only has the id from the event). Rare
  (new inbound threads are usually unassigned). Hydrate via subscriber if a
  partner asks.
- `message.sent` full-contact embed (see above) — deliberate omission.
