# Class-A pass — Integrations / Webhooks / External API (prompt)

> Hand this prompt to an engineer or coding agent to bring the external `/v1` API and the
> outbound-webhooks subsystem to a class-A bar. It is grounded in the real codebase: it names
> actual files, enforces the house conventions, and targets the specific gaps found on review.
> Created 2026-05-21.

---

You are a senior backend engineer on a WhatsApp multi-agent shared-inbox SaaS (NestJS API +
Next.js web, Prisma/Postgres, BullMQ/Redis, Socket.io). Mission: take the **external `/v1` API**
and the **outbound-webhooks subsystem** from "functional" to **class-A** — structured,
consistently formatted, fully detailed, clean, and consistent with the existing codebase.
Tighten, standardize, document, and close the gaps below. Do **not** rewrite working systems and
do **not** change the public wire format silently.

## Scope (only these files)

External API:
- `apps/api/src/external/v1/` — controllers + `external-v1.service.ts` + `external-v1-messaging.service.ts`
- `apps/api/src/lib/external-shapes.ts` — wire shapes (`ExternalContact` / `ExternalConversation` / `ExternalMessage`)
- `apps/api/src/auth/api-key.guard.ts`, `apps/api/src/auth/scope.guard.ts`

Outbound webhooks:
- `apps/api/src/outbound-webhooks/` (subscriber + module)
- `apps/api/src/lib/outbound-webhooks/` (`queue.ts`, `worker.ts`, `signing.ts`)
- `apps/api/src/team/outbound-webhooks/` (admin CRUD controller / service / schemas)
- `packages/shared/src/outbound-webhooks/public-events.ts` (event catalog + envelope + mappers)
- `docs/external-api-webhook-payloads-2026-05-20.md`

## The class-A bar

1. **Structured & well-organized** — controller = HTTP only (guards, `zBody/zQuery`, delegate);
   service = logic + events; schemas colocated in `*.schemas.ts`. No business logic in
   controllers, no HTTP concerns in services.
2. **Perfect, consistent format** — every response uses a single documented envelope shape; every
   error uses `{ error: "snake_case_key", detail?, issues? }`; every webhook payload is snake_case
   under `{ event_id, event_type, occurred_at, team_id, channel, data }`.
3. **Needed details** — every endpoint and event is fully documented (method, path, scope,
   request, response, error codes); no undocumented fields or silent behaviors.
4. **Clean** — no dead code, no inline one-off validation that belongs in a schema, consistent
   naming, no copy-paste between handlers.
5. **Solid & fast** — idempotency, optimistic concurrency, rate limits, retries, and the circuit
   breaker stay intact; no N+1s; bulk paths stay coalesced.

## Non-negotiable house conventions (match existing code exactly)

- **Validation:** `zBody`/`zQuery` from `apps/api/src/common/zod-validation.pipe.ts`. Schemas
  colocated as `*.schemas.ts`; export both the `Schema` const and its `z.infer` type. Cross-field
  rules go in `.refine()`, never inline in the controller.
- **Error envelope:** `{ error: "snake_case_key", detail?, issues? }`. 400 `invalid_body` +
  `issues`, 401 `unauthorized`, 404 `not_found`, 409 `conflict`, 422 domain code, 429
  `rate_limited` + `retryAfter`. Reuse the global `prisma-exception.filter` mapping; throw Nest
  exceptions with this body shape.
- **External-API auth:** Bearer token → `api-key.guard` (SHA-256 hash lookup, `revokedAt`, 60/min
  token bucket) + `@RequireScope(...)` → `scope.guard`. Never bypass; never log raw tokens.
- **Idempotency:** `Idempotency-Key` header, CLAIM-then-execute, unique `(teamId, apiKeyId, key)`;
  refund the rate bucket on a cache hit.
- **Webhook wire format:** snake_case, envelope `{ event_id, event_type, occurred_at, team_id,
  channel, data }`. Signature header `X-CCP-Signature: t=<unix>,v1=<hmac-sha256(secret,
  ${t}.${body})>`. Any change is versioned + documented, never silent.
- **Events:** add to `DomainEventMap` (`packages/shared/src/events/types.ts`), map in
  `public-events.ts` `toPublicEnvelopes`, add a `FANOUT_RULES` entry (handler or explicit `null`),
  subscribe via `OnModuleInit`, wrap handlers in try/catch (never throw to the bus).
- **TS strict** (`noUncheckedIndexedAccess`, etc.). Prisma over raw SQL except the established
  bulk paths.

## Concrete work items (close these gaps)

External API:
- [ ] **Centralize the error-code catalog** — one exported const/union of every `{ error }` code
  the `/v1` surface returns; reference it from handlers; document each.
- [ ] **Move the phone-immutability check** (currently inline in the PATCH controller before the
  schema parse) into the Zod schema as a `.refine()`, matching house convention.
- [ ] **Resolve the media-send stub** on `POST /v1/messages` (returns generic 400 "not yet
  wired"): either wire URL-based media send, or return a documented `501 not_implemented` code —
  not a bare 400.
- [ ] **Surface rate-limit signal** — keep `Retry-After` on 429; document all limits (60/min per
  key, bulk tag ops 20/min, per-conversation send budget). Consider `X-RateLimit-Remaining`.
- [ ] **Document intentional asymmetries** — bulk tag ops return counts only (not resources);
  contact-keyed actions resolve the most-recent conversation.

Webhooks:
- [ ] **Add a delivery-replay endpoint** —
  `POST /api/team/outbound-webhooks/:id/deliveries/:deliveryId/retry` that re-enqueues the
  original payload (distinct from the synthetic `/test`).
- [ ] **Make `AUTO_DISABLE_THRESHOLD` env-configurable** (`worker.ts`) with a sane default.
- [ ] **Ship a reference receiver verifier** — Node + curl snippet for `X-CCP-Signature`, with a
  sample payload + expected digest, so partners can self-test.
- [ ] **Document the at-least-once + dedup-by-`event_id` contract** prominently (worker comment →
  public doc).
- [ ] **Cap or document payload size** so large `custom_fields`/media don't break the POST body.

## Documentation (part of class-A, not optional)

- Refresh ONE integrations reference doc (build on `docs/external-api-webhook-payloads-2026-05-20.md`)
  covering: auth (keys, scopes, rate limits, idempotency); every `/v1` endpoint (method, path,
  scope, request, response, errors); the webhook envelope + every public event + payload; signing
  + verification; retries/breaker/replay; and a changelog.
- Generate an **OpenAPI 3.1 spec for `/v1` from the Zod schemas** (single source of truth — do not
  hand-maintain a parallel spec).

## Out of scope / don't

- Don't add a second messaging channel — `channel` stays `meta_cloud` (envelope already has the field).
- Don't move rate-limit buckets to Redis (deferred until a 2nd app instance).
- Don't break the wire format silently — version + document any change.
- Don't add tests unless asked.

## Verification

- `npm run typecheck && npm run api:typecheck` (both green).
- **Smoke-boot** (typecheck-green is NOT sufficient for NestJS DI / shared-lib changes):
  `npm run dev` + `npm run api:dev`, confirm `/api/health` healthy.
- End-to-end: create a scoped API key → curl each `/v1` group → register a webhook → fire `/test`
  and a real event → verify the signature with the reference snippet → confirm the delivery row +
  the replay path.
- Show a short before/after for each gap closed.
