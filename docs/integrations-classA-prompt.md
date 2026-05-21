# Class-A pass — Integrations (External `/v1` API + Outbound Webhooks)

> **Hand this whole file to an engineer or coding agent.** It is the single brief
> for taking the public integrations surface — the external `/v1` REST API and the
> outbound-webhooks subsystem — from "functional" to **class-A**: structured,
> consistently formatted, fully detailed, clean, solid, and fast.
>
> It is **self-contained**: every route, scope, wire shape, event, header, and
> threshold is embedded below, copied from the real code and cited with a
> `file:line` link. You should not need to re-discover the contract before acting —
> but every embedded value names its source-of-truth file so you can re-verify if
> the code has moved.
>
> **The one rule that defines the work:** raise quality *without silently changing
> the public wire format*. Partners (n8n / Zapier / custom) already parse these
> shapes. Any wire change is versioned + documented, never silent. Do **not** rewrite
> working systems; tighten, standardize, document, and close the named gaps.
>
> Created 2026-05-21 · supersedes the lean first draft.

---

## 1. Role & mission

You are a senior backend engineer on a WhatsApp multi-agent shared-inbox SaaS
(NestJS API + Next.js web, Prisma/Postgres, BullMQ/Redis, Socket.io; see
[CLAUDE.md](../CLAUDE.md)). The two subsystems in scope are the partner-facing
edge of the product. Mission: tighten + standardize + document + close the
gaps in §5, matching the house conventions in §3 exactly. Code first, short notes
on what's non-obvious. Surface tradeoffs in 1-2 sentences when you make a call.

## 2. The class-A bar (definition of done)

Each dimension is testable — the work isn't done until all five hold.

1. **Structured & well-organized** — controller = HTTP only (guards, `zBody`/`zQuery`,
   delegate to a service). Service = logic + domain events. Schemas colocated in
   `*.schemas.ts`, exporting both the `Schema` const and its `z.infer` type. No
   business logic in controllers; no HTTP concerns (status codes, headers) in services.
2. **Perfect, consistent format** — one documented response envelope per route class;
   one error envelope everywhere (`{ error: "snake_case_key", detail?, issues?, required? }`);
   one webhook envelope (`{ event_id, event_type, occurred_at, team_id, channel, data }`),
   snake_case throughout. No field is undocumented.
3. **Needed details** — every endpoint (method, path, scope, request, response, errors)
   and every event (trigger, payload, delivery semantics) is fully documented. No
   silent behaviors.
4. **Clean** — no dead code, no stale comments, no copy-paste between handlers, no
   inline one-off validation that belongs in a schema, consistent naming.
5. **Solid & fast** — idempotency, optimistic concurrency, rate limits, retries, and
   the circuit breaker stay intact; no N+1s; bulk paths stay coalesced; payloads bounded.

## 3. Non-negotiable house conventions (match the existing code exactly)

- **Validation** — `zBody`/`zQuery` from
  [common/zod-validation.pipe.ts](../apps/api/src/common/zod-validation.pipe.ts).
  Schemas colocated as `*.schemas.ts`; export the const **and** its `z.infer` type.
  Cross-field rules go in `.refine()`, never inline in the controller (see the
  phone-immutability gap in §5).
- **Error envelope** — `{ error: "snake_case_key", detail?, issues?, required? }`.
  The `error` value is a **stable snake_case key**, not a sentence — human text goes
  in `detail`. Status mapping: 400 `invalid_body` (+ `issues` from Zod), 401
  `unauthorized`, 403 `insufficient_scope` / `no_credentials` (+ `required`), 404
  `not_found`, 409 `conflict`, 422 for domain rejections, 429 `rate_limited`
  (+ `Retry-After`). Reuse the global
  [prisma-exception.filter](../apps/api/src/common/) mapping; throw Nest exceptions
  carrying this body shape.
- **External-API auth** — `Authorization: Bearer <token>` → `ApiKeyGuard`
  (SHA-256 hash lookup on `TeamApiKey.tokenHash`, reject on `revokedAt`, 60/min
  token bucket) → `@RequireScope(...)` → `ScopeGuard`. Never bypass; never log raw
  tokens (only the hash is stored, by design). Handlers must **not** re-check scopes —
  that's the guard's job.
- **Idempotency** — `Idempotency-Key` header (trim, 1–255 chars), CLAIM-then-execute,
  unique on `(teamId, apiKeyId, key)`. On a cache HIT, call `refundApiKeyBucket(apiKeyId)`
  ([api-key.guard.ts:51](../apps/api/src/auth/api-key.guard.ts#L51)) so retries don't
  starve the bucket.
- **Webhook wire format** — snake_case envelope `{ event_id, event_type, occurred_at,
  team_id, channel, data }`. Signature header
  `X-CCP-Signature: t=<unix-seconds>,v1=<hex(hmac-sha256(secret, "${t}.${rawBody}"))>`.
  Any change is versioned + documented, never silent.
- **Adding an event** — (1) add to `DomainEventMap`
  ([packages/shared/src/events/types.ts](../packages/shared/src/events/types.ts));
  (2) map it in `toPublicEnvelopes` in
  [public-events.ts](../packages/shared/src/outbound-webhooks/public-events.ts);
  (3) add it to `PUBLIC_EVENT_TYPES` + `PUBLIC_EVENT_GROUPS` (the partner-facing
  catalog + UI multiselect); (4) add it to `busEventTypesToSubscribe()`; (5) subscribe
  via `OnModuleInit`; (6) wrap the handler in try/catch — **never throw to the bus**.
- **TS strict** (`noUncheckedIndexedAccess` etc.). Prisma over raw SQL except the
  established coalesced bulk paths.

---

## 4. Embedded reference catalog (source of truth → cited)

> Base path: the external API controller is mounted at
> [`@Controller("api/external/v1")`](../apps/api/src/external/v1/external-v1.controller.ts#L109),
> so every route below is reached at `https://<host>/api/external/v1/...`. Code
> comments use the `/v1/...` shorthand; same routes.

### 4a. `/v1` route surface — 34 routes

Authoritative source:
[external-v1.controller.ts](../apps/api/src/external/v1/external-v1.controller.ts).
Controller-wide default rate limit is **600/min/key**
([:116](../apps/api/src/external/v1/external-v1.controller.ts#L116)); the upstream
`ApiKeyGuard` bucket of **60/min/key** is the hard brake. Bulk-tag routes override
to **20/min** ([:150](../apps/api/src/external/v1/external-v1.controller.ts#L150)).

| Method & path | Scope | Notes |
|---|---|---|
| `GET /v1/contacts` | `read:contacts` | List/find. Query: `phone` (exact), `email` (exact), `externalContactId` (exact), `search` (fuzzy), `stageId`, `tagIds` (CSV, ANY-match), `cursor`, `limit` 1–100 (def 50). |
| `GET /v1/contacts/:id` | `read:contacts` | → `{ contact }`. |
| `POST /v1/contacts` | `write:contacts` | Create. → `{ contact }`. |
| `POST /v1/contacts/upsert` | `write:contacts` | Find-or-create by `phoneNumber`. |
| `PATCH /v1/contacts/:id` | `write:contacts` | Partial update. `phoneNumber` is **immutable** (rejected — see §5 gap). → `{ contact }`. |
| `DELETE /v1/contacts/:id` | `delete:contacts` | Hard delete. → `{ ok: true }`. |
| `GET /v1/contacts/:id/channels` | `read:contacts` | Siloed-per-channel → one Meta row today. |
| `POST /v1/contacts/:id/tags` | `write:contacts` | Add tag(s) to one contact. Body `{ tagIds[] }` (1–50). |
| `DELETE /v1/contacts/:id/tags/:tagId` | `write:contacts` | Remove one tag. |
| `POST /v1/contacts/:id/tags/remove` | `write:contacts` | Bulk-remove tags from one contact; one `contact.tag_changed`. |
| `POST /v1/contacts/tags/add` | `write:contacts` | **20/min.** Bulk add across many contacts. Body `{ contactIds[] (1–500), tagIds[] (1–50) }`. Returns **counts only**. |
| `POST /v1/contacts/tags/remove` | `write:contacts` | **20/min.** Bulk remove. Counts only. |
| `POST /v1/contacts/:id/assign` | `write:conversations` | Contact-keyed: resolves the contact's most-recent conversation, assigns. Body `{ assignedUserId: string\|null }`. |
| `POST /v1/contacts/:id/status` | `write:conversations` | Contact-keyed status. Body `{ status: open\|pending\|closed }`. |
| `GET /v1/contact-fields` | `read:catalog` | List custom-field defs. |
| `GET /v1/contact-fields/:idOrKey` | `read:catalog` | Find by id or key → `{ field }`. |
| `POST /v1/contact-fields` | `write:catalog` | Create. Body `{ label }` (1–60). → `{ field }`. |
| `GET /v1/tags` | `read:catalog` | List. |
| `POST /v1/tags` | `write:catalog` | Create. Body `{ name (1–40), color? }`. → `{ tag }`. |
| `PATCH /v1/tags/:id` | `write:catalog` | Update `{ name?, color? }` (color ∈ `TAG_COLORS`). |
| `DELETE /v1/tags/:id` | `write:catalog` | → `{ ok: true }`. |
| `GET /v1/stages` | `read:catalog` | List lifecycle stages. |
| `GET /v1/channels` | `read:catalog` | Single synthetic Meta row today. |
| `GET /v1/users` | `read:catalog` | List team members. |
| `GET /v1/users/:idOrEmail` | `read:catalog` | Find one. |
| `GET /v1/conversations` | `read:conversations` | Query: `phone`, `status`, `limit` 1–100 (def 50), `cursor`. Each row embeds `contact`. |
| `GET /v1/conversations/:id` | `read:conversations` | Embeds `contact`. |
| `POST /v1/conversations/:id/assign` | `write:conversations` | `{ assignedUserId: string\|null }`. → `{ ok: true }`. |
| `POST /v1/conversations/:id/status` | `write:conversations` | `{ status }`. → `{ ok: true }`. |
| `POST /v1/messages` | `write:messages` | Top-level send. Accepts `Idempotency-Key`. Body: `contact` (`{id}` XOR `{phone}`) + at least one of `text` / `media` / `template`; `channel_id?` (advisory), `client_temp_id?`, `reply_to_message_id?`. **`media` is stubbed** (see §5). |
| `GET /v1/messages/:id` | `read:messages` | → `{ message, conversation }`. |
| `GET /v1/conversations/:id/messages` | `read:messages` | `limit` 1–200 (def 50), `cursor`. |
| `POST /v1/conversations/:id/messages` | `write:messages` | Conversation-scoped send. `Idempotency-Key`. Body `{ body (1–4096), replyToMessageId? }`. → `{ ok: true, message }`. |
| `POST /v1/conversations/:id/notes` | `write:notes` | `{ body (1–8000), authorUserId? }`. → `{ ok: true, note }`. |

Schema constants (single source:
[external-v1.schemas.ts](../apps/api/src/external/v1/external-v1.schemas.ts#L8)):
`MAX_TEXT = 500`, `MAX_BULK_IDS = 500`, `MAX_FIELDS = 50`. `customFields`: keys ≤ 80
chars, values ≤ 500 chars (or `null` to clear), ≤ 50 entries.

### 4b. Auth, scopes & limits

- **Bearer key** → SHA-256 → `TeamApiKey` lookup → reject if `revokedAt`
  ([api-key.guard.ts](../apps/api/src/auth/api-key.guard.ts)). `looksLikeApiKey`
  shape gate runs before the DB query to equalize timing. `lastUsedAt` is stamped
  async (best-effort, never fails the request).
- **Scopes** (single source:
  [scopes.ts](../packages/shared/src/api-keys/scopes.ts)) — empty array = deny-by-default;
  `"*"` = wildcard (backfill for pre-scope keys). No implicit read↔write upgrade.

  ```
  *                read:contacts  write:contacts  delete:contacts
  read:conversations  write:conversations
  read:messages    write:messages
  read:notes       write:notes
  read:catalog     write:catalog
  ```
- **Rate limits** — 60/min/key (`ApiKeyGuard`) · 600/min/key (controller default) ·
  20/min (bulk tag). 429 body `{ error: "rate_limited", detail: "60 req/min" }`.
  (Gap §5: add `Retry-After`.)
- **Idempotency** — `Idempotency-Key` header on both send routes; claim-then-execute;
  refund the bucket on a cache hit.

### 4c. `/v1` wire shapes

Single source:
[external-shapes.ts](../apps/api/src/lib/external-shapes.ts). All timestamps are ISO
strings. Shared Prisma includes `EXTERNAL_CONTACT_INCLUDE` /
`EXTERNAL_CONVERSATION_INCLUDE` hydrate assignee + tags on every read (root-cause fix
for "contact info missing on some endpoints").

```ts
ExternalAssignee  = { id, name, email }                              // null when unassigned
ExternalMedia     = { kind, url|null, mimeType|null, filename|null,
                      sizeBytes|null, durationMs|null, thumbnailUrl|null, caption|null }
ExternalContact   = { id, phoneNumber|null, identityProvider|null, externalContactId|null,
                      name, firstName|null, lastName|null, language|null, countryCode|null,
                      assignee: ExternalAssignee|null, avatarUrl|null, email|null,
                      location|null, customFields: Record<string,string>,
                      stageId|null, tagIds[], createdAt }
ExternalConversation = { id, contactId, status, assignee|null, unreadCount,
                         lastMessageAt, lastMessagePreview, contact: ExternalContact }  // embeds contact
ExternalMessage   = { id, conversationId, externalId, direction, body, status,
                      timestamp, senderUserId|null, media: ExternalMedia|null }
```

Message-primary responses return `{ message, conversation }` so contact context is
always one hop away, never zero.

### 4d. Error-code catalog (target — see §5)

The codes the `/v1` surface returns today, scattered across guards + handlers; the
class-A target is **one exported union** referenced from every handler. Observed set:

| Code | HTTP | Where |
|---|---|---|
| `unauthorized` (`missing/empty bearer token`, `invalid api key`) | 401 | `ApiKeyGuard` |
| `no_credentials` | 403 | `ScopeGuard` (scope route, no key) |
| `insufficient_scope` (+ `required`) | 403 | `ScopeGuard` |
| `rate_limited` (+ `detail`, → add `Retry-After`) | 429 | `ApiKeyGuard` |
| `invalid_body` (+ `issues`) | 400 | `zBody` / PATCH contact |
| `media_not_yet_supported` | 400 → **501** target | messaging service (media stub) |
| `template_not_found` | 400/404 | messaging service |
| ad-hoc sentences (`"text required"`, `"user not in team"`, phone-immutable msg) | 400 | **violations — normalize to keys (§5)** |

### 4e. Webhook envelope

Single source:
[public-events.ts](../packages/shared/src/outbound-webhooks/public-events.ts). Every
delivery body:

```jsonc
{
  "event_id":    "<= OutboundWebhookDelivery.id; also the X-CCP-Delivery header>",
  "event_type":  "message.received",
  "occurred_at": "2026-05-20T11:00:00.000Z",   // ISO, stamped by the subscriber
  "team_id":     "...",
  "channel":     { "source": "meta_cloud", "phone_number_id": null, "display_phone_number": null } | null,
  "data":        { /* per-event, §4f */ }
}
```

The framework-agnostic mapper sets `event_id = ""` and `channel = null`; the
**subscriber** stamps `event_id` (from the freshly-created delivery row id, so partners
can cross-reference the delivery log), `channel` (from the team's Meta config), and
fills media `url` / `thumbnail_url` from the CDN columns (one batched lookup per event).

### 4f. Public event catalog — 13 types

Stable identifiers (`PUBLIC_EVENT_TYPES`,
[:50](../packages/shared/src/outbound-webhooks/public-events.ts#L50)). Renaming/removing
breaks live integrations — add freely, never rename. `data` shapes (snake_case):

**Messages**
- `message.received` — contact sent a WhatsApp message. `{ message, contact, conversation, is_new_conversation, reopened }`. Embeds full contact + conversation.
- `message.sent` — agent/API/workflow sent. `{ message, conversation: { id, contact_id } }`. **Deliberately lightweight** — contact_id only, no DB roundtrip (the partner usually initiated the send). Don't "fix" without a request.
- `message.status_changed` — `{ message_id, conversation_id, contact_id, status }`.

`message.data` = `{ id, conversation_id, contact_id, direction, body, timestamp,
status, sender: SenderInfo, sender_api_key_id|null, media: PublicMedia|null }`.
`SenderInfo = { type: contact|user|ai_agent|workflow|broadcast|api, id|null, name|null }`.

**Conversations**
- `conversation.assigned` — `{ conversation_id, contact_id, previous_assignee, assignee, changed_by_user_id, changed_by_api_key_id }`.
- `conversation.status_changed` — `{ conversation_id, contact_id, previous_status, status, changed_by_user_id, changed_by_api_key_id, closed_category|null, closed_summary|null }`.
- `conversation.opened` / `conversation.closed` — **synthetic**, derived from `status_changed` (fire only on the matching transition). Subscribe to these OR to `status_changed`, not both.

**Contacts**
- `contact.created` — `{ contact, source: inbound|api|migration, created_by_user_id|null, created_by_api_key_id|null }`.
- `contact.updated` — `{ contact, field_changes, tag_changes, previous_stage_id, changed_by_user_id, changed_by_api_key_id }`.
- `contact.tag_changed` — `{ contact_id, before:{tag_ids}, after:{tag_ids}, added[], removed[], changed_by_* }`.
- `contact.lifecycle_changed` — `{ contact_id, before:{stage_id}, after:{stage_id}, changed_by_* }`.
- `contact.assignee_changed` — `{ contact_id, before, after, changed_by_* }`.
- `contact.deleted` — `{ contact_id, conversation_ids[], deleted_by_user_id, deleted_by_api_key_id }`.

`PublicContact` / `PublicConversation` / `PublicMedia` shapes:
[public-events.ts:415](../packages/shared/src/outbound-webhooks/public-events.ts#L415).
`AssigneeInfo = { type: user|ai_agent, id, name|null, email|null }`.

**Notes**
- `note.created` — `{ note: { id, conversation_id, author_user_id|null, body, timestamp } }`.

### 4g. Delivery mechanics

Sources: [lib/outbound-webhooks/{queue,worker,signing}.ts](../apps/api/src/lib/outbound-webhooks/),
admin CRUD [team/outbound-webhooks/](../apps/api/src/team/outbound-webhooks/),
subscriber [outbound-webhooks.subscriber.ts](../apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts),
sweeper `lib/sweepers/orphan-webhook-delivery.ts`.

- **Pipeline** — bus event → subscriber maps to public envelope(s), filters by team +
  `eventTypes`, creates an `OutboundWebhookDelivery` row (id pre-generated = `event_id`),
  enqueues `webhook-deliver` BullMQ job `{ deliveryId }` (jobId `deliver-<id>`, idempotent).
- **Headers on delivery** ([worker.ts:173](../apps/api/src/lib/outbound-webhooks/worker.ts#L173)):
  `Content-Type: application/json`, `User-Agent: CCP-Webhook/1.0`,
  `X-CCP-Event: <event_type>`, `X-CCP-Delivery: <delivery id = event_id>`,
  `X-CCP-Signature: t=…,v1=…`, and `X-CCP-Origin-Key: <apiKeyId>` when the triggering
  mutation was API-key authenticated (loop detection).
- **Signing** ([signing.ts](../apps/api/src/lib/outbound-webhooks/signing.ts)):
  `signed = "${t}.${rawBody}"`; `v1 = hmac_sha256(secret, signed)` hex. The digest
  covers the **exact bytes POSTed**. Secret format `ccp_whsec_<base64url(24 bytes)>`,
  stored envelope-encrypted (`enc:v1:…`), decrypted fresh per attempt (post-rotation safe).
- **Retries** ([queue.ts:64](../apps/api/src/lib/outbound-webhooks/queue.ts#L64)):
  4 attempts, exponential backoff base 30s → 30s · ~2m · ~8m · ~30m (~40 min/delivery).
  `lockDuration` 120s, `lockRenewTime` 30s.
- **Circuit breaker** ([worker.ts:32](../apps/api/src/lib/outbound-webhooks/worker.ts#L32)):
  `consecutiveFailures` counts **deliveries** (bumped once, on the final attempt),
  resets to 0 on any 2xx. At `AUTO_DISABLE_THRESHOLD = 20` (~13h sustained breakage)
  → `enabled=false` + `disabledAt`/`disabledReason`, publishes `webhook.subscription_disabled`.
  N>0 → 0 publishes `webhook.subscription_recovered`. SSRF rejections are treated as
  final (no retry).
- **Orphan sweeper** — re-enqueues delivery rows stranded between insert and enqueue
  (attempt 0, no deliveredAt/failedAt) older than `WEBHOOK_ORPHAN_GRACE_MS`.
- **Delivery semantics: at-least-once.** Receivers MUST dedup on `event_id`
  (= `X-CCP-Delivery`). Response body capped at 4096 bytes; no redirects (`maxRedirects: 0`).
- **Admin CRUD** ([outbound-webhooks.controller.ts](../apps/api/src/team/outbound-webhooks/outbound-webhooks.controller.ts),
  `@RequireRole("admin")`): `GET /` · `POST /` (secret returned once) · `PATCH /:id` ·
  `POST /:id/rotate-secret` · `DELETE /:id` · `GET /:id/deliveries` · `POST /:id/test`.
  **No replay endpoint** (gap §5).
- **Env vars**: `REDIS_URL` (required) · `RUN_WORKER_INLINE` (default on the api
  container) · `WEBHOOK_WORKER_CONCURRENCY` (def 10, 1–100) · `WEBHOOK_ORPHAN_GRACE_MS`
  (def 300_000, 60_000–3_600_000) · `AUTO_DISABLE_THRESHOLD` (**hardcoded today — gap §5**).
  New `process.env` reads must also be wired into `docker-compose.yml` `api.environment`.
- **Prisma models** — `OutboundWebhook` (id, teamId, name, url, secret, eventTypes[],
  enabled, createdById, lastDeliveredAt, lastErrorAt, lastErrorMessage,
  consecutiveFailures, disabledAt, disabledReason; `@@index([teamId, enabled])`) and
  `OutboundWebhookDelivery` (id, webhookId, eventType, payload Json, responseStatus,
  responseBody, attemptCount, deliveredAt, failedAt, errorMessage, createdAt). The
  `payload` column doc-comment already states it's "stored verbatim so a retry from
  the UI can re-POST the same JSON" — the model anticipates replay; the endpoint is missing.

---

## 5. Concrete work items (close these gaps)

Each is real and source-cited. Fix, then show a short before/after.

### External API

- [ ] **Centralize the error-code catalog.** One exported `const`/union of every `{ error }`
  key the `/v1` + webhook-admin surface returns (§4d); reference it from handlers + guards;
  document each. Today keys are scattered string literals.
- [ ] **Normalize sentence error values to snake_case keys.** Violations:
  PATCH contact phone returns `error: "phoneNumber is not editable…"`
  ([controller:204](../apps/api/src/external/v1/external-v1.controller.ts#L204));
  messaging service returns `error: "text required"` / `error: "user not in team"`.
  Move the human text to `detail`, use a stable key (`phone_immutable`, `text_required`,
  `user_not_in_team`).
- [ ] **Move the phone-immutability check into the Zod schema.** It's currently inline
  in the PATCH controller before the parse
  ([controller:202](../apps/api/src/external/v1/external-v1.controller.ts#L202));
  `ExternalUpdateContactSchema` even uses `.passthrough()`. Add a `.refine()` (or a
  `.strict()` that rejects `phoneNumber`) so the controller just does `zBody(...)` like
  every other route — and drop the bespoke `safeParse` block.
- [ ] **Resolve the media-send stub.** `POST /v1/messages` with `media` returns 400
  `media_not_yet_supported`
  ([messaging.service:754](../apps/api/src/external/v1/external-v1-messaging.service.ts#L754)).
  Either wire URL→upload→send, or formalize it as a documented **`501 not_implemented`**
  (not a 400). Pick one and document it.
- [ ] **Fix the stale controller doc-comment.** The `POST /v1/messages` JSDoc says
  "Media + template sends are stubbed… service returns 400"
  ([controller:463](../apps/api/src/external/v1/external-v1.controller.ts#L463)), but
  **template send is implemented**
  ([messaging.service:796](../apps/api/src/external/v1/external-v1-messaging.service.ts#L796)).
  Only media is stubbed. Correct the comment.
- [ ] **Surface the rate-limit signal.** Add `Retry-After` to the 429 from `ApiKeyGuard`
  ([api-key.guard.ts:99](../apps/api/src/auth/api-key.guard.ts#L99)); consider
  `X-RateLimit-Remaining`. Document all three limits (60/min key, 600/min controller,
  20/min bulk tag).
- [ ] **De-dupe idempotency-key handling.** The trim + 1–255 length check is copy-pasted
  across both send handlers
  ([controller:472](../apps/api/src/external/v1/external-v1.controller.ts#L472),
  [:511](../apps/api/src/external/v1/external-v1.controller.ts#L511)). Extract a tiny
  helper (or a param decorator).
- [ ] **Document intentional asymmetries.** Bulk tag ops return counts only (not resources);
  contact-keyed actions resolve the most-recent conversation; `channel_id` is advisory.

### Webhooks

- [ ] **Fix `extractOriginApiKeyId` (real bug).** It reads `data.changed_by` and
  `data.note.author` objects
  ([worker.ts:391](../apps/api/src/lib/outbound-webhooks/worker.ts#L391)), but the actual
  public shapes use flat `changed_by_user_id` / `changed_by_api_key_id` and
  `author_user_id` (§4f). So `X-CCP-Origin-Key` is set **only** for `message.sent` and is
  silently absent on contact/conversation/note mutations made via an API key — defeating
  loop detection for those. Either read `changed_by_api_key_id` from the real shapes, or
  carry a structured actor on the envelope. Document the final contract.
- [ ] **Fix the `event_id` JSDoc.** It claims the value "Matches the **X-CCP-Event-Id** +
  X-CCP-Delivery headers"
  ([public-events.ts:397](../packages/shared/src/outbound-webhooks/public-events.ts#L397)),
  but no `X-CCP-Event-Id` header is sent — only `X-CCP-Delivery` (id) and `X-CCP-Event`
  (type). Correct the comment.
- [ ] **Refresh the stale sample payloads.** `PUBLIC_EVENT_GROUPS` `samplePayload` blocks
  still show flat `media_kind` / `media_caption`
  ([public-events.ts:110](../packages/shared/src/outbound-webhooks/public-events.ts#L110),
  [:156](../packages/shared/src/outbound-webhooks/public-events.ts#L156)) — but
  `PublicMessage` now uses the `media` object (§4f). These feed the docs page + the
  create-webhook UI; update them to the `media` shape.
- [ ] **Add a delivery-replay endpoint.**
  `POST /api/team/outbound-webhooks/:id/deliveries/:deliveryId/retry` that re-enqueues
  the **original** persisted `payload` (distinct from the synthetic `/test`). The
  `OutboundWebhookDelivery.payload` column already exists for exactly this.
- [ ] **Make `AUTO_DISABLE_THRESHOLD` env-configurable** with a sane default (20), matching
  the posture of `WEBHOOK_WORKER_CONCURRENCY` / `WEBHOOK_ORPHAN_GRACE_MS`
  ([worker.ts:32](../apps/api/src/lib/outbound-webhooks/worker.ts#L32)). Wire it into
  `docker-compose.yml` `api.environment`.
- [ ] **Ship a reference receiver verifier.** Node + curl snippet that verifies
  `X-CCP-Signature`, with a sample payload + the expected digest, so partners can self-test.
- [ ] **Document the at-least-once + dedup-by-`event_id` contract prominently** (worker
  comment → public doc) and **cap or document payload size** so large
  `custom_fields` / media metadata don't break the POST body.

---

## 6. Documentation deliverables (part of class-A, not optional)

- **One integrations reference doc** — build on
  [docs/external-api-webhook-payloads-2026-05-20.md](external-api-webhook-payloads-2026-05-20.md),
  covering: auth (keys, scopes, rate limits, idempotency); every `/v1` endpoint
  (method, path, scope, request, response, errors); the webhook envelope + every public
  event + payload; signing + verification; retries / breaker / replay; and a changelog.
  §4 of this file is the seed content.
- **OpenAPI 3.1 spec for `/v1`, generated from the Zod schemas** — single source of
  truth (e.g. `zod-to-openapi`). Do **not** hand-maintain a parallel spec.

## 7. Out of scope / don't

- Don't add a second messaging channel — `channel` stays `meta_cloud` (the envelope field
  is forward-compat scaffolding only).
- Don't move rate-limit buckets to Redis (deferred until a 2nd app instance).
- Don't break the wire format silently — version + document any change.
- Don't add tests unless asked.
- Don't "fix" the deliberate omissions: `message.sent` lightweight contact, the bulk
  DELETE per-contact (non-coalesced) events.

## 8. Verification

- `npm run typecheck && npm run api:typecheck` — both green.
- **Smoke-boot** (typecheck-green is NOT sufficient for NestJS DI / shared-lib changes):
  `npm run dev` + `npm run api:dev`, confirm `/api/health` healthy.
- **End-to-end**: create a scoped API key → `curl` one route per group (contacts /
  catalog / conversations / messages / notes) → register a webhook → fire `POST /:id/test`
  **and** a real event (e.g. inbound message) → verify `X-CCP-Signature` with the reference
  snippet → confirm the `OutboundWebhookDelivery` row → exercise the new replay path.
- Confirm 429 now carries `Retry-After`; confirm `X-CCP-Origin-Key` is present on a
  contact mutation made via an API key.
- Show a short **before/after** for each gap closed in §5.
