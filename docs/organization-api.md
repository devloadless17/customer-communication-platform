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
Optional: `phone`, `status` (`open|pending|closed`), `viewId` (a saved inbox
view — see §4b), `accountId`, `limit`, `cursor`.

`accountId` narrows to ONE connected account — a specific WhatsApp number,
Facebook Page or Instagram handle. Ids come from `GET /channel-accounts`; every
conversation also carries `channelConnectionId`, which is the same id. It is
ANDed with the other filters, so `status=open&accountId=…` means both. An id
that doesn't exist simply matches nothing.
```bash
curl -s "$CCP_BASE_URL/api/external/v1/conversations?status=open&limit=50" \
  -H "Authorization: Bearer $CCP_API_KEY"

# Only the threads on one WhatsApp number
curl -s "$CCP_BASE_URL/api/external/v1/conversations?accountId=cnx_123&status=open" \
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

## 4b. Saved inbox views

A **view** is a named, reusable filter over the conversation list — "Support ·
unassigned · WhatsApp", "VIP escalations". The same views the team sees in the
inbox rail, backed by the same service, so a view can never select different
conversations here than it shows in the product. Scopes: `read:catalog`,
`write:catalog`.

Two things follow from an API key not being a person:

- **Shared views only.** A personal view belongs to one teammate; a key has no
  personal scope, so it neither sees nor creates them (`POST` without
  `visibility` defaults to `shared`; an explicit `"personal"` returns
  `inbox_view_requires_user`).
- **`{"kind":"me"}` matches nothing here.** A view whose assignee filter is
  "me" resolves against the *viewer*, and a key has no user. It returns an
  empty set rather than silently widening to everyone.

**List / get** — `GET /inbox-views` · `GET /inbox-views/:id` · `read:catalog`
```bash
curl -s "$CCP_BASE_URL/api/external/v1/inbox-views" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**Use one to filter conversations** — pass its id to the conversation list. The
view's criteria are **ANDed** with `status` / `phone`, not substituted for them.
```bash
curl -s "$CCP_BASE_URL/api/external/v1/conversations?viewId=VIEW_ID&limit=50" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**Create** — `POST /inbox-views` · `write:catalog`

| Field | Notes |
|---|---|
| `name` | required, ≤60 chars, unique per workspace among shared views (case-insensitive) |
| `filters` | the criteria document, below. `{}` means every conversation |
| `color` | a palette name (`slate`, `rose`, `amber`, …) — not a hex |
| `icon` | one of a fixed set (`inbox`, `star`, `flame`, `filter`, …) |
| `visibility` | `shared` (the default for a key) |

Every `filters` field is optional and **ANDed**; an omitted field means "no
opinion", so `{}` is the widest possible view.

| Field | Type | Meaning |
|---|---|---|
| `statuses` | `["open","pending","closed"]` | any status when omitted |
| `assignee` | `{"kind":"anyone"\|"me"\|"unassigned"}` or `{"kind":"users","userIds":[…]}` | see the `me` caveat above |
| `channels` | `["whatsapp","instagram",…]` | the channel the thread arrived on |
| `stageIds` | `[…]` | contact lifecycle stage |
| `tagIds` + `tagMatch` | `[…]` + `"any"` (default) or `"all"` | `all` requires every tag |
| `hasOpenFlags` | `true` | only threads with an unresolved triage flag |
| `unreadOnly` | `true` | only threads with unread inbound messages |

```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/inbox-views" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Unassigned WhatsApp",
        "icon": "flame",
        "color": "rose",
        "filters": {
          "statuses": ["open"],
          "assignee": { "kind": "unassigned" },
          "channels": ["whatsapp"]
        }
      }'
```

**Update / delete** — `PATCH /inbox-views/:id` · `DELETE /inbox-views/:id` ·
`write:catalog`. `PATCH` takes any subset of the create fields.

A view referencing a tag, stage or teammate that has since been deleted is
**widened**, not emptied: the dead ids are dropped at read time and, if that
empties a criterion, the criterion is ignored. Deleting one tag of five must not
silently blank a view.

Errors: `inbox_view_not_found` (404 — also returned for another workspace's id,
so it can't be used to probe), `inbox_view_name_taken` (400),
`inbox_view_limit_reached` (400, 30 per scope), `inbox_view_requires_user` (400).

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

`variables` accepts every parameter shape Meta defines. Which ones a given template
*requires* comes from the template itself — supply the wrong set and the send is
rejected with a named error (`wrong_body_var_count`, `named_body_vars_required`,
`button_params_required`, `header_media_required`, `header_location_required`)
rather than an opaque Meta code.

| Field | When it applies |
| --- | --- |
| `body: string[]` | Positional templates (`parameter_format: POSITIONAL`, `{{1}}`). One value per variable, in order. |
| `bodyNamed: [{ name, text }]` | Named templates (`{{order_id}}`). Mutually exclusive with `body` — the template's stored `parameter_format` decides which is read. |
| `header: string` | A TEXT header carrying a variable. The placeholder name is paired server-side for named templates, so you only send the value. |
| `headerMedia: { kind, link, filename? }` | An `IMAGE`/`VIDEO`/`DOCUMENT` header. `link` must be publicly fetchable — Meta downloads it. |
| `headerLocation: { latitude, longitude, name, address }` | A `LOCATION` header. The template declares no coordinates, so the whole pin is per-message. |
| `buttons: [{ index, subType, text }]` | Dynamic buttons only: `url` (the suffix appended to the button's URL — **percent-encode it**), `copy_code` (the coupon), `quick_reply` (the payload). Static buttons take nothing. |
| `tapTarget: { url, title }` | Makes an image/text/header-less template act as a call-to-action showing `title` and opening `url`. Send-time only; Meta gates it on a fully verified WABA. |
| `cards: [{ headerMedia, body?, buttons? }]` | Media-card carousel. One entry per card, in order — the length must equal the card count the template was **approved with**. `headerMedia` is `{ kind: "image"\|"video", link\|id }`; `buttons` are indexed **within the card** (card 2's first button is index `0` again). |
| `limitedTimeOfferExpiresAtMs: number` | **Required** when the template carries a `LIMITED_TIME_OFFER` component. UNIX **milliseconds** — note the contrast with the analytics endpoints, which take seconds. A past instant is rejected (`limited_time_offer_expiry_required`) rather than sent as an already-expired countdown. |

```bash
# A named template with a media header and a dynamic URL button
  -d '{ "contact": { "phone": "+96170123456" },
        "template": { "name": "order_shipped", "language": "en_US",
          "variables": {
            "bodyNamed": [{ "name": "first_name", "text": "Ali" },
                          { "name": "order_number", "text": "SKBUP2-4CPIG9" }],
            "headerMedia": { "kind": "image", "link": "https://example.com/receipt.png" },
            "buttons": [{ "index": 0, "subType": "url", "text": "SKBUP2-4CPIG9" }]
          } } }'
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

**`POST /message-flag-definitions`** · `write:catalog` — create one.
Body: `{ name, color?, description?, sortOrder? }`. `color` is one of the shared
tag colors; anything unrecognized normalizes to `slate`.

**`PATCH /message-flag-definitions/:id`** · `write:catalog` — update
`name` / `color` / `description` / `sortOrder` / `archivedAt`.

**`DELETE /message-flag-definitions/:id`** · `write:catalog` — archive it.
Existing flags keep resolving to the archived definition, so history stays
readable.

```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/message-flag-definitions" \
  -H "Authorization: Bearer $CCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Complaint", "color": "rose" }'
```

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

## 5c. Tickets (the unit of work)

A **conversation** is the long-lived thread with one contact — it never fragments. A **ticket** is one piece of *work* on that thread, and there are many over time:

```
new → open → pending / on_hold → solved → closed
                                    ↑         (reopen window)
                              a follow-up inside the window comes back here
```

The refund raised in March and the delivery question in June are two tickets on one unbroken thread, each with its own assignee, priority, SLA clock and outcome. `Message.ticketId` is the join: every message carries the ticket it belongs to.

**Tickets open by themselves.** An inbound message on a thread with no active ticket opens one (`source: "auto"`); a follow-up inside the workspace's reopen window (default 72h) reopens the solved one instead of starting a third. Both behaviours are workspace settings — see *Settings* below. **Broadcasts never open tickets**; a customer who *replies* to one does.

Scopes: `read:tickets`, `write:tickets`.

### The board

**`GET /tickets`** · `read:tickets` — newest first, keyset-paginated.

| Query param | Meaning |
|---|---|
| `status` | Comma list: `new,open,pending,on_hold,solved,closed` |
| `priority` | Comma list: `low,normal,high,urgent` |
| `assignee` | A user id, `me`, or `none` (unassigned — a real filter, not "any") |
| `contactId` · `conversationId` · `channel` | Narrow to one person, thread, or channel |
| `tagIds` | Comma list; matches any |
| `breached` | `true` → only tickets that missed a promise |
| `cursorCreatedAt` + `cursorId` | The previous page's last row (both required) |
| `limit` | 1–50, default 50 |

An unknown enum value is a `400` that names it — a filter is never silently ignored, because that would quietly return the whole board.

```bash
curl -s "$CCP_BASE_URL/api/external/v1/tickets?status=new,open&priority=urgent&breached=true" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

```json
{
  "tickets": [
    {
      "id": "tkt_123",
      "number": 1042,
      "conversationId": "cnv_9",
      "contactId": "ctc_4",
      "contactName": "Layla",
      "channel": "whatsapp",
      "subject": "Refund not received",
      "status": "open",
      "priority": "urgent",
      "assignedUserId": "usr_2",
      "assignedUserName": "Omar",
      "tags": [{ "id": "tag_1", "name": "billing", "color": "amber" }],
      "sla": {
        "firstResponseDueAt": "2026-07-22T10:15:00.000Z",
        "resolutionDueAt": "2026-07-22T13:00:00.000Z",
        "firstResponseAt": null,
        "firstResponseBreached": false,
        "resolutionBreached": false,
        "paused": false
      },
      "resolvedAt": null, "closedAt": null,
      "resolutionCode": null, "resolutionNote": null,
      "reopenCount": 0, "source": "auto",
      "customFields": { "root_cause": "" },
      "version": 3,
      "createdAt": "2026-07-22T09:00:00.000Z",
      "updatedAt": "2026-07-22T09:41:12.004Z"
    }
  ],
  "nextCursor": { "createdAt": "2026-07-22T09:00:00.000Z", "id": "tkt_123" }
}
```

`number` is the human-facing id people quote to each other (`#1042`), unique per workspace. `version` is the concurrency token — see *Updating* below.

**`GET /tickets/counts`** · `read:tickets` — `{ totalActive, mineActive, breached, byStatus }` for header badges. `mineActive` is always `0` for an API key (a key has no agent identity).

**`GET /tickets/:id`** · `read:tickets` — one ticket plus its full timeline:

```json
{ "ticket": { … }, "events": [ { "id": "…", "kind": "created", "before": null, "after": {…}, "actorUserId": null, "actorName": null, "createdAt": "…" } ] }
```

### Opening one

**`POST /tickets`** · `write:tickets` — for a second issue raised in the same breath, or work created from your own system.

```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/tickets" \
  -H "Authorization: Bearer $CCP_API_KEY" -H "Content-Type: application/json" \
  -d '{"conversationId":"cnv_9","subject":"Also: wrong invoice","description":"Customer was double-charged on the 3rd; billing to confirm.","priority":"high","tagIds":["tag_1"]}'
```

Fields: `conversationId` (required), `subject`, `description` (the cause — free text, ≤5000, read by whoever the ticket is handed to), `priority`, `assignedUserId`, `assignedTeamId`, `tagIds`, `customFields`. A ticket created with an assignee starts `open`; without one it starts `new`, which is what makes an untriaged backlog reportable.

### Updating

**`PATCH /tickets/:id`** · `write:tickets` — status, priority, assignee, **team**, subject, **description (the cause)**, tags, custom fields, resolution.

```bash
curl -s -X PATCH "$CCP_BASE_URL/api/external/v1/tickets/tkt_123" \
  -H "Authorization: Bearer $CCP_API_KEY" -H "Content-Type: application/json" \
  -d '{"expectedVersion":3,"status":"solved","resolutionCode":"refunded"}'
```

Send `expectedVersion` (from your last read) and a write built on a stale view returns **`409 version_conflict`** instead of overwriting someone else's change — re-read and retry. Omit it and the write always applies; that is the right choice for automation, which has no stale view to protect.

**`DELETE /tickets/:id`** · `write:tickets` — permanently delete a ticket (work raised by mistake). The customer's messages survive (only unlinked); the work item and its timeline go. Returns `{ "ok": true }`, or `404` if it doesn't exist in your workspace. In the app this is limited to admins/managers; a scoped key is trusted like an integration.

Lifecycle side effects, so you don't have to replicate them:
- → `solved` stamps `resolvedAt` and starts the reopen window.
- → `closed` is terminal; a later message never reopens it (there is no auto-open — raise a new ticket deliberately).
- Back from `solved`/`closed` clears the resolution and increments `reopenCount`.
- → `on_hold` (and `pending`, if the policy says so) **pauses** the SLA clock; leaving it pushes both deadlines out by exactly the parked time rather than restarting the commitment.

### Handing a ticket to another team

A ticket can belong to a **team** (an assignment policy — Sales, Support, Billing) as
well as, or instead of, a person. This is the handoff: Support reads a message, realises
the issue belongs to Sales, and hands the *ticket* over — at which point it sits in Sales'
queue with nobody on it, until someone there claims it.

```bash
curl -s -X PATCH "$CCP_BASE_URL/api/external/v1/tickets/tkt_123" \
  -H "Authorization: Bearer $CCP_API_KEY" -H "Content-Type: application/json" \
  -d '{"assignedTeamId":"pol_sales","handoffReason":"Customer wants to upgrade their plan"}'
```

- `assignedTeamId` is an id from `GET /assignment-policies`; `null` takes the ticket out of
  every queue. A team from another workspace is rejected with **`400 team_not_found`**.
- Setting it **clears `assignedUserId`** unless you name one in the same call — otherwise
  the ticket looks claimed by the team that just handed it away.
- `handoffReason` is stored on the timeline event. Send it: a handoff with no reason makes
  the receiving team re-read the whole thread to work out what was wanted.
- The resulting `ticket.changed` webhook carries `action: "team_changed"` — deliberately
  distinct from `"assigned"`, so you can tell a queue handoff from someone claiming work.
- Filter the queue with `GET /tickets?team=pol_sales` (or `team=none`). It ANDs with
  `assignee`, so `?team=pol_sales&assignee=none` is "in Sales' queue and still unclaimed".

**`POST /tickets/:id/notes`** · `write:tickets` — an internal note. The customer never sees it.

```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/tickets/tkt_123/notes" \
  -H "Authorization: Bearer $CCP_API_KEY" -H "Content-Type: application/json" \
  -d '{"body":"Tell them their order ships Tuesday and we have waived the fee."}'
```

This is the other half of a handoff: the receiving team answers *what to say* without
messaging the customer themselves. It is a separate route, not a `PATCH` field, because a
note changes nothing about the ticket — it must not bump `version` (which would 409 a
colleague's open editor) or move the SLA clock.

### Settings

**`GET` / `PATCH /tickets-settings`** · `read:tickets` / `write:tickets`

| Field | Meaning |
|---|---|
| `ticketReopenWindowHours` | How long after `solved` a follow-up reopens instead of starting fresh. Default `72`, `0` disables, max `720`. |
| `ticketCloseConversationOnLastSolved` | Close the conversation when its last active ticket is solved. Default `false` — the two lifecycles are deliberately decoupled. |

**`GET` / `POST /ticket-sla`** · `read:tickets` / `write:tickets` — one commitment per priority; `POST` upserts on `priority`.

```bash
curl -s -X POST "$CCP_BASE_URL/api/external/v1/ticket-sla" \
  -H "Authorization: Bearer $CCP_API_KEY" -H "Content-Type: application/json" \
  -d '{"priority":"urgent","firstResponseMins":15,"resolutionMins":60,"pauseOnHold":true,"businessHoursOnly":false}'
```

`null` minutes means **no commitment on that leg** — not zero. Nothing is due, so nothing breaches. `businessHoursOnly` consumes the minutes only inside the workspace's working hours. Due dates are computed **when the ticket is created** and then stored, so editing a policy never retroactively breaches open work.

A missed deadline flips `firstResponseBreached` / `resolutionBreached` and fires the `ticket.changed` webhook with `action: "sla_breached"` and `breachedLeg` — exactly once, however long it stays missed.

**`GET` / `POST /ticket-fields`**, **`PATCH` / `DELETE /ticket-fields/:id`** · custom fields on a ticket. The `key` is derived from the label at create time and is **immutable** (values in `customFields` are keyed by it). Deleting a definition leaves stored values in place — they are history on closed work — they just stop rendering.

---

### Campaign analytics

Two sources, deliberately reported **side by side and never merged**:

| | What it is | Only source of |
|---|---|---|
| **Delivery funnel** (`/report`) | per-recipient truth from status webhooks | `replied`, opt-outs, per-recipient failure reasons |
| **Meta analytics** (`metaAnalytics`) | Meta's own aggregate, per template per day | real currency **cost**, unique **URL-button clicks** |

They measure different things and will not agree exactly — a template used by
two campaigns on the same day reports both campaigns' volume in Meta's figures,
while the funnel is scoped strictly to one campaign. Averaging them would give a
number matching neither.

**Delivery curve** — `GET /broadcasts/:id/timeseries` · `read:broadcasts`
Cumulative sent / delivered / read / replied, bucketed by a width the server
picks from the send's span (`bucketSeconds` in the response). Bounded output —
a 100k campaign returns the same few hundred points a 100-recipient one does.
```bash
curl -s "$CCP_BASE_URL/api/external/v1/broadcasts/BROADCAST_ID/timeseries" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

**Pull fresh figures from Meta** — `POST /broadcasts/:id/analytics/refresh` ·
`read:broadcasts`. Manual on purpose: the report is polled while a campaign
sends, and a Graph call on that path would exhaust Meta's rate limit for an
aggregate that barely moves minute to minute. After this, `metaAnalytics` on the
report reads the refreshed rollup.

**Business profile** — `GET /whatsapp/profile` / `POST /whatsapp/profile` reads
and updates what a customer sees when they tap the business name (`about`,
`address`, `description`, `email`, `websites`, plus read-only `vertical` and
`profilePictureUrl`). `?accountId=` picks one of the workspace's numbers — each
has its own profile. **Only the fields you send are changed**; sending `""`
CLEARS a field, so omit what you don't mean to touch. The response is read back
from Meta rather than echoed, so it reflects what was actually stored. Scopes:
`read:catalog` / `write:catalog`.

**QR codes & short links** — `GET/POST /whatsapp/qr-codes`,
`POST /whatsapp/qr-codes/:code` (edit the prefilled message),
`DELETE /whatsapp/qr-codes/:code`. A code is both the identity and the short
link slug (`https://wa.me/message/<code>`); `prefilledMessage` is capped at
**140** chars and `imageFormat` is `SVG` (default) or `PNG`. `qrImageUrl` comes
back only from CREATE. **Deleting breaks anything already printed** — scanners
see "this QR code has expired" — so edit to change the wording. Meta caps a
number at 2,000 codes and publishes **no scan analytics**. Scopes:
`read:catalog` / `write:catalog`.

**Account standing** — `GET /whatsapp/account-status` returns the number's
Official Business Account status (`obaStatus`, verbatim from Meta) and its WABA
record (`name`, `status`, `currency`, `country`, `businessVerificationStatus`).
Read-only: OBA is requested in WhatsApp Manager. Scope: `read:catalog`.

**Template catalog** — `GET /templates?status=&category=` lists the WhatsApp
templates, each with the `id` the send and analytics routes take, Meta's
`externalId`, the `parameterFormat` that decides the send shape, the components,
and `qualityScore` (`GREEN`/`YELLOW`/`RED`/`UNKNOWN` — the signal worth alerting
on, since quality drives Meta's template pausing). Read-only: creating a template
is a Meta review submission, not a CRUD write. Scope: `read:catalog`.

**Unpause a template** — `POST /templates/:id/unpause` lifts a quality pause and
releases any campaigns paused with it. Meta lifts a *quality* pause itself (3h,
then 6h, then it **disables** the template), so this is for one paused by
Template Pacing, which never unpauses on its own. Scope: `write:catalog`.

**Per-template trend** — `GET /templates/:id/analytics?start=&end=` ·
`read:broadcasts`. Defaults to the last 30 days; Meta's lookback ceiling is 90.
Returns `days[]` plus a `summary`.

**Is it switched on?** — `GET /whatsapp/insights/status` · `read:catalog`.
Meta requires a **one-time, irreversible** opt-in per WABA before it reports any
template analytics. There is no API to enable it — that is deliberately an
in-app admin action (Settings → WhatsApp), because it cannot be undone.

> **Reading the nulls.** `read` and `clicked` are null outside Meta's ~7-day
> window, and cost is null when the WABA is billed through a Solution Partner
> (`costWithheld: true` says which). A null is **never** the same as zero — the
> stored rollup preserves whatever was captured while it was still reported.

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

### WhatsApp messaging health

`GET /whatsapp/health` · `read:catalog` — the tier and 24h unique-recipient cap
Meta currently allows, how much is already spent, the quality rating and the
throughput ceiling. Secret-free (no tokens).

The one number to plan against is `remainingDailyBudget`: without it an
integration discovers the cap by having a large send refused, and the refusal is
correct so there is nothing to retry. `portfolioAccountCount > 1` means the
budget is **shared** across several numbers in the same business portfolio.

```bash
curl -s "$CCP_BASE_URL/api/external/v1/whatsapp/health" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

### Channel accounts

`GET /channels` lists which *channels* the workspace has connected. A channel can hold
**more than one account** — two WhatsApp numbers, two Facebook Pages — so this returns the
accounts under one channel:

**`GET /channels/:channel/accounts`** · `read:channels`

`:channel` is `whatsapp`, `messenger` or `instagram` (channels whose accounts carry
credentials; the web chat widget is managed separately).

```bash
curl -s "$CCP_BASE_URL/api/external/v1/channels/whatsapp/accounts" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

```json
{
  "accounts": [
    {
      "id": "cnx_123",
      "channel": "whatsapp",
      "externalAccountId": "10987654321",
      "label": "Sales line",
      "isDefault": true,
      "isActive": true,
      "needsReconnect": false,
      "displayPhoneNumber": "+961 70 000 000",
      "wabaId": "220044…",
      "createdAt": "2026-07-22T09:12:04.118Z"
    }
  ]
}
```

- `externalAccountId` is the provider's own id — the WhatsApp phone-number id, the Page id,
  or the Instagram account id. Use it to correlate a webhook you receive from Meta directly
  with the account it belongs to here.
- `isDefault` is the account used when a conversation doesn't name one — an outbound-initiated
  send or a broadcast. A reply to an existing thread always goes out the account the customer
  messaged, never the default.

**`GET /channel-accounts`** · `read:catalog`

Every account across **every** channel in one call, display fields only. This is the lookup
for `conversation.channelConnectionId` — a conversation names the account it is on, and
without this you have an opaque id.

```bash
curl -s "$CCP_BASE_URL/api/external/v1/channel-accounts" \
  -H "Authorization: Bearer $CCP_API_KEY"
```

```json
{
  "accounts": [
    {
      "id": "cnx_123",
      "channel": "whatsapp",
      "name": "Sales line",
      "providerName": "+961 70 000 000",
      "isDefault": true,
      "isActive": true
    },
    {
      "id": "cnx_456",
      "channel": "instagram",
      "name": "@acme",
      "providerName": "@acme",
      "isDefault": true,
      "isActive": true
    }
  ]
}
```

- `name` is what a human should see: the admin's label when set, else the provider's own
  name, else the raw id. Never blank.
- Carries **no credentials** — no token, App secret, WABA or portfolio id — which is why it
  sits under `read:catalog` rather than `read:channels`.
- `conversation.channelConnectionId` (on every conversation read) is the `id` here. It names
  which of your numbers/Pages the customer is talking to, and therefore which one a reply
  goes out from. Null when a thread has never been bound, or its account was disconnected.
- `needsReconnect` means the stored credentials were rejected by the provider; sends on that
  account will fail until an admin re-authorizes it in the app.

Read-only by design. Connecting or disconnecting an account moves real credentials and silently
changes which number a customer hears from, so it stays an in-app admin action.

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
| `funnel.held` | accepted, then **held** by business-portfolio pacing — parked in Meta's queue, not en route. Counted inside `accepted`; released in a later batch or dropped (error `135000`) |
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
`contact.deleted`, `note.created`, `note.deleted`, `message.flag_changed`,
`ticket.changed`.

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
**Example body — `ticket.changed`** (subscribe to this to mirror the work queue
into a helpdesk or BI system):
```jsonc
{
  "team_id": "...",
  "timestamp": 1753196400000,
  "event_type": "ticket.changed",
  // The TRANSITION, never merely the post-state: created | assigned |
  // status_changed | priority_changed | reopened | solved | closed |
  // sla_breached | updated (metadata edit that moved no lifecycle).
  "action": "solved",
  "conversationId": "...",
  "contact": { "id": "...", "phoneNumber": "+961...", "name": "Layla H." },
  "previousStatus": "open",
  "openTicketCount": 0,                // the thread's active-ticket count AFTER the change
  // "breachedLeg": "first_response",  // present ONLY on action = sla_breached
  "ticket": {
    "id": "...",
    "number": 1042,                    // what people quote to each other — "#1042"
    "subject": "Refund not received",
    "status": "solved",                // new | open | pending | on_hold | solved | closed
    "priority": "urgent",
    "channel": "whatsapp",
    "assignedUserId": "...", "assignedUserName": "Omar",
    "tags": ["billing"],               // names — no catalog sync needed
    "firstResponseDueAt": 1753189200000, "resolutionDueAt": 1753199400000,
    "firstResponseAt": 1753188120000,
    "firstResponseBreached": false, "resolutionBreached": false,
    "resolvedAt": 1753196400000, "closedAt": null,
    "resolutionCode": "refunded", "resolutionNote": "Refunded to the original card.",
    "reopenCount": 0,
    "source": "auto",                  // auto | human | workflow | api
    "createdAt": 1753174800000, "updatedAt": 1753196400000
  }
}
```
`sla_breached` fires **exactly once per leg**, however long the ticket stays
overdue — a missed promise is not a repeating alarm.

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
