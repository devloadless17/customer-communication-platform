# Organization API & Webhooks

Everything an organization can automate over HTTP: the REST API you **call**, and
the webhooks we **send** you. Every example below is copy-paste-ready — set two
variables once and the rest just work.

---

## 1. Setup (do this once)

1. **Get an API key:** in the app, go to **Settings → Integrations → Organization
   API keys → Create**. Pick scopes (or **Full access**). Copy the token — it
   starts with `ccp_` and is shown only once.
2. **Export it in your shell** (this is the only place your key goes):

```bash
export CCP_API_KEY="ccp_xxxxxxxxxxxxxxxxxxxxxxxx"     # your key
export CCP_BASE_URL="https://your-app-host"          # no trailing slash, no port in prod
```

Every request authenticates with one header — `Authorization: Bearer $CCP_API_KEY`.
One key = one organization; every call is automatically scoped to your org.

**Sanity check** (lists your conversations, newest first):

```bash
curl -s "$CCP_BASE_URL/api/external/v1/conversations?limit=5" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

---

## 2. Conventions (read once, applies everywhere)

| Topic | Rule |
|---|---|
| **Base path** | `$CCP_BASE_URL/api/external/v1` |
| **Auth** | `Authorization: Bearer $CCP_API_KEY` on every request |
| **Scopes** | Each route needs a scope (listed per endpoint). A **Full access** key has all of them. |
| **Idempotency** | The two **send** routes **require** an `Idempotency-Key` header — reuse the same value on a retry and we won't double-send. Use something stable per logical send (e.g. the inbound message id). |
| **Rate limit** | Per key. Send routes are capped at 60/min. |
| **24-hour window** | Free-form text/media only sends to a customer who messaged you in the last 24h. Outside it, use a **template**. |
| **Pagination** | List routes take `?limit=&cursor=`. The response includes `nextCursor` (null when done) — pass it back as `cursor`. |
| **Errors** | Non-2xx returns `{ "error": "code", "detail": "..." }`. |
| **`silent`** | Mutating routes accept `"silent": true` to suppress the webhook/automation echo for that write — use it when your own flow would otherwise loop. |

---

## 3. Contacts

A contact is one WhatsApp identity. Scopes: `read:contacts`, `write:contacts`, `delete:contacts`.

**List / find contacts** — `GET /contacts` · `read:contacts`
Filters (all optional, exact-match unless noted): `phone`, `email`, `externalContactId`, `search` (fuzzy across name/phone/email), `stageId`, `tagIds` (comma-separated, ANY-match), `limit`, `cursor`.
```bash
curl -s "$CCP_BASE_URL/api/external/v1/contacts?search=ali&limit=20" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**Get one contact** — `GET /contacts/:id` · `read:contacts`
```bash
curl -s "$CCP_BASE_URL/api/external/v1/contacts/CONTACT_ID" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**Create a contact** — `POST /contacts` · `write:contacts`
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/contacts" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+96170123456",
    "name": "Ali Hassan",
    "email": "ali@example.com",
    "countryCode": "LB",
    "tagIds": [],
    "customFields": { "company": "Acme" }
  }'
```

**Find-or-create (upsert by phone)** — `POST /contacts/upsert` · `write:contacts`
Same body as create. If the phone exists, fields are merged and `tagIds` are **added** (never removed).
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/contacts/upsert" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "phoneNumber": "+96170123456", "name": "Ali Hassan" }'
```

**Update a contact** — `PATCH /contacts/:id` · `write:contacts`
Any subset of fields. Send `null` to clear an optional field. `phoneNumber` is immutable (it's the identity).
```bash
curl -s -X PATCH "$CCP_BASE_URL/api/external/v1/contacts/CONTACT_ID" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "email": "new@example.com", "stageId": "STAGE_ID" }'
```

**Delete a contact** — `DELETE /contacts/:id` · `delete:contacts`
Soft delete — removes from the directory; conversation history is preserved.
```bash
curl -s -X DELETE "$CCP_BASE_URL/api/external/v1/contacts/CONTACT_ID" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**List a contact's channels** — `GET /contacts/:id/channels` · `read:contacts`
```bash
curl -s "$CCP_BASE_URL/api/external/v1/contacts/CONTACT_ID/channels" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

### Tagging

**Add tags to one contact** — `POST /contacts/:id/tags` · `write:contacts`
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/contacts/CONTACT_ID/tags" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "tagIds": ["TAG_ID_1", "TAG_ID_2"] }'
```

**Remove one tag** — `DELETE /contacts/:id/tags/:tagId` · `write:contacts`
```bash
curl -s -X DELETE "$CCP_BASE_URL/api/external/v1/contacts/CONTACT_ID/tags/TAG_ID" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**Remove several tags from one contact** — `POST /contacts/:id/tags/remove` · `write:contacts`
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/contacts/CONTACT_ID/tags/remove" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "tagIds": ["TAG_ID_1", "TAG_ID_2"] }'
```

**Bulk add / remove tags across many contacts** — `POST /contacts/tags/add` · `POST /contacts/tags/remove` · `write:contacts`
Up to 500 contacts per call. Add `"silent": true` if your own flow triggered this (avoids a webhook loop).
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/contacts/tags/add" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "contactIds": ["C1","C2"], "tagIds": ["TAG_ID"] }'
```

---

## 4. Conversations

One conversation per contact (closed threads reopen, never fork). Scopes: `read:conversations`, `write:conversations`.

**List conversations** — `GET /conversations` · `read:conversations`
Optional: `phone`, `status` (`open|pending|closed`), `limit`, `cursor`.
```bash
curl -s "$CCP_BASE_URL/api/external/v1/conversations?status=open&limit=50" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**Get one conversation** — `GET /conversations/:id` · `read:conversations`
Returns contact, assignee, status, channel.
```bash
curl -s "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**Assign / unassign** — `POST /conversations/:id/assign` · `write:conversations`
`assignedUserId` = a teammate id, or `null` to unassign.
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/assign" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "assignedUserId": "USER_ID" }'
```

**Change status** — `POST /conversations/:id/status` · `write:conversations`
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/status" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "closed" }'
```

**Toggle AI Autopilot** — `POST /conversations/:id/ai` · `write:conversations`
Set `false` to hand the thread to a human (every later `message.received` then carries `ai_enabled: false`).
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/ai" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "aiEnabled": false, "silent": true }'
```

**By contact id** (no conversation lookup needed) — `POST /contacts/:id/assign` and `POST /contacts/:id/status` · `write:conversations`
Same bodies as above; we resolve the contact's conversation for you.
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/contacts/CONTACT_ID/status" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "open" }'
```

---

## 5. Messages & notes

Scopes: `read:messages`, `write:messages`, `write:notes`. **Sends require `Idempotency-Key`.**

**Send by contact (find-or-open conversation)** — `POST /messages` · `write:messages`
Address by `{ "id": "..." }` or `{ "phone": "+..." }`. Provide exactly one of `text` / `media` / `template`.
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/messages" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "contact": { "phone": "+96170123456" },
    "text": "Hi! Thanks for reaching out."
  }'
```
Media instead of text:
```bash
  -d '{ "contact": { "phone": "+96170123456" },
        "media": { "url": "https://example.com/file.jpg", "mime_type": "image/jpeg", "caption": "optional" } }'
```
Template (works **outside** the 24h window):
```bash
  -d '{ "contact": { "phone": "+96170123456" },
        "template": { "name": "hello_world", "language": "en_US", "variables": { "body": ["Ali"] } } }'
```

**Reply inside a conversation** — `POST /conversations/:id/messages` · `write:messages`
Free-form text; `replyToMessageId` to quote. Only inside the 24h window.
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "body": "On our way!" }'
```

**Get one message** — `GET /messages/:id` · `read:messages`
```bash
curl -s "$CCP_BASE_URL/api/external/v1/messages/MESSAGE_ID" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**List messages in a conversation** — `GET /conversations/:id/messages` · `read:messages`
Optional `limit`, `cursor`.
```bash
curl -s "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/messages?limit=50" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**Add an internal note** (never sent to WhatsApp) — `POST /conversations/:id/notes` · `write:notes`
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/notes" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "body": "Customer prefers WhatsApp over email." }'
```

---

## 6. Catalog (tags, fields, stages, channels, users)

Reference data for the routes above. Scopes: `read:catalog`, `write:catalog`.

| Action | Request |
|---|---|
| List tags | `GET /tags` |
| Create tag | `POST /tags` — `{ "name": "VIP", "color": "sky" }` |
| Update tag | `PATCH /tags/:id` — `{ "name": "...", "color": "..." }` |
| Delete tag | `DELETE /tags/:id` |
| List custom fields | `GET /contact-fields` |
| Get a field (by id or key) | `GET /contact-fields/:idOrKey` |
| Create a field | `POST /contact-fields` — `{ "label": "Company" }` |
| List stages | `GET /stages` |
| List channels | `GET /channels` |
| List teammates | `GET /users` |
| Get a teammate (by id or email) | `GET /users/:idOrEmail` |

Tag `color` must be one of: `slate`, `rose`, `amber`, `emerald`, `sky`, `violet`, `pink`, `lime`, `orange`.

```bash
# Example: list tags, then create one
curl -s "$CCP_BASE_URL/api/external/v1/tags" -H "Authorization: Bearer $CCP_API_KEY"

curl -s -X POST "$CCP_BASE_URL/api/external/v1/tags" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "VIP", "color": "sky" }'
```

---

## 7. Outbound webhooks (events we send you)

**Set up:** **Settings → Integrations → Webhooks → Create** — paste your receiving URL,
pick the events. We generate a signing secret (`ccp_whsec_…`) shown once.

**Every delivery is a `POST` of JSON** with these headers:

| Header | Meaning |
|---|---|
| `X-CCP-Event` | the event type (e.g. `message.received`) |
| `X-CCP-Delivery` | unique id for this delivery — **use it to dedupe** (we deliver at-least-once) |
| `X-CCP-Signature` | `t=<unix-seconds>,v1=<hmac>` — verify it (below) |
| `X-CCP-Depth` | loop-guard hop count — see "Loop safety" below |

> **Loop safety (required if your automation calls our API back).** If a webhook
> handler turns around and calls the `/v1` API (e.g. auto-reply, tag, status),
> you **must forward the `X-CCP-Depth` header verbatim** on that call. We
> increment it each hop and reject at depth 8 (`429 chain_depth_exceeded`), which
> is what breaks an accidental webhook → API → webhook loop. Without forwarding,
> the only backstop is the per-conversation send rate limit (30/min) — bounded,
> but it can burn real WhatsApp sends before it trips. Set `"silent": true` on
> the mutating call to also suppress the echo webhook for that write.

**Events:** `message.received`, `message.sent`, `message.status_changed`,
`conversation.assigned`, `conversation.opened`, `conversation.closed`,
`conversation.status_changed`, `conversation.ai_changed`, `contact.created`,
`contact.updated`, `contact.tag_changed`, `contact.lifecycle_changed`,
`contact.deleted`, `note.created`, `note.deleted`.

**Example body — `message.received`:**
```jsonc
{
  "team_id": "...",
  "timestamp": 1718539200000,          // event time (epoch ms), on EVERY event
  "event_type": "message.received",
  "contact":  { "id": "...", "phoneNumber": "+961...", "name": "...", "tagIds": [], "customFields": {} },
  "assignee": null,
  "ai_enabled": true,
  "conversation": { "id": "...", "status": "open", "unreadCount": 1,
                    "isNewConversation": false, "reopened": false },
  "message": {
    "messageId": "...",                // good Idempotency-Key for your reply
    "conversationId": "...",           // reply target (= conversation.id)
    "contactId": "...",
    "message": { "type": "text", "text": "Hi" },
    "media": null                      // { url, kind, caption } on media messages
  },
  "channel": { "id": "...", "name": "...", "waId": "961...", "profileName": "..." },
  "sender":  { "source": "contact", "apiKeyId": null }
}
```
`message.sent` is the same minus the inbound-only flags. The other events carry
top-level `conversationId`/`contactId`, the changed fields, and `changedBy`
attribution.

**Verify the signature** (reject forged/replayed deliveries) — Node example:
```js
const crypto = require("crypto");
function verify(rawBody, header, secret) {
  const [, t, , sig] = header.match(/t=(\d+),v1=([0-9a-f]+)/) || [];
  if (!t) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // >5 min old → reject
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```
Sign over the **raw request bytes** — don't re-serialize the parsed JSON.

---

## 8. Integrations

- **n8n (AI Autopilot):** step-by-step flow — receive `message.received`, branch on
  `ai_enabled`, reply via `POST /conversations/:id/messages`, hand off to a human.
  See **[n8n-ai-autopilot.md](n8n-ai-autopilot.md)**.
- **Postman:** import **[postman/ccp-org-api.postman_collection.json](postman/ccp-org-api.postman_collection.json)**
  and the local environment, set `apiKey`, and every request above is ready to click.

---

*Need a field that isn't here? Every list/get response is intentionally rich
(full contact, conversation state, message + media). If something's missing,
it's a bug — file it.*
