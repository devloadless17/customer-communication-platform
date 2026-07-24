# Engineering Handbook — Omnichannel Shared Inbox

This is the single source of truth for how this repository is designed and how future code must be written. Read it before making changes. Deep operational detail lives in [`docs/`](docs/) (linked throughout) so this file stays scannable.

> **Prime directive.** Build a world-class, realtime, collaborative shared-inbox platform that is **simple, layered, predictable, and fast**. Every part must be clean, solid, and wired to the next through clear seams, so any one part can change or fail without breaking the rest. When in doubt, choose the simpler design.

---

## 1. What this is

A web platform where an organization's team members collaborate on customer conversations across many channels from one shared inbox — the class of product defined by **Respond.io, Trengo, Front, Intercom, Missive**. Agents receive customer messages, reply, assign each other, change status / stage / tags / custom fields, leave internal notes, run automations, place calls, and send broadcasts — with **every state change reflected live to everyone on the team**.

It is **channel-agnostic**. WhatsApp, Facebook Messenger, Instagram DMs, and the first-party web chat widget are live today; Telegram, TikTok, SMS, Email, and Voice/Calling are designed-for and plug in through one abstraction. **Never design anything around WhatsApp only.**

The whole thing runs on **one Hostinger KVM2 VPS (8 GB)** serving ~30 organizations. This is a deliberate constraint, not a limitation to engineer around: the architecture is tuned to be excellent at this scale and to grow only when a *named* scaling cliff is hit (see §16). Do not add infrastructure (Kafka, Kubernetes, multi-region, a second datastore) speculatively.

---

## 2. Product model

```
Organization → Workspaces → Channels → Accounts
                    ↓
              Users (per-workspace roles) · Contacts/Customers · Conversations → Messages · Tickets
```

- **Organization** — the tenant/billing root. Holds the user directory, the plan, the
  org-approval gate, and `maxWorkspaces` (super-admin controlled, **default 2**). Nothing
  operational lives here.
- **Workspace** — **the data-isolation boundary**. Every row in the database belongs to one
  (`workspaceId` everywhere, in the `where` of every query). This is the renamed `Team`: a
  fully separate inbox with its own channels, contacts, conversations, tags, stages, tickets
  and team chat. Nothing is shared between workspaces except the people you put in both.
- **Workspace vs Team — the rule.** A **workspace** is HARD separation (its own
  contacts, channels, inbox, tickets — nothing crosses). A **team** is SOFT separation
  INSIDE one workspace (`AssignmentPolicy` — Sales vs Support sharing the same customers
  and tickets). If two groups need to hand work to each other they are teams in one
  workspace, not two workspaces. This is why tickets are workspace-scoped and never
  cross-workspace: a `Ticket` binds a `conversationId` the other workspace cannot read,
  and `number` is unique per workspace.
- **User** — belongs to ONE organization (`orgRole`: owner / admin / member) and joins many of
  its workspaces via `WorkspaceMember`, holding a **separate role per workspace**
  (admin / manager / agent). Platform operators are `User.isSuperAdmin` — a flag orthogonal to
  every workspace, NOT a role value.
- **Channel connection** — one **account** on one channel (`ChannelConnection`, unique on
  `(workspace, channel, externalAccountId)`). A workspace can hold several WhatsApp numbers or
  Pages; a reply always goes out the account the customer messaged.
- **Contact** — a *channel identity* (a WhatsApp number, an Instagram handle). Adopted target: many contacts roll up to one **Customer** (a person) for a unified profile — see §6.
- **Conversation** — one thread per contact per channel. Closed threads **reopen**, they never fragment.
- **Message** — one inbound/outbound message on a conversation.
- **Ticket** — the unit of *work* on a conversation, **many per thread over time**. See §2 note
  below and [docs/ticketing.md](docs/ticketing.md).

A conversation is the long-lived thread. A **ticket** is one piece of *work* on it, and there are many over time — the refund in March and the delivery question in June are two tickets on one unbroken thread, each with its own assignee, priority, SLA clock and outcome. Tickets are **raised deliberately** — by the agent who read the message, with a subject, a priority and an assignee. Auto-open on every inbound is a per-workspace toggle and is **OFF by default** (`Workspace.ticketAutoOpen`): the inbox already tracks every thread, so auto-opening makes a ticket mean the same thing as a conversation and fills the board with work nobody raised. The inbox is untouched either way (the board is a parallel lens joined by `Message.ticketId`). See [docs/ticketing.md](docs/ticketing.md).

Collaboration primitives on a conversation: **assignment** (manual, or routed by admin-configured policies — see [docs/assignment.md](docs/assignment.md)), **status** (open/pending/closed), **stage** (pipeline), **tags**, **custom fields**, **internal notes**, and **saved views** (a named, reusable filter over the list — personal or shared with the workspace). Around them: **triggers → workflows → actions** (automation), **outbound webhooks** (notify external systems), **broadcasts** (bulk templated outbound), the external **`/v1` API** (n8n/Zapier/partners), and **calling** (WhatsApp Business Calling over WebRTC).

Everything in the app revolves around the conversation. The inbox is the heart of the product and must always be the highest-quality, most realtime surface.

---

## 3. Stack

- **Monorepo**: pnpm workspaces + Turborepo. Node 24. **There is no root `lib/`** — shared code is the `@ccp/shared` package + each app's own `src/lib`.
  - `apps/api` (`@ccp/api`) — **NestJS**: HTTP controllers, Socket.io gateway, webhook ingest, BullMQ workers, workflow engine, event bus. Owns every backend concern except auth pages.
  - `apps/web` (`@ccp/web`) — **Next.js** (App Router, RSC): rendering + Better Auth pages only.
  - `packages/shared` (`@ccp/shared`) — framework-agnostic types/contracts (events, providers, socket events, auth permissions, workflow shapes).
  - `packages/config` (`@ccp/config`).
- **Database**: PostgreSQL 16 via **Prisma 7.8** (pg driver adapter). Schema at repo root: `prisma/schema.prisma`. One `PrismaService` per process.
- **Realtime**: **Socket.io**, hosted **inside NestJS** (same process as the event sources = zero cross-process emit latency).
- **Queues / cache**: **Redis 7.4** + **BullMQ** (workers run in-process by default).
- **Auth**: **Better Auth**, **in Next.js** (login/logout/signup, cookie issuance). NestJS only *validates* the session cookie via Prisma.
- **Media**: **Cloudflare R2** (private bucket, team-prefixed keys, presigned GETs streamed same-origin).
- **Edge**: **Caddy** (auto-HTTPS, WebSocket upgrade, routes `/`, `/_next/*`, `/api/auth/*` → web; `/api/*`, `/webhooks/*` → api).
- **Two processes, one `docker-compose`, one VPS.** No microservices.

Stack guardrails (don't suggest these — they were considered and rejected for this project): Pusher/Ably/Supabase Realtime, tRPC, GraphQL, Zustand, React Query, Kafka, Kubernetes, Evolution/Baileys, any rewrite.

---

## 4. Layered architecture

Strict layering. Each layer has one responsibility and never leaks another's implementation details.

```
Presentation      Next.js RSC + client components (apps/web/src)
      ↓
Application        NestJS controllers + Socket.io gateway (apps/api/src/<domain>)  — THIN
      ↓
Domain             business logic: apps/api/src/lib/** + @ccp/shared
      ↓
Infrastructure     Prisma, Redis/BullMQ, Socket.io emitter, R2
      ↓
Providers          MessagingProvider adapters (Meta today) — apps/api/src/lib/providers
```

**The rule: business logic never lives in a controller, a websocket gateway, a repository, a queue processor, or a provider.** Controllers validate input, call a domain service, and shape the response. Gateways route socket frames. Providers translate wire shapes. All decisions, rules, and orchestration live in domain services (`apps/api/src/lib/**`) that are framework-agnostic and independently testable.

This is what lets one layer change without breaking the rest. Swap a provider, move a controller, retune the socket layer — the domain doesn't notice. Preserve these seams.

---

## 5. Channels are pluggable

Full recipe + per-channel constraint table: **[docs/adding-a-channel.md](docs/adding-a-channel.md)**.

- One discriminator: the `Channel` enum. **Live today**: `whatsapp`, `messenger`, `instagram`, `webchatwidget` (each has a registered provider + onboarding; `webchatwidget` is first-party, no vendor). **Designed-for / disabled**: `telegram`, `email`, `sms` — the enum value + capability/identity/label maps exist so the architecture is ready, but there's no provider/webhook/onboarding yet, so no row can carry them. `@ccp/shared/providers/capabilities` exposes `LIVE_CHANNELS` + `isChannelLive()`; shipping a designed-for channel = add its provider/webhook/onboarding **and** add it to `LIVE_CHANNELS`. **No `provider`/`vendor` column anywhere** — which vendor implements a channel is an impl detail, never stored. Meta Cloud serves WhatsApp/Messenger/Instagram; they are distinct *channels* because the channel is the medium, not the vendor.
- `MessagingProvider<C>` interface (`packages/shared/src/providers/types.ts`): declarative `capabilities`, a pure `parseWebhook(payload) → NormalizedEvent[]`, `sendText`, and optional media/template/calling methods. The only impl today is the `metaProvider` object in `apps/api/src/lib/providers/meta.ts`.
- Registry `getProviderBinding(channel)` (`apps/api/src/lib/providers/index.ts`) → `{ provider, getSendConfig(workspaceId, accountId?) }`. Per-(workspace, channel, account) credentials live on `ChannelConnection` (`config` + envelope-encrypted `secrets`), loaded/cached by `apps/api/src/lib/providers/config.ts`.

**Adding a channel** = new `Channel` value + a `MessagingProvider` impl + a registry entry + a `ChannelConnection` row (+ a fanout rule only if it introduces new event types). Ingest, dedup, realtime, workflows, and the `/v1` API are untouched because they operate on `NormalizedEvent` + `Channel`, never a vendor shape.

Model each channel's rules (24h window, templates vs free-form, rate limit) as `capabilities` flags so the reply box and broadcast logic derive behavior from the capability — never a hardcoded `if (channel === "whatsapp")`.

---

## 6. Customer identity

Full design + current state: **[docs/identity.md](docs/identity.md)**.

The platform adopts a **unified customer identity**: a `Customer` (person) owns many channel-scoped `Contact` rows, so an agent sees one profile across all a person's channels. Threads stay **per-contact/per-channel** (we never merge message histories) — the customer is a profile-and-switcher layer over separate threads.

Discipline that keeps this simple and safe:
- **Auto-merge only on deterministic strong keys** (exact phone; exact email **only when self-asserted** via the contact-share chip — an agent-typed or CSV-imported email never auto-merges). **No fuzzy/name matching, ever.** A strong key requires a **vendor-verified** identity, so ephemeral-channel contacts are excluded from the strong-key *candidate set* in both directions — a value typed into the widget's public pre-chat box is stored but never acts as a key.
- **Ephemeral contacts.** `EPHEMERAL_CONTACT_CHANNELS` (webchatwidget today) are chat sessions, not directory entries: a per-browser `vis_<uuid>` with no durable address. They're hidden from the contacts list / CSV / audience counts / search — but full-quality in the inbox, and workflows still fire. Directory membership is **derived** (has a phone or email), so a visitor who self-identifies is promoted automatically. See [docs/identity.md](docs/identity.md).
- Everything else is **manual, reversible merge/split**. Merge never deletes a contact or its messages — it only re-points `Contact.customerId`. (A persisted audit record for merges is designed but **not yet built** — see gaps below.)
- Identity resolution runs in **exactly one place** (`IdentityService.resolveCustomerId` in the domain layer, called from ingest + a drift sweeper), tenant-scoped.

**Current state**: **shipped** (built alongside Messenger + Instagram). The `Customer` model + `Contact.customerId` exist; auto-merge on exact phone/email runs via `IdentityService` (inline at ingest + drift sweeper); manual reversible merge/split (`CustomersService.link`/`unlink`) + the "linked channels" switcher UI are live. Per-`Customer` **omnichannel broadcast targeting** is now built — a `targetMode:'customer'` broadcast reaches each person ONCE on their best live channel (`bestChannelForCustomer` + per-recipient runner routing; "People (best channel)" mode in the broadcast composer). **Not yet built**: lifting person-level fields onto `Customer` + a contacts-list page rollup by person (workflow actions still target channel-scoped `Contact`s outside the `customer` step target). Gaps tracked in [docs/identity.md](docs/identity.md).

---

## 7. Data model spine

Real entities (`prisma/schema.prisma`; ERD in [docs/schema-erd.md](docs/schema-erd.md)):

`Team → User → ChannelConnection`; `Contact → Conversation → Message`; plus `ContactStage`, `ContactFieldDefinition`, `Tag`, `InboxView` (saved inbox filters — shared or personal; the criteria are one validated JSON document turned into SQL in exactly one place, `lib/inbox-views/where.ts`), `AudienceGroup`, `Broadcast`/`BroadcastRecipient`, `WhatsappPortfolio` (the business portfolio a WhatsApp number belongs to — since 2025-10-07 the 24h messaging cap is PORTFOLIO-scoped, shared by every number in it), `TemplateAnalyticsDaily` (Meta's own per-template daily rollup — the only source of currency cost + unique link clicks), `InternalNote`, `Workflow`/`WorkflowRun`/`WorkflowContactState`, `TeamApiKey`, `OutboundWebhook`/`OutboundWebhookDelivery`, `OutboundEvent` (outbox), `ConversationEvent` (audit timeline), `ContactTransferJob` (contact import/export runs), `Ticket`/`TicketEvent`/`TicketSlaPolicy`/`TicketFieldDefinition`/`TicketNumberCounter` (the work items on a conversation — many per thread; see [docs/ticketing.md](docs/ticketing.md)), the team-chat models (a deliberately separate message graph — channels **and** 1:1 DMs share `TeamChannel` via a `kind` discriminator; see [docs/team-chat.md](docs/team-chat.md)), `Call`/`CallPermissionRequest`, `OutboundSendAttempt` (send-idempotency ledger).

**Non-negotiable data invariants:**
- **`workspaceId` on every table**, and in the `where` of every query — sourced from `req.session.workspaceId` (resolved server-side from the membership-validated `ccp.ws` cookie / `Session.activeWorkspaceId`) or `req.apiKey.workspaceId`, **never** from client input. There is no Prisma middleware / RLS; tenant isolation is manual and load-bearing.
- **One conversation per contact**: `@@unique([workspaceId, contactId])` on `Conversation`. Closed threads reopen; they never fragment.
- **Dedup**: `@@unique([workspaceId, channel, externalId])` on `Message` and on `Call`. Meta delivers at-least-once — always `upsert` / `findUnique`-gate, never a bare `create` on inbound.
- **`Contact` is channel-scoped** (`identityChannel`, phone *or* `externalContactId`), carries a `version` CAS token and a soft-delete tombstone.
- **Keep raw payloads**: `Message.rawPayload` holds the original webhook body — critical for debugging every channel.
- Credentials: `ChannelConnection.secrets` is **envelope-encrypted** (AES-256-GCM, `ENCRYPTION_KEY`); `TeamApiKey` tokens are **SHA-256 hashed** (irreversible). Never store a secret in plaintext.

Database philosophy: normalize by default; denormalize only for a measured performance win (e.g. `Conversation.lastMessagePreview`, `unreadCount`, `Contact.lastInboundAt` — each backed by a drift sweeper). Add an index only when a real query needs it. Use a transaction where consistency matters; use the `version` CAS for optimistic concurrency where it does. Keep it simple.

---

## 8. Message lifecycle

**Inbound** (one clear owner per step):
```
Meta → Caddy → NestJS webhook controller → HMAC verify (raw body)
  → provider.parseWebhook → NormalizedEvent[] → dedupe (workspaceId+channel+externalId)
  → Prisma upsert → publish DomainEvent
  → [realtime fanout] · [audit] · [analytics] · [workflow dispatch] · [outbound webhooks]
```
Media is downloaded async (row commits `mediaPending`, then `message.media_ready` publishes once bytes land in R2). Fail-soft: Meta retries any non-2xx, so parse/ingest failures return `200 {dropped}`; only transient DB errors throw `503` for redelivery. Detail in [docs/events.md](docs/events.md).

**Outbound**:
```
Browser REST / v1 API → idempotency gate (OutboundSendAttempt) → message-sends queue
  → provider.sendText/Media/Template → Meta → persist status → publish message.sent
  → realtime fanout → workflows → outbound webhooks → analytics
```
A send is non-idempotent and bills the team, so `/v1` sends **require** an `Idempotency-Key`, and the `OutboundSendAttempt` ledger (keyed by BullMQ jobId) prevents a double Meta send across a worker restart.

---

## 9. Event model

Full detail: **[docs/events.md](docs/events.md)**.

**Events are notifications, not business logic.** They announce a change that already committed. Rules:
- Every event has **one owner** (the publisher) and **one purpose**. A subscriber reacts; it never owns the mutation.
- **No recursive event chains.** A subscriber must not emit an event that re-triggers itself. Workflow-driven events carry `silent`/`skipOutboundWebhook` for exactly this loop safety.
- **Naming**: `<entity>.<past_tense_change>` (e.g. `message.received`, `conversation.status_changed`). Additive only — a name is a contract.
- **Payloads** carry `workspaceId` + enough context for subscribers to react **without a DB re-read**.
- **Idempotency & ordering**: consumers tolerate at-least-once redelivery; assume ordering only within a single publish's priority tiers, never across events.

The bus (`apps/api/src/lib/events/bus.ts`) is a **two-tier priority dispatch**: the realtime frame goes out first (CRITICAL tier), then background subscribers run detached from the HTTP response in a fixed order (`AUDIT 10 → ANALYTICS 20 → WORKFLOW_DISPATCH 30 → OUTBOUND_WEBHOOKS 50`) — the order is load-bearing because dispatch/webhooks re-read state analytics writes. A durable transactional **outbox** + drainer covers crash-safety. **Invariant: never subscribe audit or workflow to `broadcast.*`** (a 1k-recipient broadcast must not write 1k audit rows or fire 1k workflows).

---

## 10. Realtime model

Full detail: **[docs/realtime.md](docs/realtime.md)**. This is the app's highest-quality bar.

- **Emit only after a successful state change. Frames are small, scoped, idempotent — never speculative, never duplicate, never unchanged.**
- **Rooms** (`apps/api/src/realtime/rooms.ts`): `team:` / `conv:` / `chan:` / `user:`. Fanout scope is deliberate (`fanout-rules.ts`): team-wide frames only for what every agent needs; thread frames (`message:status`, typing, broadcast recipient frames) scoped to the conversation room to avoid team-room storms.
- **Frontend**: pure reducers (`apps/web/src/features/inbox/lib/thread-reducers.ts`) shared by three consumers (live hook, LRU cache shell, contact panel) via a table-driven wiring, with a dev-time `assertReducerCoverage` invariant and a monotonic message-status guard. Wire a new per-thread event into **all three** or a chat-switch reverts to a stale snapshot.
- **Unread is team-wide only.** `markRead` fires only when the agent is actually viewing (visible + on-thread); a hidden tab never clears unread for a message nobody saw. Every recovery path (live / delta backfill on open / full refetch on reconnect) converges to server state, and the list badge clears via a local `conversation:read` dispatch, not the one-shot server frame.

Minimize socket traffic and re-renders: coalesce bursts, return the same reference when nothing changed, subscribe only to data a view actually needs.

---

## 11. Workflow model

Engine internals: [apps/api/src/lib/workflows/README.md](apps/api/src/lib/workflows/README.md).

```
Trigger (domain event) → Conditions → Step actions → Completion
```
- Engine in `apps/api/src/lib/workflows/` (DAG runner, dispatcher, conditions, ~22 step types incl. `send_message`, `assign_to`, `set_status`, `add_tag`, `branch`, `wait`, `ask_question`, `http_request`, `trigger_workflow`, and the ticket family (`create_ticket`, `set_ticket_status`, `set_ticket_priority`, `assign_ticket`)); NestJS seam in `apps/api/src/workflows/`.
- **Deterministic and loop-safe.** Guards: `MAX_STEPS_PER_RUN = 200` (= the `MAX_WORKFLOW_NODES` publish-time node cap) + dual pickup ceilings, `jump_to_step` caps, cross-system chain depth (`X-CCP-Depth`), `trigger_workflow` chain depth, and an immutable trigger-time snapshot pinned on the run. `triggerOncePerContact` uses a race-safe ledger.
- Runs on the `workflows` BullMQ queue with a per-team concurrency cap and `lockDuration = 90s` (boot-asserted to exceed the max step timeout, so a slow `http_request` can't outlive its lock and double-fire).

Protected against recursion, infinite loops, duplicate execution, and retry-induced duplicate actions — keep it that way.

---

## 12. Integrations, webhooks & the external API

- **Providers are adapters.** They translate a vendor wire shape ↔ `NormalizedEvent` and nothing else. Business logic never depends on a provider. Every external system (Meta, future Telegram/SMS/Email, n8n/Zapier/Make) is just another adapter or a webhook consumer.
- **Inbound webhooks**: HMAC-verify the raw body on every POST (`X-Hub-Signature-256`), reject malformed signatures, dedupe, keep the raw payload, fail-soft on non-2xx.
- **Outbound webhooks** (implemented): only meaningful business events; signed (`X-CCP-Signature`, HMAC-SHA256); idempotent (delivery id header); bounded retries (7 attempts, exp backoff) with auto-disable after repeated failure; a stable, versioned payload that carries enough context to avoid extra API calls. Managed under `apps/api/src/workspace-settings/outbound-webhooks/`.
- **External `/v1` API** (`apps/api/src/external/v1/`): full parity with the internal UI actions is a **locked rule** — every capability the UI has, the API has, and every endpoint is documented in both [docs/organization-api.md](docs/organization-api.md) and the in-app `/docs/api` page. Bearer API keys + scopes, mandatory `Idempotency-Key` on sends, chain-depth guard. `/v1` writes publish the same domain events as internal routes.

---

## 13. API & queue conventions

**REST**: one folder per domain (`*.controller.ts` + `*.service.ts` + `*.module.ts` + `*.schemas.ts`); controllers thin over `lib/**`.
- **Validation**: Zod everywhere via `zBody(schema)` / `zQuery(schema)` pipes (`apps/api/src/common/zod-validation.pipe.ts`). **There is no `zParam`** — params are read with `@Param` and checked inline. Reuse existing schemas; no class-validator.
- **Guards**: `SessionGuard` (Better Auth cookie via Prisma, cached), `ApiKeyGuard` + `ScopeGuard` (`@RequireScope`), role/capability guards for RBAC.
- **Rate limiting**: `@RateLimit({ perMinute })` interceptor, 300/min/user default (details + rationale in [docs/operations.md](docs/operations.md)).
- **Errors**: structured `{ error: "<snake_case_key>", … }`; Zod adds `issues`; `PrismaExceptionFilter` maps leaked Prisma errors (P2025→404, P2002→409, …). PII/`.meta` logged server-side with the correlation id, never in the body.
- **Correlation**: `X-Request-Id` via AsyncLocalStorage, minted at the edge and propagated through all fan-out fetches.
- No hidden side effects: a GET never mutates; a mutation publishes exactly the events it should.

**Queues**: async work only; bounded retries + dead-letter retention; idempotent enqueue (stable `jobId`); never a recursive or storming job. Workers run in-process (`RUN_WORKER_INLINE`, default on; prod refuses `0`). Graceful shutdown drains them cleanly — see [docs/operations.md](docs/operations.md).

---

## 14. Frontend state

Client state is **plain React**: `useState` + pure reducers (`thread-reducers.ts`) + a few small scoped contexts, driven by Socket.io frames. **No Zustand, no React Query, no Redux** (the only `@tanstack/*` dep is `react-virtual` for list virtualization). Don't reach for a global store.

Every piece of state has a single owner:
- **Server state** — fetched from NestJS (RSC pages over `INTERNAL_API_URL`; client components over `NEXT_PUBLIC_API_URL`, empty in prod = same-origin via Caddy).
- **Realtime state** — socket frames applied through the shared reducers.
- **Cached state** — the inbox LRU `ThreadCache`, converged on reconnect.
- **Client / UI / derived state** — local `useState` and computed values; never duplicated into a store.

Avoid duplicated state, unnecessary global stores, unnecessary fetching, and unnecessary cache invalidation. **Time rendering**: read "now" only from `useTzNow()`/`useNow()` and render via `<LocalTime iso format>` (string format keys) — split `tz` (stable) and `now` (60s tick) contexts so absolute timestamps don't re-render every minute and SSR/first-paint match (no flicker). Don't add a `useEffect`-set "wait for hydration" boolean.

---

## 15. Performance & UI/UX

**Performance is a feature.** Everything should feel instant. Concrete rules:
- Query shape: select only needed columns; **keyset pagination** (not offset) for lists; batch N+1s.
- Rendering: virtualize long lists; memoize; return the same reference from reducers on no-change; RAF-coalesce socket bursts; debounce/throttle input-driven work.
- Traffic: minimize socket frames (scope + coalesce) and DB round-trips; never invalidate/refetch what a socket frame already updated.
- Favor the simpler approach first; optimize against a measured cost, not a guess.

**UI/UX** must feel premium — minimal, clean, modern, fast, responsive, accessible (shadcn + Tailwind + subtle framer-motion). No layout shift, no flicker, no visual instability. Every interaction is intentional. Users must never get lost: everything findable, comfortable, and fast. **The inbox is the highest-quality surface in the app** — hold it to that bar.

---

## 16. Scalability & security

**Scale**: assume many orgs, users, conversations, messages, sockets, workflows, webhook deliveries. The current single-VPS, in-process design is correct for today; grow only at a **named cliff** (full list in [docs/operations.md](docs/operations.md)):
- second app instance → Redis Socket.io adapter + sticky sessions + move in-memory buckets/caches to Redis;
- 10k+ recipient broadcasts → **already handled in-process**: lanes are derived from the number's Meta tier (Little's Law), a process-wide in-flight ceiling bounds total send work, and recipients are keyset-paged so a 100k audience never loads whole. See [docs/campaign-analytics.md](docs/campaign-analytics.md) §6b. A dedicated worker container is NOT the plan — revisit only if a measured campaign shows interactive latency suffering;
- 50–200 tenants → add eviction to the grow-only caches.
Don't pre-build any of it.

**Security**: authentication (Better Auth), authorization (roles + scopes), **tenant isolation** (`workspaceId` in every query), input validation (Zod on every route), secrets (envelope-encrypted channel creds; hashed API keys), webhook signatures (HMAC in + out), rate limiting, an audit timeline (`ConversationEvent`), least privilege. Posture summary and controls that must not regress: see the security memory/audit docs. CSRF via `sameSite: lax`; SSRF-safe fetch for provider/webhook calls; prod env gates.

---

## 17. Coding philosophy & AI-contributor guidelines

Write code that reads like the surrounding code — match its naming, idioms, and comment density.

- **Readable over clever. Explicit over implicit. Simple over abstract.**
- Small, single-purpose functions; shallow nesting; meaningful names; consistent folder structure.
- No duplicated logic, no magic constants, no hidden coupling, **no circular dependencies, no recursive event chains, no heavy state management**.
- **Discourage overengineering.** Do not introduce an abstraction unless it *clearly reduces* complexity. One provider is enough reason to have the provider interface (it's a real seam); a speculative "manager" wrapper around one call site is not.
- **Preserve architectural consistency.** New code fits the existing layers and conventions; don't invent a parallel pattern for something the codebase already does.
- **Don't rewrite stable code** without a measurable improvement. Prefer the minimal change that fits the architecture.
- Prioritize, in order: correctness & realtime integrity → simplicity → performance → features. Stability beats a new feature.
- TypeScript strict everywhere. Prisma over raw SQL; migrations via Prisma. Don't write tests unless asked (add them after a flow works end-to-end).

When a task hits friction, do not reach for a deferred shortcut (a second channel, a new datastore, a background rewrite). Solve it within the current architecture or flag the tradeoff.

**Working with the maintainer**: code first, short note on what's non-obvious second. Surface tradeoffs (what you rejected and why, in a sentence). Flag channel-specific gotchas (24h window, template requirement, missing permission) *before* writing code. Propose a file list before scaffolding anything large.

---

## 18. Non-negotiable invariants (don't regress)

Each links to the reasoning:
- **`workspaceId` in every query**; secrets encrypted (channel creds) / hashed (API keys). — §7
- **Dedup unique keys** on `Message`/`Call`; `upsert`, never bare `create` on inbound. — §7
- **One conversation per contact** (`@@unique([workspaceId, contactId])`); reopen, don't fragment. — §7
- **No persisted `provider`/`vendor`** — the `Channel` enum is the only discriminator. — §5
- **Providers hold no business logic**; app code only sees `NormalizedEvent`. — §5, §12
- **Event tier order** (realtime → audit → analytics → workflow → webhooks); **never subscribe audit/workflow to `broadcast.*`**. — [docs/events.md](docs/events.md)
- **Automated assignment never overrides a human**: every automated caller passes `onlyIfUnassigned`, and every automated assignment writes through `assignConversation` so it is indistinguishable downstream from a manual one. — [docs/assignment.md](docs/assignment.md)
- **A template sync is authoritative ONLY for the WABA it fetched**, and a template Meta *returned* is never pruned — an unmappable status/category leaves the stored value alone rather than dropping the row. Both failure modes are silent, permanent data loss (they take `variableBindings` with them). — [docs/whatsapp-templates.md](docs/whatsapp-templates.md)
- **A carousel's card COUNT and each card's component signature are frozen at approval** — every card carries the same components, and a button's `index` is scoped to its CARD, not the message. `requiredCarouselCards` is the one authority both the UIs and the send guards read. — [docs/whatsapp-templates.md](docs/whatsapp-templates.md)
- **`MessageTemplate.parameterFormat` is the single authority on positional vs named** — never re-derive it from a regex over the body, or a template containing literal `{{word}}` copy fails every recipient with Meta error 132000. — [docs/whatsapp-templates.md](docs/whatsapp-templates.md)
- **Broadcasts never open tickets** (the runner bypasses `commitOutboundSend`); a customer's REPLY does. Same reasoning as the audit/workflow rule above. — [docs/ticketing.md](docs/ticketing.md)
- **A saved view's filter never merges by spread** — `inboxViewWhereClauses` returns independent predicates that callers AND in, so an `Unassigned` view can't clobber an agent's visibility restriction. — [docs/inbox-views.md](docs/inbox-views.md)
- **The ACTIVE WORKSPACE is resolved in exactly one place** — `resolveActiveWorkspaceId` (`@ccp/shared/auth/active-workspace`), called by the NestJS guard, the Socket.io handshake AND the Next.js RSC session. Order: membership-validated `ccp.ws` cookie → `Session.activeWorkspaceId` → first membership; the beyond-membership escape (org owner/admin, superAdmin) is always DB-verified and org-scoped. Three copies drifted once and the web silently rendered every switched session against the wrong workspace. Anything workspace-scoped that is cached (the session snapshot) is keyed by **(userId, workspaceId)**, and the per-user socket room is `user:<ws>:<uid>`. — §7
- **Org-wide actions need ORG authority.** `resolveSession` collapses a superAdmin, an org owner/admin and a plain member who admins ONE workspace all to the effective role `"admin"` — so deactivate / delete / password-reset gate on `canModifyUserAccount` (orgRole), never on the workspace role. Removing someone from a workspace goes through `lib/workspaces/remove-member.ts`, the counterpart to `provisionWorkspace`: one definition of what that transition means. — §2
- **Raw-SQL PARTIAL / expression indexes are invisible to the whole toolchain** — Prisma's DSL can't express a `WHERE`, an expression (`lower()`, `to_tsvector()`) or an operator class (`gin_trgm_ops`), so `migrate diff` and `check:prisma-fields` are both blind to them, and eight of them are UNIQUE constraints backstopping check-then-act races the app deliberately doesn't lock for. A `DROP COLUMN` silently destroys every index keyed on that column: the org→workspace rename took out six. They now live in **one hand-maintained section at the bottom of `prisma/migrations/0_init/migration.sql`** — regenerating that baseline from `schema.prisma` drops all 24 and `migrate diff` will still report "no difference", so the section must be carried by hand and verified by diffing `pg_indexes` between two real databases. `apps/api/test/partial-indexes.spec.ts` is the tripwire — keep it in lockstep with that section. — §7
- **Realtime read-state convergence** (mark-read only when viewing; all recovery paths converge; local `conversation:read` drives the badge); **team-wide unread only**. — [docs/realtime.md](docs/realtime.md)
- **Graceful shutdown**: `server.close()` before `app.close()`; keep the manual SIGTERM handler; `stop_grace_period ≥ ~100s` on api. — [docs/operations.md](docs/operations.md)
- **Heap ≤ ~75% of the service's `mem_limit`** (api 2048/3g, web 1536/2g). — [docs/operations.md](docs/operations.md)
- **`RUN_WORKER_INLINE` stays on in prod** (no external worker entrypoint exists). — [docs/operations.md](docs/operations.md)
- **`/v1` API keeps full parity with the UI**, documented in both places. — §12

---

## 19. Deferred / not now (with triggers)

- **Meta's WABA → WAAC + Messaging Account split** (phased H2 2026 → H1 2028) — Phase 1 needs **no code changes** for a single-integration app like this one; `wabaId` simply comes to mean "Messaging Account id". Per-phase triggers for `messaging_account_id`, WAAC ids and the `whatsapp_account` topic are tabulated in [docs/whatsapp-templates.md](docs/whatsapp-templates.md) §28. Don't pre-build any of it.
- **More channels** (Telegram, TikTok, SMS, Email) — the interface is ready; build one when a pilot asks. Recipe: [docs/adding-a-channel.md](docs/adding-a-channel.md). *(Messenger + Instagram are **live**, not deferred.)*
- **Messenger calling · social opt-in/proactive messaging · capability-driven broadcasting · per-`Customer` omnichannel targeting** — designed, not yet built; each is a bounded add along an existing seam. See the Meta-parity roadmap.
- **WhatsApp Embedded Signup** (no more manual credential paste) — needs Meta Tech-Provider review; after the product is worth onboarding into. [docs/onboarding-future.md](docs/onboarding-future.md).
- **Unified `Customer` implementation** — ✅ shipped (§6). Remaining: merge/split audit record + person-level field lift + omnichannel targeting.
- **Redis Socket.io adapter, standalone worker container, per-tenant media isolation, encryption-at-rest for message bodies, analytics dashboards, per-agent unread** — each has a named trigger in [docs/operations.md](docs/operations.md) / the security docs. Don't pre-build.

---

## 20. Docs index

| Topic | File |
|---|---|
| **Launch checklist**: env gates, deploy order, first-traffic checks | [docs/launch-checklist.md](docs/launch-checklist.md) |
| Operations, deploy, heap, shutdown, queues, sweepers, Caddy | [docs/operations.md](docs/operations.md) |
| Realtime: rooms, fanout scoping, reducers, read-state convergence | [docs/realtime.md](docs/realtime.md) |
| Saved inbox views: the filter document, visibility boundary, counts cadence | [docs/inbox-views.md](docs/inbox-views.md) |
| Event bus: tiers, taxonomy, subscribers, outbox | [docs/events.md](docs/events.md) |
| Assignment routing: policies, rules, capacity, campaign splits, rebalance | [docs/assignment.md](docs/assignment.md) |
| Customer identity: unified model, auto-merge rules, migration | [docs/identity.md](docs/identity.md) |
| Org → Workspaces: tenancy, membership, the three settings areas | [docs/workspaces.md](docs/workspaces.md) |
| Ticketing: the work item on a conversation, routing, SLA, reopen window | [docs/ticketing.md](docs/ticketing.md) |
| Team chat: channels, 1:1 DMs, public/private visibility, invariants | [docs/team-chat.md](docs/team-chat.md) |
| Website chat widget: embed modes, transport, media, identity | [docs/webchatwidget.md](docs/webchatwidget.md) |
| Website chat widget: **developer** guide — file map, local run, tests, invariants, debugging | [docs/webchatwidget-dev-guide.md](docs/webchatwidget-dev-guide.md) |
| Website chat widget: **customer-facing** install guide (also in-app at `/docs/webchat-install`) | [docs/webchat-install-guide.md](docs/webchat-install-guide.md) |
| Adding a channel: recipe + per-channel constraints | [docs/adding-a-channel.md](docs/adding-a-channel.md) |
| Channel accounts: several numbers/Pages per workspace, one Meta app, inbox attribution | [docs/channel-accounts.md](docs/channel-accounts.md) |
| WhatsApp templates: WABA scoping, parameter format, categories, component rules | [docs/whatsapp-templates.md](docs/whatsapp-templates.md) |
| WhatsApp Calling: wire shapes, permission, region, accept handshake, recording/transcription | [docs/whatsapp-calling.md](docs/whatsapp-calling.md) |
| Campaign analytics: the two sources, the null rules, the send-rate bucket | [docs/campaign-analytics.md](docs/campaign-analytics.md) |
| Contact import/export: CSV + Excel, streaming, at 100k | [docs/contact-import-export.md](docs/contact-import-export.md) |
| Data model ERD | [docs/schema-erd.md](docs/schema-erd.md) |
| External API reference | [docs/organization-api.md](docs/organization-api.md) |
| Local setup & dev matrix | [docs/local-setup.md](docs/local-setup.md) |
| WhatsApp onboarding (today) | [docs/customer-onboarding-whatsapp.md](docs/customer-onboarding-whatsapp.md) · [docs/whatsapp-coexistence.md](docs/whatsapp-coexistence.md) |
| Meta manual onboarding: keys/IDs per channel + troubleshooting runbook | [docs/meta-manual-onboarding.md](docs/meta-manual-onboarding.md) |
| Provider engine internals | [apps/api/src/lib/providers/README.md](apps/api/src/lib/providers/README.md) |
| Workflow engine internals | [apps/api/src/lib/workflows/README.md](apps/api/src/lib/workflows/README.md) |
| Assignment engine internals | [apps/api/src/lib/assignment/README.md](apps/api/src/lib/assignment/README.md) |
