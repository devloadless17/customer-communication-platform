# Audit Guide — WhatsApp Multi-Agent Shared Inbox

The single, forward-looking reference for auditing this app. It replaces the
dated audit/review reports that used to live in `docs/` — every finding from
those passes was either fixed-and-shipped or recorded as a deliberate decision,
so the reports themselves were history, not guidance. **This file is the
guidance.** Keep it current; don't reintroduce per-pass report files.

`CLAUDE.md` at the repo root is the canonical source of truth for stack +
architecture; this guide is the audit-specific distillation. When they
disagree, `CLAUDE.md` wins and this file should be corrected.

---

## What the product is (one paragraph)

A multi-tenant SaaS shared inbox for WhatsApp (think Front/Intercom for the
Meta WhatsApp Cloud API). NestJS API (`apps/api`, :4000) owns every backend
concern — REST, the Socket.io gateway, webhook ingest, BullMQ workers, the
workflow engine. Next.js (`apps/web`, :3000) owns pages + Better Auth only.
Postgres (Prisma) + Redis (BullMQ), single VPS, two app containers behind host
Caddy. One pilot customer. Multi-tenancy via `teamId` on every row.

---

## How to run an audit (process)

1. **Read the invariants below first.** Most "findings" generic reviewers raise
   are locked decisions — verify against this list before reporting anything.
2. **Verify every claim against live code** (file:line). A finding without
   concrete evidence is noise.
3. **Severity bar** (most reviewers inflate — don't):
   - *critical*: cross-tenant data leak, auth bypass, data loss, double-send of
     a customer-visible message, remote compromise.
   - *high*: a correctness bug or outage path a real pilot hits in normal use.
   - *medium*: real but bounded / edge-case.
   - *low*: polish. *info*: observation.
4. **Validate fixes for real — typecheck is not enough:**
   - `pnpm typecheck --force` (turbo caching can replay stale-green after a
     Prisma regen — `--force`; run `pnpm prisma generate` after any schema edit).
   - **Smoke-boot** the API: NestJS DI failures never surface in `tsc`. The dev
     boot or the prod-imitate stack must come up clean.
   - **Pre-deploy gate:** bring up the real prod-imitate Docker stack and run the
     e2e suite — this is what catches build/runtime/migration bugs the unit
     surface misses:
     ```
     pnpm prod:local:detached     # Caddy→web→api on :8080, BOTH images built,
                                  # migrations applied on api boot
     pnpm test:e2e                # ~15 Playwright specs, the load-bearing paths
     pnpm prod:local:down
     ```
   - The e2e suite (`tests/e2e/`) is the authoritative "is it still working"
     check: health, auth, every route renders clean, socket realtime, /v1
     security, platform org gate, workflows, calls, and feature-specific specs.

---

## Architecture invariants (do NOT propose changing these)

- **Multi-tenancy from day one.** Every table has `teamId`. Every query/mutation
  must be team-scoped. The #1 thing to audit: a Prisma call keyed only by a
  client-supplied id with no `teamId` in the `where` (IDOR).
- **Provider abstraction; channel ≠ provider.** There is NO `provider` column.
  The `Channel` enum (`whatsapp`) is the only discriminator, on
  `Conversation.channel` / `Message.channel` / `Contact.identityChannel` /
  `ChannelConnection.channel`. `MessagingProvider` + `getProviderBinding(channel)`
  is the impl layer. Adding a channel = new enum value + a registered provider +
  a `ChannelConnection` row.
- **Contact = one channel identity, not a human.** Contacts are siloed per
  channel; NO cross-channel merge / Person super-entity. One conversation per
  contact (`@@unique([teamId, contactId])`); closed conversations REOPEN, never
  fragment.
- **Socket.io lives in NestJS** (same process as REST + webhooks + workflows →
  in-process emit, zero pub/sub hop). **Better Auth stays in Next.js;** the
  NestJS `SessionGuard` validates the cookie against the session table (~1ms).
- **Dedup is load-bearing.** Meta delivers `wamid` at-least-once. Inbound path is
  normalize → dedupe (`@@unique` on `externalId`) → upsert → publish → fanout.
  Never bare `create`.
- **Webhook auth = HMAC-SHA256** of the RAW body (`X-Hub-Signature-256`), verified
  on every POST, timing-safe. Raw-body capture must run before bodyParser.
- **Two processes, single VPS, single docker-compose. No microservices.**
- **Graceful shutdown is load-bearing for workers** (`apps/api/src/main.ts`):
  manual SIGTERM handler, `server.close()` BEFORE `app.close()`, drain bounded by
  compose `stop_grace_period: 100s` (> BullMQ `lockDuration: 90s`). Don't strip
  the handlers or reorder; a worker dying mid-job re-executes → double sends.

---

## Locked product decisions (constraints, NOT bugs)

Report one of these ONLY if you can demonstrate a concrete correctness/security
flaw in code — never as "you should add X".

- **No Zustand / React Query.** Client state = `useState` + pure reducers
  (`thread-reducers.ts`) driven by Socket.io frames. The realtime cache-patch
  matrix (a socket event mutating thread state must be wired in BOTH
  `thread-reducers.ts` AND `useConversationEvents` + `inbox-shell`) is the rule
  to check when realtime changes are made.
- **Unread is team-wide only** (`Conversation.unreadCount`); no per-agent inbox
  unread. Team chat has its own per-user read receipts.
- **Inbox message thread is NOT virtualized** (full `timeline.map`). A
  virtualization attempt broke media layout and was reverted — don't re-propose
  without browser verification.
- **No route-level `loading.tsx` skeletons** (NavProgress bar + hold-page).
  Sessions persist until explicit signOut (no idle timeout). Superadmin password
  is hardcoded (owner override — don't env-ify).
- **Member cap:** every org defaults to `Team.maxMembers = 2`; only a superAdmin
  raises it (platform org-detail page). Enforced at invite-create (soft) +
  invite-accept (row-locked, authoritative). superAdmins aren't org seats.
- **1 team = 1 org = 1 WhatsApp number** (`@@unique([teamId, channel])` on
  ChannelConnection). Multi-WhatsApp-per-team is intentionally unsupported.
- **No offsite DB backup** — the on-VPS nightly `pg_dump` (gzip, 14-day, cron
  auto-installed by deploy) is accepted as sufficient; VPS loss = data loss is an
  accepted risk. Don't propose S3/rclone/snapshots.
- **No encryption-at-rest** for `Message.body` / `Contact.phoneNumber` — only
  credentials (`Team.metaAppSecret`, `TeamApiKey.secret`) are envelope-encrypted.
  Trigger to revisit: enterprise compliance requirement.
- **Single shared R2 bucket** (private, `media/{teamId}/…` prefixes) across teams until ~10 customers.
- **`Contact.phoneNumber` is immutable** (it IS the WhatsApp identity).
- **Assignment never sets status `open`** (only chatting does); assign-to-closed
  → pending; close unassigns.
- Bulk contact DELETE fires per-contact events (workflow/audit granularity); bulk
  tag ops coalesce via `contact.bulk_updated` + `suppressSocketFanout`.

## Meta WhatsApp Cloud API gotchas (flag before writing code)

- **24-hour customer-service window:** free-form outbound only within 24h of the
  last inbound. Outside → pre-approved templates only.
- **No history sync:** events only from subscription onward.
- **Media templates** (IMAGE/VIDEO/DOCUMENT header) send via a `link` Meta
  fetches — a stable R2 object URL presigned fresh at send time
  (send-template-internal.ts), threaded as `variables.headerMedia` through every
  send path.
- Test recipients only while the Meta app is unpublished.

---

## Behaviors that look fixable but are correct as-is

- **Socket.io connection-state-recovery is bounded at 30s** (`ws-adapter.ts`).
  Longer offline → full refetch (`runFullRefetch` / LRU eviction), NOT a custom
  replay layer. Don't extend the window.
- **`markRead` fires on EVERY visible thread mount** (deliberate over-call; server
  short-circuits the already-read case). The conversation LIST badge clears via a
  LOCAL `conversation:read` dispatch on POST success, not the one-shot server
  frame.
- **Inbound media is 2-phase async:** webhook 200s fast, detached download,
  `mediaPending` shimmer → `message:media:ready` swap, sweeper backstop. In-band
  was reverted.
- **In-memory rate limiting** (`RateLimitGuard`, 300/min default, 60/min
  messages) — moves to Redis only when a 2nd app instance appears.
- **Optimistic socket dispatch** — any mutation that triggers a server-fanned
  socket frame must also fire it locally (`dispatchLocalSocketEvent`). This is
  intended, not redundant.
- **One "now" source** (`useTzNow`/`useNow`, SSR-stable) — never add
  `useState(null) + useEffect(Date.now())`. Time formatting splits absolute
  (subscribe to `tz`) vs relative (subscribe to `now`).

---

## Deferred on purpose (don't report absence as a gap)

Each has a trigger; until then, leave it.

- **Redis pub/sub Socket.io adapter, sticky sessions, 2nd app instance** — only
  when a 2nd instance shows up.
- **Per-team fairness caps** in the broadcast runner + outbound-webhook delivery
  — latent at 1 tenant; fix = copy the workflow worker's per-team cap.
- **Move broadcast runner to a worker** — only past ~10k recipients.
- **Embedded Signup, multi-channel (IG/SMS/email), analytics dashboards,
  per-agent unread, billing, audit-log UI, native CRM** — all post-depth-pass.
- **Cache eviction on `lib/providers/config.ts`** — past ~5 tenants.

---

## Hot paths worth the most scrutiny

- **Tenant isolation** — every controller/service/query for `teamId` scoping;
  media/blob URLs; socket room-join authorization; `/v1` API-key→team binding;
  platform (superAdmin) routes vs tenant scope.
- **Inbox realtime client state** — `thread-reducers.ts`, `use-conversation-events`,
  `inbox-shell` (LRU + snapshot-on-leave), reconnect convergence (delta vs full
  refetch), optimistic rollback, the cache-patch matrix.
- **Send pipeline** — `lib/messaging/*`, `lib/providers/meta.ts`, the
  `OutboundSendAttempt`/idempotency guards (text/media/template/interactive/
  broadcast/workflow), `metaFetch` retry semantics (must not retry non-idempotent
  send POSTs), Meta error-code normalization, 24h-window enforcement.
- **Webhook ingest** — HMAC, raw-body order, dedupe, per-team secret lookup,
  status-frame ordering, all inbound types handled (text/interactive/button/
  media/location/vCard) — none silently dropped.
- **Workflow / automation safety** — termination (no self-triggering loops), the
  `X-CCP-Depth` chain cap, step-level send budget, idempotency on BullMQ
  redelivery, the ask-question lock TTL.
- **Broadcasts** — crash-mid-flight recovery + double-send guard, scheduling CAS,
  audience snapshot semantics, rate pacing / 429 + permanent-error breakers,
  soft-deleted-contact re-check at fire time.
- **Auth/session** — the `SessionGuard`, org-approval gate (pending/active/
  suspended → `/pending`; suspension drops sockets but KEEPS the session so the
  gate can render the explanation), session invalidation on password reset.

---

## Known residual weaknesses (honest, accepted)

- **Single VPS / single socket process is the scaling ceiling** — by design for
  the pilot. First things to fall over under thousands of daily users: Redis
  memory (BullMQ needs `noeviction`), the single API event loop, in-memory rate
  limits resetting on deploy.
- **No automated test coverage beyond the e2e suite** — the invariants here are
  largely hand-verified; the e2e specs guard the load-bearing paths.

---

## Living references

- `CLAUDE.md` — canonical stack + architecture + ops notes (source of truth).
- `docs/local-setup.md` — dev environment matrix.
- `docs/schema-erd.md` — data model ERD.
- `docs/onboarding-future.md` — Embedded Signup playbook (post-MVP).
- `tests/e2e/` — the executable pre-deploy gate.
