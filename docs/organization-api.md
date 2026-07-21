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
| **Idempotency** | The three **send** routes (`POST /messages`, `POST /conversations/:id/messages`, `POST /conversations/:id/interactive`) **require** an `Idempotency-Key` header — reuse the same value on a retry and we won't double-send. Use something stable per logical send (e.g. the inbound message id). |
| **Rate limit** | **60 req/min per key**, across *all* routes — over it returns `429 {"error":"rate_limited"}`. Sends carry an extra **30/min per conversation** loop-guard, and the bulk tag routes (`POST /contacts/tags/add\|remove`) are additionally capped at **20/min per key**. Missing/bad keys are throttled separately at 30/min per IP. |
| **24-hour window** | Free-form text/media only sends to a customer who messaged you within the channel's window (WhatsApp 24h; Messenger/Instagram 24h + a 7-day human-agent extension). Outside it, WhatsApp needs a **template**; Messenger/Instagram have no templates — wait for the customer to message again. |
| **Pagination** | List routes take `?limit=&cursor=`. The response includes `nextCursor` (null when done) — pass it back as `cursor`. |
| **Errors** | Non-2xx returns `{ "error": "code", "detail": "..." }`. Common: `401` (missing/invalid key), `403 insufficient_scope` (key lacks the route's scope), `404` (not found / wrong org), `409 duplicate_phone` (create on an existing number), `422`/`400` (validation), `429 rate_limited` / `chain_depth_exceeded`. |
| **`silent`** | Mutating routes accept `"silent": true` to suppress the webhook/automation echo for that write — use it when your own flow would otherwise loop. |

---

## 3. Contacts

A contact is one channel identity (a WhatsApp number, a Messenger PSID, an Instagram IGSID). Scopes: `read:contacts`, `write:contacts`, `delete:contacts`.

**List / find contacts** — `GET /contacts` · `read:contacts`
Filters (all optional, exact-match unless noted): `phone`, `email`, `externalContactId`, `search` (fuzzy across name/phone/email), `stageId`, `tagIds` (comma-separated, ANY-match), `limit`, `cursor`.
```bash
curl -s "$CCP_BASE_URL/api/external/v1/contacts?search=ali&limit=20" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

> **Directory scope.** This endpoint returns only *directory* contacts, matching the
> in-app contacts list. **Anonymous website-widget visitors are excluded** from both
> the natural-key lookups and the browse path: a visitor's identity is a per-browser
> session token with no durable address, so they can't be re-reached, and the
> phone/email they may have typed into a public pre-chat form is unverified — it must
> not answer a "who is +961…?" lookup. A visitor who submits a phone or email is
> **promoted** and appears in the list normally from then on.

**Get one contact** — `GET /contacts/:id` · `read:contacts`
Resolves an anonymous widget visitor too — unlike a soft-deleted contact, the thread
is live and an integrator legitimately holds the id from a `message.received` webhook.
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

**Change a contact's stage** — `POST /contacts/:id/stage` · `write:contacts`
Move a contact along the lifecycle pipeline (Lead → Customer → …) — the same action as the UI's stage picker, and the discoverable sibling of assign/status. Look the target id up via `GET /stages`. This fires the **On Contact Lifecycle updated** workflow trigger, writes the stage-change pill into the conversation timeline, and emits the `contact.lifecycle_changed` outbound webhook — full parity with the UI. (It delegates to `PATCH /contacts/:id`, so sending `{ "stageId": "…" }` there does the same; use PATCH with `{ "stageId": null }` to clear a stage.)
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/contacts/CONTACT_ID/stage" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "stageId": "STAGE_ID" }'
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


### Bulk import / export (CSV + Excel)

The same jobs the in-app Contacts page runs. Both directions are **asynchronous**: you get a job id back immediately, poll it, then download the artifact. A 100,000-contact export is a normal thing to ask for here.

**Queue an export** — `POST /contacts/export` · `read:contacts` · 5/min
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/contacts/export" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "format": "xlsx", "filters": { "stageId": "STAGE_ID", "tagIds": ["TAG_ID"] } }'
# → { "jobId": "..." }
```
`format` is `csv` (default) or `xlsx`. Omit `filters` to export the whole directory, or pass `"ids": ["C1","C2"]` to export an explicit set. Anonymous website-widget visitors (no phone, no email) are never included — they aren't directory contacts.

**Upload a file to import** — `POST /contacts/import/upload` · `write:contacts` · 10/min
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/contacts/import/upload" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -F "file=@contacts.xlsx"
# → { "uploadKey": "...", "headers": [...], "suggestedMapping": {...}, "sampleRows": [...], "format": "xlsx" }
```
Up to 50 MB. The format is detected from the file's CONTENT, not its name. `suggestedMapping` is our guess at which column is which — send it back as-is, or edit it first.

**Queue the import** — `POST /contacts/import` · `write:contacts` · 5/min · **`Idempotency-Key` required**
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/contacts/import" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
        "uploadKey": "UPLOAD_KEY_FROM_ABOVE",
        "format": "xlsx",
        "mode": "create_and_update",
        "tagMode": "merge",
        "fireAutomations": true,
        "mapping": { "Mobile": "phone_number", "Company Name": "field:company" }
      }'
# → { "jobId": "..." }
```

| Field | Values | Meaning |
|---|---|---|
| `mode` | `create_only` (default) · `create_and_update` · `update_only` | What to do when the phone number already exists |
| `tagMode` | `merge` (default) · `replace` | Add to the contact's tags, or replace them |
| `fireAutomations` | `true` (default) · `false` | Publish per-contact events, so workflows and outbound webhooks fire |
| `mapping` | `{ "<header>": "<target>" }` | `ignore`, a built-in column id (`phone_number`, `name`, `email`, `tags`, `stage`, …), or `field:<key>` for a custom field |

Rules worth knowing before you rely on them:

- **Contacts are matched on phone number**, and imported rows are created as WhatsApp contacts. Phone is the only identity a spreadsheet can carry; social channels key on a vendor-issued id.
- **An imported email is never used to merge people.** It's stored on the contact, but only a self-asserted address (via the in-chat contact-share chip) counts as a strong identity key. A hand-typed address in a spreadsheet cannot fold two customers into one.
- **Blank cells never erase data.** In `create_and_update`, only non-empty cells are written; a column you left empty leaves the existing value alone.
- **Above 5,000 rows, `fireAutomations` is forced off.** A 100k-row import would otherwise queue 100k workflow runs and 100k webhook deliveries. The response's `automationsSkipped` tells you it happened.
- Limits: 200,000 rows per import, 100 new tags auto-created per import, 100 custom-field columns.

**Check a job** — `GET /contacts/transfers/:id` · `read:contacts`
```bash
curl -s "$CCP_BASE_URL/api/external/v1/contacts/transfers/JOB_ID" \
  -H "Authorization: Bearer $CCP_API_KEY"
```
```json
{ "job": { "id": "...", "kind": "import", "status": "completed",
           "processedRows": 100000, "totalRows": 100000,
           "created": 240, "updated": 99500, "revived": 0, "skipped": 250, "failed": 10,
           "automationsSkipped": true, "hasArtifact": false, "hasErrorReport": true,
           "details": { "unknownColumns": [], "unknownStages": [], "extraSheets": [] } } }
```
`status` is `pending` · `running` · `completed` · `failed` · `canceled`.

**List recent jobs** — `GET /contacts/transfers?limit=20&kind=export` · `read:contacts`

**Download** — `GET /contacts/transfers/:id/download` · `read:contacts`
Redirects (302) to a short-lived signed URL. Follow it, or read the `Location` header.
```bash
curl -sL "$CCP_BASE_URL/api/external/v1/contacts/transfers/JOB_ID/download" \
  -H "Authorization: Bearer $CCP_API_KEY" -o contacts.xlsx
```

**Download the rows that failed** — `GET /contacts/transfers/:id/errors` · `read:contacts`
Same redirect. The file has your original columns plus `_row` and `_error`, in the format you uploaded — fix it and re-import that file directly.

**Cancel** — `POST /contacts/transfers/:id/cancel` · `write:contacts`
Stops within a batch. Rows already imported stay imported; the counters tell you how many.

> Files (exports, uploads, and error reports) are **deleted after 7 days**.

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

**Assign / unassign / auto-route** — `POST /conversations/:id/assign` · `write:conversations`

| Body | Effect |
|---|---|
| `{ "assignedUserId": "USER_ID" }` | assign to that teammate |
| `{ "assignedUserId": null }` | unassign (back to the triage queue) |
| `{ "autoAssign": true }` | route with the team's assignment rules → default policy |
| `{ "autoAssign": true, "policyId": "POLICY_ID" }` | route with a named policy |

`autoAssign` runs the same engine the inbox, the AI handoff and workflows use —
strategy, weights, per-agent limits and eligibility all apply, so an integration
can't route in a way the org's settings forbid. It takes precedence over
`assignedUserId` when both are sent.

Add `"overwrite": false` to make it fill-an-empty-assignee-only (an explicit API
call reassigns by default). When nobody is eligible — everyone offline or at
their limit — the call still returns `200` and the conversation stays in the
Unassigned queue: that's the policy's configured outcome, not an error.

```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/assign" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "autoAssign": true }'
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
Media instead of text — **ROADMAP, not yet supported.** URL-based media send via `/v1/messages` currently returns `400 media_not_yet_supported`; the URL → upload → send pipeline is on the roadmap. Send media via the inbox UI for now.

> **UI send types not yet exposed on `/v1` (roadmap, tracked exceptions to the UI↔API parity rule):** direct **media upload**, **location**, **contact-card**, **reaction** (and dismiss), and **message forward**. These exist in the inbox composer but have no `/v1` twin yet. Text, template, and interactive sends have full `/v1` parity. Use the inbox UI for the above until they land.
```bash
# NOT YET SUPPORTED — returns 400 media_not_yet_supported
  -d '{ "contact": { "phone": "+96170123456" },
        "media": { "url": "https://example.com/file.jpg", "mime_type": "image/jpeg", "caption": "optional" } }'
```
Template (works **outside** the 24h window):
```bash
  -d '{ "contact": { "phone": "+96170123456" },
        "template": { "name": "hello_world", "language": "en_US", "variables": { "body": ["Ali"] } } }'
```

**Reply inside a conversation** — `POST /conversations/:id/messages` · `write:messages`
Free-form text; `replyToMessageId` to quote. Only inside the 24h window. Sending into a **closed** thread reopens it (closed → pending) once the send lands — same as an inbox reply and the top-level `POST /messages` route.
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "body": "On our way!" }'
```

**Send an interactive message** — `POST /conversations/:id/interactive` · `write:messages`
Tappable options (`kind: "buttons"`, or `kind: "list"` for up to 10) plus, on Messenger/Instagram only, Meta's one-tap **consent chips** that let the customer share their phone or email straight from their Meta profile. Those chips are the only way a social contact's phone/email ever reaches you — and therefore the only email that will auto-merge them into a unified customer.

Option `id`s and `title`s must each be unique (Meta rejects duplicate button titles). Requires an `Idempotency-Key`. Sending into a **closed** thread reopens it (closed → pending) once the send lands — same as the text send routes. WhatsApp has no consent chips and returns `422 contact_share_not_supported` if you ask for them.
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/interactive" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "body": "How would you like your order?",
        "kind": "buttons",
        "options": [ { "id": "pickup",  "title": "Pick up" },
                     { "id": "deliver", "title": "Deliver" } ],
        "contactShare": ["phone"] }'
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

**Add an internal note** (never sent to the customer) — `POST /conversations/:id/notes` · `write:notes`
`authorUserId` is **required** — it must be the id of a team member (from `GET /users`). Create a dedicated service-account user for your integration if no human author applies.
```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/notes" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "body": "Customer prefers WhatsApp over email.", "authorUserId": "USER_ID" }'
```

**Delete an internal note** — `DELETE /conversations/:id/notes/:noteId` · `write:notes`
Removes the note and fires the `note.deleted` webhook (symmetric with the create above, so a CRM mirror can complete a create→delete round-trip). Idempotent — deleting an already-removed note returns `404 note_not_found`.
```bash
curl -s -X DELETE "$CCP_BASE_URL/api/external/v1/conversations/CONVERSATION_ID/notes/NOTE_ID" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

---

## 5b. Message flags (triage)

A **message flag** marks ONE message as needing follow-up of a named kind — "Complaint", "Refund request", "Bug report" — and carries a lifecycle:

```
open  →  resolved      (it was a real one AND it was handled)
      →  dismissed     (it was NOT actually one — a mis-flag)
```

Deliberately distinct from contact **tags**: a tag labels a *person* and drives broadcast audiences; a flag labels a *message* and has an open/resolved state you can report on. Keeping `dismissed` separate from `resolved` means "how many complaints did we get" never counts the non-complaints.

**Routing work into another system.** This is the seam for that: subscribe to the `message.flag_changed` webhook (§9), route on `flag.definitionName`, then use the endpoints below to read the backlog and mark items handled from your own tooling. No polling required.

Scopes: `read:flags`, `write:flags`. The flag *catalog* stays under `read:catalog` with every other catalog.

### The queue

**`GET /message-flags`** · `read:flags`

Newest-first, keyset-paginated. Each row carries the contact name, channel and a message excerpt, so a worklist renders without a second call.

| Query param | Meaning |
|---|---|
| `status` | Repeatable or comma-joined: `open` \| `resolved` \| `dismissed`. Defaults to `open`. |
| `definitionId` | Repeatable or comma-joined. |
| `assignedTo` | A user id, or the literal `unassigned`. |
| `conversationId` | Narrow to one thread. |
| `cursor` / `take` | Keyset pagination; `take` max 50. |

```bash
curl -s "$CCP_BASE_URL/api/external/v1/message-flags?status=open&take=50" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

```json
{
  "items": [
    {
      "id": "cmpflag_01",
      "messageId": "cmpmsg_01",
      "conversationId": "cmpconv_01",
      "contactId": "cmpcon_01",
      "contactName": "Layla H.",
      "channel": "whatsapp",
      "messageExcerpt": "This is the third time the order arrived late…",
      "messageTimestamp": "2026-07-22T11:04:12.000Z",
      "definition": { "id": "cmpflagdef_01", "name": "Complaint", "color": "rose", "description": null, "archived": false, "sortOrder": 0 },
      "status": "open",
      "source": "human",
      "confidence": null,
      "note": "Second time this month.",
      "assignedToId": null,
      "assignedToName": null,
      "resolvedById": null,
      "resolvedByName": null,
      "resolvedAt": null,
      "resolutionNote": null,
      "createdById": "cmpusr_01",
      "createdByName": "Sara",
      "createdAt": "2026-07-22T11:05:00.000Z",
      "updatedAt": "2026-07-22T11:05:00.000Z"
    }
  ],
  "nextCursor": null
}
```

**`GET /message-flags/counts`** · `read:flags` — open counts, team-wide and per definition.

**`GET /message-flag-definitions`** · `read:catalog` — the catalog (archived included). Resolve names to ids once and cache.

### Raising a flag

**`POST /messages/:messageId/flags`** · `write:flags`

Provide **exactly one** of `definitionId` or `definitionName` — the name form exists so your config can say `"Complaint"` rather than a cuid. Optional `note`, `assignedToId`.

**Idempotent by construction**: there can be at most one flag of a given kind per message, so no `Idempotency-Key` is required and a retry converges on the same row instead of duplicating. Re-raising a *resolved* flag reopens it (the same complaint came back).

```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/messages/MESSAGE_ID/flags" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "definitionName": "Complaint", "note": "Second time this month." }'
```

Returns `{ "flag": { … }, "openFlagCount": 1 }` — `openFlagCount` is the parent conversation's unresolved-flag count after the change.

### Resolving / reassigning

**`PATCH /message-flags/:flagId`** · `write:flags`

Any subset of `status`, `assignedToId` (`null` unassigns), `note`, `resolutionNote`.

```bash
curl -s -X PATCH "$CCP_BASE_URL/api/external/v1/message-flags/FLAG_ID" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "resolved", "resolutionNote": "Refund issued, ticket #4192" }'
```

Concurrency-safe: two clients resolving the same flag both succeed, and the open count moves exactly once.

**`DELETE /message-flags/:flagId`** · `write:flags` — remove a flag entirely ("flagged by mistake"). Different from `dismissed`, which keeps the record that someone looked and decided it wasn't one.

| Error | Meaning |
|---|---|
| `404 message_not_found` | No such message in your org. |
| `404 flag_not_found` | No such flag in your org. |
| `404 message_flag_definition_not_found` | Unknown `definitionId` / `definitionName`. |
| `409 message_flag_definition_archived` | That flag kind was retired and can't be raised any more. |
| `400 assignee_not_found` | `assignedToId` isn't an active member of your org. |

---

> **Note on unified customers:** merging/splitting a `Customer` (linking channel contacts into one person) is currently a **UI-only** capability — there is no `/v1` customers resource yet. Auto-merge on a self-asserted strong key (exact phone/email) still happens automatically at ingest. Programmatic merge/split is a planned addition; until then, reconcile identities in the inbox.

> **Note on broadcasts:** *creating* a broadcast is a **UI-only** capability — there is deliberately no `write:broadcasts` scope (billed template sends are irreversible), so to reach many contacts programmatically today you iterate the send routes above (each with its own `Idempotency-Key`). Read-only campaign/report/recipient endpoints **do** exist — see the [Broadcasts](#7-broadcasts-campaign-reporting) section below.

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
| Set a contact's stage | `POST /contacts/:id/stage` — `{ "stageId": "…" }` (see §3) |
| List channels | `GET /channels` |
| List teammates | `GET /users` |
| Get a teammate (by id or email) | `GET /users/:idOrEmail` |

Tag `color` must be one of: `slate`, `rose`, `amber`, `emerald`, `sky`, `violet`, `pink`, `lime`, `orange`.

### Teammate availability & working hours

Scope: `write:users` (reads stay under `read:catalog`).

| Action | Request |
|---|---|
| Set a member's status | `PATCH /users/:id/availability` — `{ "status": "busy", "message": "On a call" }` |
| Return them to their schedule | `PATCH /users/:id/availability` — `{ "followSchedule": true }` |
| Set their working hours | `PUT /users/:id/work-hours` — `{ "mode": "custom", "workHours": { … } }` |

`GET /users` and `GET /users/:idOrEmail` return the member's **effective**
availability plus its provenance:

| Field | Meaning |
|---|---|
| `availabilityStatus` | `available` · `busy` · `away` · `offline` — what teammates see |
| `availabilityMessage` | The note shown next to the status |
| `availabilitySource` | `manual` (they picked it) · `admin` (someone set it for them) · `schedule` (their working hours) |
| `availabilityUntil` | ISO instant a manual/admin pick expires back to the schedule |
| `workHoursMode` | `inherit` (org schedule) · `custom` · `off` |
| `workHours` | Their own schedule, when `mode = custom` |

**Working hours** are `{ timezone, weekly, exceptions? }`. `weekly` maps
`mon`…`sun` to up to 4 windows (a split shift); a missing or empty day is a day
off, and a window whose `close` is at or before its `open` (`22:00`–`06:00`)
runs overnight. `exceptions` are dated overrides:
`{ "date": "2026-08-15", "closed": true }`.

Outside their hours a member automatically shows as `away` with an "Outside
working hours" note and drops out of the preferred round-robin tiers; inside
them they come back automatically. (They aren't excluded outright — the
last-resort tier still exists so a conversation is never left unowned when the
whole team is off shift.)

A manual or admin pick outranks the schedule only **until the next shift
boundary**, so a status set mid-shift can't outlive the day:

| Situation | When the pick expires |
|---|---|
| No schedule (`mode: "off"`, or no org schedule) | Never — it holds until changed |
| A normal schedule | At the next boundary (shift end if on shift, shift start if off) |
| A 24/7 schedule (never closes) | At the next local midnight in the schedule's timezone |
| The schedule is edited while the pick is live | Re-anchored to the new schedule's next boundary |

Send `{ "followSchedule": true }` to drop the override immediately instead of
waiting for it to expire.

```bash
# Mark a member busy — expires at the end of their shift
curl -s -X PATCH "$CCP_BASE_URL/api/external/v1/users/$USER_ID/availability" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "busy", "message": "In a meeting" }'

# Put them on a Mon–Fri 09:00–17:00 Beirut schedule
curl -s -X PUT "$CCP_BASE_URL/api/external/v1/users/$USER_ID/work-hours" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "mode": "custom",
        "workHours": {
          "timezone": "Asia/Beirut",
          "weekly": {
            "mon": [{ "open": "09:00", "close": "17:00" }],
            "tue": [{ "open": "09:00", "close": "17:00" }],
            "wed": [{ "open": "09:00", "close": "17:00" }],
            "thu": [{ "open": "09:00", "close": "17:00" }],
            "fri": [{ "open": "09:00", "close": "17:00" }]
          }
        }
      }'
```

```bash
# Example: list tags, then create one
curl -s "$CCP_BASE_URL/api/external/v1/tags" -H "Authorization: Bearer $CCP_API_KEY"

curl -s -X POST "$CCP_BASE_URL/api/external/v1/tags" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "VIP", "color": "sky" }'
```

---

## 6b. Assignment routing

Full parity with **Settings → Assignment**: everything the UI can configure, the
API can. Read: `read:catalog`. Write: `write:catalog`.

A **policy** decides *how* to pick someone (strategy, per-member share, limits,
who's eligible). A **rule** decides *which policy* applies to a given
conversation — checked top to bottom, first match wins, with the default policy
as the fallback. **Settings** decide *when* routing runs at all.

**Read everything** — `GET /assignment`
Returns `{ policies, rules, settings, members }`; each member carries their live
`openCount`, which is what a capacity limit is measured against.

**Create / update a policy** — `POST /assignment/policies` · `PUT /assignment/policies/:id`

| Field | Values |
|---|---|
| `strategy` | `least_busy` (default) · `round_robin` · `weighted` · `fixed` · `manual` |
| `eligibility` | `online_first` (default) · `online_only` · `available_only` · `any_active` |
| `overflow` | `leave_unassigned` (default) · `ignore_capacity` · `fallback_user` |
| `eligibleRoles` | `[]` = every role, or e.g. `["agent"]` |
| `includeAllMembers` | `true` (rows are per-member tuning) / `false` (rows are the squad) |
| `defaultMaxOpen` | concurrent open-conversation cap; `null` = no limit |
| `members[]` | `{ userId, weight, maxOpen, enabled }` |

`PUT` requires `expectedVersion` (the value from the last read). A stale version
returns `409 version_conflict` rather than silently overwriting a co-admin's
edit.

```bash
# "Support — weighted": Ali gets 50 of every 70, Sara 20, nobody over 25 open.
curl -s -X POST "$CCP_BASE_URL/api/external/v1/assignment/policies" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Support — weighted",
        "strategy": "weighted",
        "eligibility": "online_first",
        "defaultMaxOpen": 25,
        "overflow": "leave_unassigned",
        "members": [
          { "userId": "ALI_ID",  "weight": 50, "enabled": true },
          { "userId": "SARA_ID", "weight": 20, "enabled": true }
        ]
      }'
```

**Make a policy the default** — `POST /assignment/policies/:id/default`
**Archive a policy** — `DELETE /assignment/policies/:id` (the default can't be archived)

**Routing rules** — `POST /assignment/rules` · `PATCH /assignment/rules/:id` ·
`DELETE /assignment/rules/:id` · `PUT /assignment/rules/order`

`conditions` clauses AND together; values inside one clause OR. An absent clause
means "don't care", so `{}` is a catch-all. A clause whose context is missing
never matches — a `keywords` rule can't fire on a campaign assignment, which
carries no message text.

```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/assignment/rules" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "VIP WhatsApp → senior pool",
        "policyId": "POLICY_ID",
        "conditions": {
          "channels": ["whatsapp"],
          "tagIds": ["VIP_TAG_ID"],
          "sources": ["inbound", "ai_handoff"]
        }
      }'
```

Available clauses: `channels`, `tagIds`, `stageIds`, `languages` (prefix match,
so `en` catches `en-US`), `keywords` (case-insensitive substring),
`isNewContact`, and `sources` — one of `inbound`, `reopen`, `ai_handoff`,
`workflow`, `broadcast`, `api`, `manual`, `rebalance`.

**When routing runs** — `PATCH /assignment/settings`

| Field | Default | Meaning |
|---|---|---|
| `autoAssignOnNewConversation` | `false` | route a brand-new conversation on its first message |
| `skipWhenAiHandling` | `true` | while the AI is answering, don't spend an agent's capacity — a human arrives on escalation |
| `autoAssignOnReopen` | `false` | route an existing **unassigned** thread on a new message |
| `reassignOnOffline` | `false` | move work off agents who disconnect |
| `reassignOfflineAfterMinutes` | `15` | grace period, so a browser refresh isn't a stampede |
| `reassignOfflineOnlyPending` | `true` | only threads no agent has replied to yet |
| `reassignOnDeactivate` | `true` | re-route a deactivated teammate's open conversations |
| `aiHandoffPolicyId` | `null` | pin AI escalations to a policy; `null` = use the routing rules |

**Dry run** — `POST /assignment/preview` · `read:catalog`
"Who would take a conversation like this, right now?" Runs against live presence
and workload and returns `{ decision, user }`. Read-only — it never advances the
rotation cursor or the weighted counters, so it's safe to poll.

```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/assignment/preview" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "source": "inbound", "channel": "whatsapp", "tagIds": ["VIP_TAG_ID"] }'
```

`decision.reason` explains the outcome: `picked`, `fixed`, `fallback`,
`overflow_uncapped`, `manual_strategy`, `no_policy`, `no_candidates`,
`at_capacity`.

---

## 7. Broadcasts (campaign reporting)

Read-only. Scope: `read:broadcasts` (no implicit upgrade from other scopes).
There is deliberately no `write:broadcasts` — creating or firing a campaign via
API is a separate feature, and billed template sends are irreversible.

### List campaigns

```
GET /api/external/v1/broadcasts?status=completed&since=2026-07-01T00:00:00Z&limit=50&cursor=...
```

Returns `{ items, nextCursor }`, newest first. `since` filters on **broadcast
creation time** (`createdAt`), not completion — use it to poll for campaigns
**created** since your last sync. (A campaign created before your window but
completing inside it will not appear; page without `since` if you need
completion-time semantics.)

### One campaign

```
GET /api/external/v1/broadcasts/:id
```

Returns `{ broadcast }` with counters, template snapshot, timing, and
`suppressedCount` (contacts excluded at create time because they had opted out
of marketing — this is why `totalCount` can be lower than the audience you
picked).

### Campaign report

```
GET /api/external/v1/broadcasts/:id/report
```

Returns `{ report }` — the **same object the in-app report renders**, so the API
and the dashboard can never disagree about a number:

| Field | Meaning |
|---|---|
| `funnel.targeted` | every recipient row |
| `funnel.accepted` | Meta accepted the send (the billable population) |
| `funnel.reached` | arrived on the handset (`delivered` + `read`) |
| `funnel.read` | read receipt received |
| `funnel.neverReceived` | rejected at send **+** accepted-then-undeliverable |
| `funnel.replied` / `clicked` | unique recipients who replied / tapped a button |
| `funnel.optedOut` / `suppressed` | opted out during / excluded before the send |
| `rates.*` | `deliveryRate = reached/accepted`, `readRate = read/reached`, `replyRate = replied/reached` |
| `failures[]` | normalized `errorCode`, count, and a `bucket` of `retryable` / `permanent` / `suppress` |
| `cost` | billable conversations by Meta pricing category (no currency: Meta reports a category, never a price) |
| `benchmark` | your own last 5 campaigns, so a rate has context |
| `diagnostics[]` | what went wrong and what to do about it |

### Recipient-level results

```
GET /api/external/v1/broadcasts/:id/recipients?outcome=never_received&updatedSince=2026-07-18T10:00:00Z
```

Returns `{ items, nextCursor }`. Filters: `outcome` (`never_received`,
`delivered`, `read`, `replied`, `clicked`, `failed`, `undelivered`, `pending`),
`errorCode`, and `updatedSince`.

> **Report on `deliveryState`, not `sendStatus`.** `sendStatus` is the send-side
> outcome (did we hand it to Meta) and deliberately does not change when a
> message is later found undeliverable. `deliveryState` carries the truth:
> `pending → sent → delivered → read`, or `failed_at_send` / `undelivered`.

Delivery and read receipts keep arriving for hours after a campaign finishes, so
poll with `updatedSince` rather than treating the numbers as final at completion.

---

## 8. Calls

Scopes: `read:calls` for history and permission state, `write:calls` to ask a
customer for calling permission or send them a call button.

There is deliberately **no "place a call" endpoint**. A WhatsApp call needs an
SDP offer from a live WebRTC peer and a browser to carry the audio, so an API
client has nothing to place one with. What's here is the part an integration
can genuinely drive: teeing up a call a human then makes or takes.

### List calls

```
GET /api/external/v1/calls?conversationId=...&from=2026-07-01T00:00:00Z&limit=50&cursor=...
```

Newest first. Returns `{ data, next_cursor }`; pass `next_cursor` back as
`cursor` until it's `null`.

```json
{
  "data": [
    {
      "id": "clx...",
      "conversation_id": "clx...",
      "contact_id": "clx...",
      "channel": "whatsapp",
      "direction": "out",
      "status": "completed",
      "connected": true,
      "ringing_at": "2026-07-21T09:00:00.000Z",
      "answered_at": "2026-07-21T09:00:07.000Z",
      "ended_at": "2026-07-21T09:04:31.000Z",
      "duration_seconds": 264
    }
  ],
  "next_cursor": null
}
```

`connected` is **not** the same as `status === "completed"` — a call can
complete without anyone picking up, and an agent can hang up a call that did
connect. Use `connected` for "did they actually talk".

### Get calling permission

```
GET /api/external/v1/conversations/{id}/call-permission
```

```json
{
  "status": "temporary",
  "has_permission": true,
  "can_start_call": true,
  "can_request_permission": false,
  "expires_at": "2026-07-28T09:00:00.000Z",
  "quota_resets_at": null
}
```

Read live from WhatsApp, not from our records — permission can be granted in
ways that leave no trace on our side (the customer calling you, or granting it
from your business profile), so anything cached would tell you "no permission"
for people you can perfectly well call.

- `status` — `no_permission` · `temporary` (expires) · `permanent` (never does)
- `can_start_call` — WhatsApp's own verdict, with every limit already applied.
  **Check this rather than counting calls yourself**: the per-customer limit has
  changed three times in a year.
- `quota_resets_at` — set only when `can_start_call` is false because the
  per-customer call quota is spent.

### Request calling permission

```
POST /api/external/v1/conversations/{id}/call-permission
Idempotency-Key: <uuid>
```

Sends the customer a message asking them to allow calls. This is a real,
**billable** message, hence the mandatory `Idempotency-Key`.

Returns `{ ok, permission_request_id, expires_at }`. If permission is already
live, nothing is sent and `permission_request_id` is empty — re-asking someone
who already said yes is both wasteful and annoying. A `409
permission_request_rate_limited` means WhatsApp's request cap is spent (1 per
day, 2 per week, both reset by any connected call).

You'll know they accepted when `can_start_call` flips to `true`; WhatsApp sends
no webhook when a temporary permission later lapses, so re-read rather than
assuming.

### Send a call button

```
POST /api/external/v1/conversations/{id}/call-button
Idempotency-Key: <uuid>

{
  "bodyText": "Questions about order #1522? Call us — it's free on WhatsApp.",
  "displayText": "Call us",
  "ttlMinutes": 1440,
  "payload": "order-1522"
}
```

A tappable button that starts a WhatsApp call **to you**. The inverse of a
permission request: it needs no permission at all, and a customer who uses it
grants you callback permission as a side effect. Often the better move for a
cold contact.

- `bodyText` — required, max 1024 chars
- `displayText` — button label, max 20 chars (default "Call Now")
- `ttlMinutes` — how long the button stays tappable, 1 to 43200 (30 days),
  default 7 days
- `payload` — opaque attribution string, max 512 chars. Comes back to you on
  the call webhooks, so you can trace an inbound call to the campaign or record
  that produced the button. Older WhatsApp clients drop it — treat its absence
  as normal, never as an error.

Returns `{ ok, message_id }`.

---

## 9. Outbound webhooks (events we send you)

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
`contact.deleted`, `note.created`, `note.deleted`, `message.flag_changed`.

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

**Example body — `message.flag_changed`** (this is the one to subscribe to if you
want flagged work to reach another system):
```jsonc
{
  "team_id": "...",
  "timestamp": 1753182300000,
  "event_type": "message.flag_changed",
  "action": "added",                   // added | updated | resolved | removed
  "conversationId": "...",
  "messageId": "...",
  "contact": { "id": "...", "phoneNumber": "+961...", "name": "Layla H." },
  "openFlagCount": 1,                  // the thread's unresolved-flag count AFTER the change
  "flag": {
    "id": "...",
    "definitionId": "...",
    "definitionName": "Complaint",     // route on THIS — no catalog sync needed
    "definitionColor": "rose",
    "status": "open",                  // open | resolved | dismissed
    "source": "human",                 // human | ai | workflow | api
    "confidence": null,                // 0..1 when source = "ai"
    "note": "Second time this month.",
    "assignedToId": null, "assignedToName": null,
    "resolvedById": null, "resolvedByName": null,
    "resolvedAt": null, "resolutionNote": null,
    "createdById": "...", "createdByName": "Sara",
    "createdAt": 1753182300000,
    "updatedAt": 1753182300000
  }
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

## 10. Integrations

- **n8n (AI Autopilot):** step-by-step flow — receive `message.received`, branch on
  `ai_enabled`, reply via `POST /conversations/:id/messages`, hand off to a human.
  See **[n8n-ai-autopilot.md](n8n-ai-autopilot.md)**.
- **Postman:** import **[postman/ccp-org-api.postman_collection.json](postman/ccp-org-api.postman_collection.json)**
  and the local environment, set `apiKey`, and every request above is ready to click.

---

*Need a field that isn't here? Every list/get response is intentionally rich
(full contact, conversation state, message + media). If something's missing,
it's a bug — file it.*
