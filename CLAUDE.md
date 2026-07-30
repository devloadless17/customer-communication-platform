# Engineering Handbook — Omnichannel Shared Inbox

This is the single source of truth for how this repository is designed and how future code must be written. Read it before making changes. Deeper detail lives beside the code it describes (see §20) so this file stays scannable — there is no `docs/` tree, it was removed as stale.

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
  workspace, not two workspaces. **The ONE thing that crosses a workspace boundary is a
  TICKET** — because a ticket IS the way two departments talk about one customer's issue.
  Escalating does not copy it: it writes a **`TicketShare`** granting a sibling workspace
  of the same org access to the SAME ticket row — one number, one status, one priority,
  one history, so nothing can drift and there is nothing to sync. `Ticket.workspaceId`
  (the owner) never moves; the share is the grant. What crosses is bounded by the share
  row, not the ticket: a frozen contact **snapshot** (never a live join into the owner's
  directory) and the guest's OWN conversation with the customer if they start one. The
  owner's conversation, its messages and their contact record stay private. Every read
  and write goes through **`ticketAccessWhere()`** (`apps/api/src/lib/tickets/access.ts`)
  — the single definition of "mine OR shared with me"; `TicketEvent.actorWorkspaceId`
  is what makes the one shared history readable ("Billing changed the status"), and
  `TicketAttachment` files are visible to every party. (This superseded a twin-pair
  design from 2026-07-28: two rows kept in sync were two truths, two numbers to quote
  and two histories to read.)
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
  below and [`apps/api/src/lib/tickets/mutations.ts`](apps/api/src/lib/tickets/mutations.ts).

A conversation is the long-lived thread. A **ticket** is one piece of *work* on it, and there are many over time — the refund in March and the delivery question in June are two tickets on one unbroken thread, each with its own assignee, priority, SLA clock and outcome. Tickets are **raised deliberately** — by the agent who read the message (or a workflow's `create_ticket` step), with a subject, a priority and an assignee. There is **no auto-open** (the `Workspace.ticketAutoOpen` toggle was removed 2026-07-25): the inbox already tracks every thread, so auto-opening would make a ticket mean the same thing as a conversation and fill the board with work nobody raised. Ingest only ATTACHES an inbound to the thread's active ticket, or REOPENS one solved inside the per-workspace reopen window (`Workspace.ticketReopenWindowHours`). The inbox is untouched either way (the board is a parallel lens joined by `Message.ticketId`). See [`apps/api/src/lib/tickets/mutations.ts`](apps/api/src/lib/tickets/mutations.ts).

Collaboration primitives on a conversation: **assignment** (manual, or routed by admin-configured policies — see [`apps/api/src/lib/assignment/README.md`](apps/api/src/lib/assignment/README.md)), **status** (open/pending/closed), **stage** (pipeline), **tags**, **custom fields**, **internal notes**, and **saved views** (a named, reusable filter over the list — personal or shared with the workspace). Around them: **triggers → workflows → actions** (automation), **outbound webhooks** (notify external systems), **broadcasts** (bulk templated outbound), the external **`/v1` API** (n8n/Zapier/partners), and **calling** (WhatsApp Business Calling over WebRTC).

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
- **Media**: **Cloudflare R2** (private bucket, team-prefixed keys, presigned GETs streamed same-origin) behind `BlobStorageProvider` — nothing outside `lib/blob-storage/` knows the vendor. `BLOB_STORAGE_DRIVER=local` swaps in a filesystem impl so CI/offline dev exercise the media paths for real; it is an explicit opt-in, never a fallback for absent R2 env, and is refused under `NODE_ENV=production`.
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

Full recipe + per-channel constraint table: **[`apps/api/src/lib/providers/README.md`](apps/api/src/lib/providers/README.md)**.

- One discriminator: the `Channel` enum. **Live today**: `whatsapp`, `messenger`, `instagram`, `webchatwidget` (each has a registered provider + onboarding; `webchatwidget` is first-party, no vendor). **Designed-for / disabled**: `telegram`, `email`, `sms` — the enum value + capability/identity/label maps exist so the architecture is ready, but there's no provider/webhook/onboarding yet, so no row can carry them. `@ccp/shared/providers/capabilities` exposes `LIVE_CHANNELS` + `isChannelLive()`; shipping a designed-for channel = add its provider/webhook/onboarding **and** add it to `LIVE_CHANNELS`. **No `provider`/`vendor` column anywhere** — which vendor implements a channel is an impl detail, never stored. Meta Cloud serves WhatsApp/Messenger/Instagram; they are distinct *channels* because the channel is the medium, not the vendor.
- `MessagingProvider<C>` interface (`packages/shared/src/providers/types.ts`): declarative `capabilities`, a pure `parseWebhook(payload) → NormalizedEvent[]`, `sendText`, and optional media/template/calling methods. The only impl today is the `metaProvider` object in `apps/api/src/lib/providers/meta.ts`.
- Registry `getProviderBinding(channel)` (`apps/api/src/lib/providers/index.ts`) → `{ provider, getSendConfig(workspaceId, accountId?) }`. Per-(workspace, channel, account) credentials live on `ChannelConnection` (`config` + envelope-encrypted `secrets`), loaded/cached by `apps/api/src/lib/providers/config.ts`.

**Adding a channel** = new `Channel` value + a `MessagingProvider` impl + a registry entry + a `ChannelConnection` row (+ a fanout rule only if it introduces new event types). Ingest, dedup, realtime, workflows, and the `/v1` API are untouched because they operate on `NormalizedEvent` + `Channel`, never a vendor shape.

Model each channel's rules (24h window, templates vs free-form, rate limit) as `capabilities` flags so the reply box and broadcast logic derive behavior from the capability — never a hardcoded `if (channel === "whatsapp")`.

---

## 6. Customer identity

Full design + current state: **[`apps/api/src/lib/identity/identity-service.ts`](apps/api/src/lib/identity/identity-service.ts)**.

The platform adopts a **unified customer identity**: a `Customer` (person) owns many channel-scoped `Contact` rows, so an agent sees one profile across all a person's channels. Threads stay **per-contact/per-channel** (we never merge message histories) — the customer is a profile-and-switcher layer over separate threads.

Discipline that keeps this simple and safe:
- **Auto-merge only on deterministic strong keys** (exact phone; exact email **only when self-asserted** via the contact-share chip — an agent-typed or CSV-imported email never auto-merges). **No fuzzy/name matching, ever.** A strong key requires a **vendor-verified** identity, so ephemeral-channel contacts are excluded from the strong-key *candidate set* in both directions — a value typed into the widget's public pre-chat box is stored but never acts as a key.
- **Ephemeral contacts.** `EPHEMERAL_CONTACT_CHANNELS` (webchatwidget today) are chat sessions, not directory entries: a per-browser `vis_<uuid>` with no durable address. They're hidden from the contacts list / CSV / audience counts / search — but full-quality in the inbox, and workflows still fire. Directory membership is **derived** (has a phone or email), so a visitor who self-identifies is promoted automatically. See [`apps/api/src/lib/identity/identity-service.ts`](apps/api/src/lib/identity/identity-service.ts).
- Everything else is **manual, reversible merge/split**. Merge never deletes a contact or its messages — it only re-points `Contact.customerId`. (A persisted audit record for merges is designed but **not yet built** — see gaps below.)
- Identity resolution runs in **exactly one place** (`IdentityService.resolveCustomerId` in the domain layer, called from ingest + a drift sweeper), tenant-scoped.

**Current state**: **shipped** (built alongside Messenger + Instagram). The `Customer` model + `Contact.customerId` exist; auto-merge on exact phone/email runs via `IdentityService` (inline at ingest + drift sweeper); manual reversible merge/split (`CustomersService.link`/`unlink`) + the "linked channels" switcher UI are live. Per-`Customer` **omnichannel broadcast targeting** is now built — a `targetMode:'customer'` broadcast reaches each person ONCE on their best live channel (`bestChannelForCustomer` + per-recipient runner routing; "People (best channel)" mode in the broadcast composer). **Not yet built**: lifting person-level fields onto `Customer` + a contacts-list page rollup by person (workflow actions still target channel-scoped `Contact`s outside the `customer` step target). Gaps tracked in [`apps/api/src/lib/identity/identity-service.ts`](apps/api/src/lib/identity/identity-service.ts).

---

## 7. Data model spine

Real entities (`prisma/schema.prisma`; ERD in [`prisma/schema.prisma`](prisma/schema.prisma)):

`Team → User → ChannelConnection`; `Contact → Conversation → Message`; plus `ContactStage`, `ContactFieldDefinition`, `Tag`, `InboxView` (saved inbox filters — shared or personal; the criteria are one validated JSON document turned into SQL in exactly one place, `lib/inbox-views/where.ts`), `AudienceGroup`, `Broadcast`/`BroadcastRecipient`, `WhatsappPortfolio` → `WhatsappBusinessAccount` → `ChannelConnection` (Meta's real hierarchy, business portfolio → WABA → business phone number: the portfolio scopes the 24h messaging cap, shared by every number under it since 2025-10-07; the WABA scopes the TEMPLATE catalog and — under Embedded Signup — owns the customer-scoped business token. A WABA legitimately holds ZERO phone numbers: ES's `FINISH_ONLY_WABA` is a completed onboarding with no number, and its template + account webhooks start arriving immediately), `TemplateAnalyticsDaily` (Meta's own per-template daily rollup — the only source of currency cost + unique link clicks), `InternalNote`, `Workflow`/`WorkflowRun`/`WorkflowContactState`, `TeamApiKey`, `OutboundWebhook`/`OutboundWebhookDelivery`, `OutboundEvent` (outbox), `ConversationEvent` (audit timeline), `ContactTransferJob` (contact import/export runs), `Ticket`/`TicketEvent`/`TicketSlaPolicy`/`TicketFieldDefinition`/`TicketNumberCounter` (the work items on a conversation — many per thread; see [`apps/api/src/lib/tickets/mutations.ts`](apps/api/src/lib/tickets/mutations.ts)), the team-chat models (a deliberately separate message graph — channels **and** 1:1 DMs share `TeamChannel` via a `kind` discriminator; see [`apps/api/src/team-chat/`](apps/api/src/team-chat/)), `Call`/`CallPermissionRequest`, `OutboundSendAttempt` (send-idempotency ledger).

**Non-negotiable data invariants:**
- **`workspaceId` on every table**, and in the `where` of every query — sourced from `req.session.workspaceId` (resolved server-side from the membership-validated `ccp.ws` cookie / `Session.activeWorkspaceId`) or `req.apiKey.workspaceId`, **never** from client input. There is no Prisma middleware / RLS; tenant isolation is manual and load-bearing. **Explicit exceptions** (each carries a `TENANCY EXCEPTION` note in the schema, and the checker's tenancy gate allowlists them): auth/root tables, seven parent-scoped children (`BroadcastRecipient`, `OutboundWebhookDelivery`, the five `TeamChannel*` satellites) that must ONLY be reached through a workspaceId-scoped query on their parent — never by a bare child id from request input — and `TicketShare`, the one deliberately cross-workspace row (owner + guest columns, no single workspaceId), reached ONLY through `ticketAccessWhere()` on the parent ticket.
- **One conversation per contact**: `@@unique([workspaceId, contactId])` on `Conversation`. Closed threads reopen; they never fragment.
- **Dedup**: `@@unique([workspaceId, channel, externalId])` on `Message` and on `Call`. Meta delivers at-least-once — always `upsert` / `findUnique`-gate, never a bare `create` on inbound.
- **`Contact` is channel-scoped** (`identityChannel`, phone *or* `externalContactId`), carries a `version` CAS token and a soft-delete tombstone.
- **Keep raw payloads**: `Message.rawPayload` holds the original webhook body — critical for debugging every channel.
- Credentials: `ChannelConnection.secrets` is **envelope-encrypted** (AES-256-GCM, `ENCRYPTION_KEY`); `TeamApiKey` tokens are **SHA-256 hashed** (irreversible). Never store a secret in plaintext.

Database philosophy: normalize by default; denormalize only for a measured performance win (e.g. `Conversation.lastMessagePreview`, `unreadCount`, `openTicketCount`, `openFlagCount`, `Contact.lastInboundAt`). **A denormalization is only as trustworthy as its reconciler**, so each one that CAN be recomputed has a drift sweeper: `Contact.lastInboundAt` (`contact-last-inbound-drift`), `Conversation.openFlagCount` (`message-flag-count-drift`), `Conversation.openTicketCount` (`open-ticket-count-drift`), the analytics counters (`conversation-analytics-drift`), `BroadcastRecipient.deliveryState` (`broadcast-delivery-drift`). **`unreadCount` is the exception and cannot have one**: there is no per-message read marker and no `lastReadAt` watermark, so it is a pure counter — incremented on inbound, CAS-zeroed by `markConversationRead` — with no derivable truth to compare against. It converges through the realtime read-state paths (§10) rather than a reconciler; making it reconcilable means adding a watermark, which is a schema change and a product decision. Do not claim a sweeper for it. Add an index only when a real query needs it. Use a transaction where consistency matters; use the `version` CAS for optimistic concurrency where it does. Keep it simple.

---

## 8. Message lifecycle

**Inbound** (one clear owner per step):
```
Meta → Caddy → NestJS webhook controller → HMAC verify (raw body)
  → provider.parseWebhook → NormalizedEvent[] → dedupe (workspaceId+channel+externalId)
  → Prisma upsert → publish DomainEvent
  → [realtime fanout] · [audit] · [analytics] · [workflow dispatch] · [outbound webhooks]
```
Media is downloaded async (row commits `mediaPending`, then `message.media_ready` publishes once bytes land in R2). Fail-soft: Meta retries any non-2xx, so parse/ingest failures return `200 {dropped}`; only transient DB errors throw `503` for redelivery. Detail in [`apps/api/src/lib/events/bus.ts`](apps/api/src/lib/events/bus.ts).

**Outbound**:
```
Browser REST / v1 API → idempotency gate (OutboundSendAttempt) → message-sends queue
  → provider.sendText/Media/Template → Meta → persist status → publish message.sent
  → realtime fanout → workflows → outbound webhooks → analytics
```
A send is non-idempotent and bills the team, so `/v1` sends **require** an `Idempotency-Key`, and the `OutboundSendAttempt` ledger (keyed by BullMQ jobId) prevents a double Meta send across a worker restart.

---

## 9. Event model

Full detail: **[`apps/api/src/lib/events/bus.ts`](apps/api/src/lib/events/bus.ts)**.

**Events are notifications, not business logic.** They announce a change that already committed. Rules:
- Every event has **one owner** (the publisher) and **one purpose**. A subscriber reacts; it never owns the mutation.
- **No recursive event chains.** A subscriber must not emit an event that re-triggers itself. Workflow-driven events carry `silent`/`skipOutboundWebhook` for exactly this loop safety.
- **Naming**: `<entity>.<past_tense_change>` (e.g. `message.received`, `conversation.status_changed`). Additive only — a name is a contract.
- **Payloads** carry `workspaceId` + enough context for subscribers to react **without a DB re-read**.
- **Idempotency & ordering**: consumers tolerate at-least-once redelivery; assume ordering only within a single publish's priority tiers, never across events.

The bus (`apps/api/src/lib/events/bus.ts`) is a **two-tier priority dispatch**: the realtime frame goes out first (CRITICAL tier), then background subscribers run detached from the HTTP response in a fixed order (`AUDIT 10 → ANALYTICS 20 → WORKFLOW_DISPATCH 30 → OUTBOUND_WEBHOOKS 50`) — the order is load-bearing because dispatch/webhooks re-read state analytics writes. A durable transactional **outbox** + drainer covers crash-safety. **Invariant: never subscribe audit or workflow to `broadcast.*`** (a 1k-recipient broadcast must not write 1k audit rows or fire 1k workflows).

---

## 10. Realtime model

Full detail: **[`apps/api/src/realtime/fanout-rules.ts`](apps/api/src/realtime/fanout-rules.ts)**. This is the app's highest-quality bar.

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
- **Two inbound callbacks, one ingest body.** `POST /webhooks/meta/:workspaceId` (today: every workspace brings its own Meta app) and `POST /webhooks/meta` (app-level, for Embedded Signup — the workspace is resolved FROM the verified payload). The app-level route is not optional once you are a Tech Provider: Meta's docs state that per-WABA / per-number `override_callback_uri` covers only `messages`, `message_echoes`, `calls`, `consumer_profile`, `messaging_handovers`, the group topics, `smb_*`, `history` and `account_settings_update` — **template webhooks and `account_update`/`account_review_update`/`account_alerts` are ALWAYS delivered to the app's default callback URL**. Order is load-bearing: verify the HMAC (platform `META_APP_SECRET`, comma-separated for rotation) BEFORE resolving the tenant, or an unauthenticated body drives DB lookups. Never guess a tenant — an ambiguous payload drops with a warn. **Corrected 2026-07-30**: this section used to claim that for `account_update`, `entry[].id` is the customer's BUSINESS PORTFOLIO id. The current `account_update` reference **refutes** that — it documents `entry[].id` as the WhatsApp Business Account id, and both 2026 example payloads (`ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`) show a WABA id there; the portfolio appears only at `value.waba_info.owner_business_id`. The resolver is deliberately tolerant (it tries `value.waba_info.waba_id` → `entry[].id` as a WABA → `entry[].id` as a portfolio, and drops rather than guessing on several matches), so nothing is broken — but do NOT "fix" `parseWebhook` to read `entry[].id` as a portfolio to match the old claim: several `account_update` events carry no `waba_info` block at all, and health attribution for exactly those would then land nowhere, silently. — [`apps/api/src/lib/providers/app-level-webhook.ts`](apps/api/src/lib/providers/app-level-webhook.ts)
- **External `/v1` API** (`apps/api/src/external/v1/`): full parity with the internal UI actions is a **locked rule** — every capability the UI has, the API has, and every endpoint is documented on the in-app `/docs/api` page ([`apps/web/src/app/docs/api/page.tsx`](apps/web/src/app/docs/api/page.tsx)). `scripts/check-v1-docs.mjs` enforces BOTH halves mechanically: every route carries `@RequireScope` (`ScopeGuard` is permissive by default, so an undecorated route is reachable by any valid key) and appears on that page. Bearer API keys + scopes, mandatory `Idempotency-Key` on sends, chain-depth guard. `/v1` writes publish the same domain events as internal routes.

---

## 13. API & queue conventions

**REST**: one folder per domain (`*.controller.ts` + `*.service.ts` + `*.module.ts` + `*.schemas.ts`); controllers thin over `lib/**`.
- **Validation**: Zod everywhere via `zBody(schema)` / `zQuery(schema)` pipes (`apps/api/src/common/zod-validation.pipe.ts`). **There is no `zParam`** — params are read with `@Param` and checked inline. Reuse existing schemas; no class-validator.
- **Guards**: `SessionGuard` (Better Auth cookie via Prisma, cached), `ApiKeyGuard` + `ScopeGuard` (`@RequireScope`), role/capability guards for RBAC.
- **Rate limiting**: `@RateLimit({ perMinute })` interceptor, 300/min/user default (details + rationale in [`deploy/README.md`](deploy/README.md)).
- **Errors**: structured `{ error: "<snake_case_key>", … }`; Zod adds `issues`; `PrismaExceptionFilter` maps leaked Prisma errors (P2025→404, P2002→409, …). PII/`.meta` logged server-side with the correlation id, never in the body.
- **Correlation**: `X-Request-Id` via AsyncLocalStorage, minted at the edge and propagated through all fan-out fetches.
- No hidden side effects: a GET never mutates; a mutation publishes exactly the events it should.

**Queues**: async work only; bounded retries + dead-letter retention; idempotent enqueue (stable `jobId`); never a recursive or storming job. Workers run in-process (`RUN_WORKER_INLINE`, default on; prod refuses `0`). Graceful shutdown drains them cleanly — see [`deploy/README.md`](deploy/README.md).

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

**Scale**: assume many orgs, users, conversations, messages, sockets, workflows, webhook deliveries. The current single-VPS, in-process design is correct for today; grow only at a **named cliff** (full list in [`deploy/README.md`](deploy/README.md)):
- second app instance → Redis Socket.io adapter + sticky sessions + move in-memory buckets/caches to Redis;
- 10k+ recipient broadcasts → **already handled in-process**: lanes are derived from the number's Meta tier (Little's Law), a process-wide in-flight ceiling bounds total send work, and recipients are keyset-paged so a 100k audience never loads whole. See [`apps/api/src/lib/analytics/template-analytics.ts`](apps/api/src/lib/analytics/template-analytics.ts) §6b. A dedicated worker container is NOT the plan — revisit only if a measured campaign shows interactive latency suffering;
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
- **Inbound account attribution is PER-EVENT, never per-POST.** Meta's contract is that "multiple changes from different objects that are of the same type may be batched together" (≤1000 updates, batching guaranteed in neither direction), so ONE webhook body can carry traffic for several of a workspace's numbers / Pages / IG accounts. Parsers stamp `NormalizedEvent.externalAccountId` per change (WhatsApp) or per entry (social); the route calls `groupEventsByInboundAccount` and ingests once per group. Resolving one account for a body re-pointed the sibling's threads, so the next reply went out a number with **no open 24h window**. — [`apps/api/src/lib/providers/inbound-accounts.ts`](apps/api/src/lib/providers/inbound-accounts.ts)
- **A WABA is an entity, and every template names it.** `MessageTemplate.wabaAccountId` is a NOT NULL FK and `WhatsappBusinessAccount.externalWabaId` is GLOBALLY unique — that index is the tenancy guard, because Meta delivers a WABA's webhooks to whichever app is subscribed. A missing WABA on the SENDING account is a hard refusal (`waba_unknown`), never "no opinion": the old `""` sentinel made the cross-account guard a no-op, so a WABA-less number could send any template in the workspace. — [`apps/api/src/lib/messaging/send-template-internal.ts`](apps/api/src/lib/messaging/send-template-internal.ts)
- **A `subscribed_apps` response describes EVERY app on the object, not us.** Both `GET /{waba-id}/subscribed_apps` (Meta ships a "Multiple apps subscribed to WABA" example) and `GET /{page-id}/subscribed_apps` ("a list of Application nodes", each with its own `subscribed_fields`) list every subscriber, and a shared object is ordinary — Coexistence, partner onboarding, a vendor the customer never detached. So "is anyone subscribed" (`data.length > 0`, or a union of every node's fields) is a DIFFERENT question from "are we", and it answers wrong in the only case that matters: our app absent, receiving nothing, reported healthy. Read our own `appId`; with no id known, fall back to any-app rather than cry wolf. The Page half also fed the self-heal's early return, so the one repair path silently no-op'd on a shared Page. — [`apps/api/src/lib/providers/meta-waba-subscription.ts`](apps/api/src/lib/providers/meta-waba-subscription.ts), [`apps/api/src/lib/providers/meta-page-subscription.ts`](apps/api/src/lib/providers/meta-page-subscription.ts)
- **Providers hold no business logic**; app code only sees `NormalizedEvent`. — §5, §12
- **Event tier order** (realtime → audit → analytics → workflow → webhooks); **never subscribe audit/workflow to `broadcast.*`**. — [`apps/api/src/lib/events/bus.ts`](apps/api/src/lib/events/bus.ts)
- **Automated assignment never overrides a human**: every automated caller passes `onlyIfUnassigned`, and every automated assignment writes through `assignConversation` so it is indistinguishable downstream from a manual one. — [`apps/api/src/lib/assignment/README.md`](apps/api/src/lib/assignment/README.md)
- **A template sync is authoritative ONLY for the `WhatsappBusinessAccount` it fetched**, and a template Meta *returned* is never pruned — an unmappable status/category leaves the stored value alone rather than dropping the row. Both failure modes are silent, permanent data loss (they take `variableBindings` with them). — [`apps/api/src/lib/templates/`](apps/api/src/lib/templates/)
- **A carousel's card COUNT and each card's component signature are frozen at approval** — every card carries the same components, and a button's `index` is scoped to its CARD, not the message. `requiredCarouselCards` is the one authority both the UIs and the send guards read. — [`apps/api/src/lib/templates/`](apps/api/src/lib/templates/)
- **`MessageTemplate.parameterFormat` is the single authority on positional vs named** — never re-derive it from a regex over the body, or a template containing literal `{{word}}` copy fails every recipient with Meta error 132000. — [`apps/api/src/lib/templates/`](apps/api/src/lib/templates/)
- **Three DIFFERENT Meta scopes govern a WhatsApp send, and conflating any two is a real bug.** The 24h unique-recipient **messaging limit** is per **PORTFOLIO** (shared by every number in it since 2025-10-07); the **template catalog** and the insights switch are per **WABA**; **throughput**, quality and the Coexistence flag are per **NUMBER**. A Coexistence number (`is_on_biz_app` — still used in the WhatsApp Business app) is hard-capped at **20 msg/s**, OUTSIDE the 80/1000 throughput ladder Meta still reports for it, so pacing it off `throughput.level` ran it 2-4× over a hard ceiling. — [`apps/api/src/lib/providers/meta-health.ts`](apps/api/src/lib/providers/meta-health.ts), [`apps/api/src/lib/broadcasts/send-rate-limiter.ts`](apps/api/src/lib/broadcasts/send-rate-limiter.ts)
- **A campaign's analytics belong to the WABA it SENT from, or to nothing.** `template_analytics` is a field on the WABA node, so when the sending account's catalog no longer holds the template `resolveCampaignTemplate` returns null rather than falling back to a same-named template on a sibling WABA — an empty panel prompts a re-sync, another account's figures silently misreport. Same rule for the capture sweeper's insights gate: it is checked **per WABA**, matching the granularity of the fetch. — [`apps/api/src/lib/analytics/template-analytics.ts`](apps/api/src/lib/analytics/template-analytics.ts)
- **Broadcasts never open tickets** (the runner bypasses `commitOutboundSend`); a customer's REPLY does. Same reasoning as the audit/workflow rule above. — [`apps/api/src/lib/tickets/mutations.ts`](apps/api/src/lib/tickets/mutations.ts)
- **A shared ticket is ONE row, and `ticketAccessWhere()` is the only place that says who may touch it.** Every ticket read AND write (board, counts, detail, timeline, update, note, comment, attachment) composes it as an AND element — never a bare `{ id, workspaceId }`, which 404s the department the ticket was escalated to, and never spread into a sibling position a later filter could overwrite. `deleteTicket` is the one deliberate exception: OWNER-only, because destroying a record several departments are working is not a guest's call. — [`apps/api/src/lib/tickets/access.ts`](apps/api/src/lib/tickets/access.ts)
- **A ticket's CAUSE is written once.** Fillable while empty, then immutable (`cause_immutable`) — clearing counts as rewriting. Everything after it (comments, notes, status moves, files) reasons against it, so a rewrite silently changes what the whole history was about. Updates travel as comments. — [`apps/api/src/lib/tickets/mutations.ts`](apps/api/src/lib/tickets/mutations.ts)
- **A new blob-owning table registers in the orphan sweeper's cross-check, in the same commit.** `TicketAttachment.blobKey` joined `Message.mediaKey`/`mediaThumbnailKey`, `TeamChannelMessage.mediaKey` and `Call.recordingKey`/`transcriptKey` there. Omitting it deletes LIVE files 24h later — the same miss has happened four times, and customer-uploaded evidence is not recoverable from anywhere else. — [`apps/api/src/lib/sweepers/blob-orphan.ts`](apps/api/src/lib/sweepers/blob-orphan.ts)
- **A saved view's filter never merges by spread** — `inboxViewWhereClauses` returns independent predicates that callers AND in, so an `Unassigned` view can't clobber an agent's visibility restriction. — [`apps/api/src/lib/inbox-views/where.ts`](apps/api/src/lib/inbox-views/where.ts)
- **The ACTIVE WORKSPACE is resolved in exactly one place** — `resolveActiveWorkspaceId` (`@ccp/shared/auth/active-workspace`), called by the NestJS guard, the Socket.io handshake AND the Next.js RSC session. Order: membership-validated `ccp.ws` cookie → `Session.activeWorkspaceId` → first membership; the beyond-membership escape (org owner/admin, superAdmin) is always DB-verified and org-scoped. Three copies drifted once and the web silently rendered every switched session against the wrong workspace. Anything workspace-scoped that is cached (the session snapshot) is keyed by **(userId, workspaceId)**, and the per-user socket room is `user:<ws>:<uid>`. — §7
- **Org-wide actions need ORG authority.** `resolveSession` collapses a superAdmin, an org owner/admin and a plain member who admins ONE workspace all to the effective role `"admin"` — so deactivate / delete / password-reset gate on `canModifyUserAccount` (orgRole), never on the workspace role. Removing someone from a workspace goes through `lib/workspaces/remove-member.ts`, the counterpart to `provisionWorkspace`: one definition of what that transition means. — §2
- **Raw-SQL PARTIAL / expression indexes are invisible to the whole toolchain** — Prisma's DSL can't express a `WHERE`, an expression (`lower()`, `to_tsvector()`) or an operator class (`gin_trgm_ops`), so `migrate diff` and `check:prisma-fields` are both blind to them, and eight of them are UNIQUE constraints backstopping check-then-act races the app deliberately doesn't lock for. A `DROP COLUMN` silently destroys every index keyed on that column: the org→workspace rename took out six. They now live in **one hand-maintained section at the bottom of `prisma/migrations/0_init/migration.sql`** — regenerating that baseline from `schema.prisma` drops all 24 and `migrate diff` will still report "no difference", so the section must be carried by hand and verified by diffing `pg_indexes` between two real databases. `apps/api/test/partial-indexes.spec.ts` is the tripwire — keep it in lockstep with that section. — §7
- **Realtime read-state convergence** (mark-read only when viewing; all recovery paths converge; local `conversation:read` drives the badge); **team-wide unread only**. — [`apps/api/src/realtime/fanout-rules.ts`](apps/api/src/realtime/fanout-rules.ts)
- **Graceful shutdown**: `server.close()` before `app.close()`; keep the manual SIGTERM handler; `stop_grace_period ≥ ~100s` on api. — [`deploy/README.md`](deploy/README.md)
- **Heap ≤ ~75% of the service's `mem_limit`** (api 2048/3g, web 1536/2g). — [`deploy/README.md`](deploy/README.md)
- **`RUN_WORKER_INLINE` stays on in prod** (no external worker entrypoint exists). — [`deploy/README.md`](deploy/README.md)
- **`/v1` API keeps full parity with the UI**, documented in both places. — §12

---

## 19. Deferred / not now (with triggers)

- **Meta's WABA → WAAC + Messaging Account split** (phased H2 2026 → H1 2028; doc re-verified via MCP 2026-07-30) — Phase 1 needs **no code changes** for a single-integration app like this one, and Meta migrates every account automatically ("existing clients do not need to re-onboard"). Now that the WABA is an entity this is *better* than before: the phase-1 rename is one column on one row (`WhatsappBusinessAccount.externalWabaId` comes to mean "Messaging Account id" — Meta keeps the same id value) instead of a string repeated on every phone number plus a duplicate in `config` JSON.
  **Every scope this codebase depends on is confirmed UNCHANGED by the split**: throughput stays per phone NUMBER, the 24h messaging limit stays per business PORTFOLIO, quality rating stays per number, business verification stays per portfolio, template endpoints (`/{WABA_ID}/message_templates`) stay on the Messaging Account, webhook subscriptions stay per Messaging Account (= today's WABA id), and existing access tokens keep working.
  What actually changes, by phase: **Phase 1 (H2 2026)** — optional `paid_messaging_account_id` on Messages API; ES drops "add phone number later", so the flow becomes phone-number-first and `FINISH_ONLY_WABA` goes away (a zero-number WABA stays representable here, which is harmless). **Phase 2 (H1 2027)** — that parameter becomes required for multi-Messaging-Account setups, and `waac_id` starts arriving in message events. **Phase 3 (H1 2028)** — required on ALL Messages API versions, and every API that takes a phone-number id **in the path** must take a WAAC id instead (a WAAC is 1:1 with a phone number, so that maps onto `ChannelConnection`). Don't pre-build any of it. **Trap:** the parameter is spelled two ways and the GUIDE PAGES LAG THE CHANGELOG — the guide says `paid_messaging_account_id`, while the changelog of 2026-06-16 makes `messaging_account_id` preferred and that one a deprecated alias. Meta's **changelog** (`https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog/rss/` — the RSS parses cleanly; the HTML page 500s) is the tie-breaker for any wire detail, because a wrong body field is `#100` and fails every send. See [`messagingAccountField`](apps/api/src/lib/providers/meta.ts).
- **More channels** (Telegram, TikTok, SMS, Email) — the interface is ready; build one when a pilot asks. Recipe: [`apps/api/src/lib/providers/README.md`](apps/api/src/lib/providers/README.md). *(Messenger + Instagram are **live**, not deferred.)*
- **Messenger calling · social opt-in/proactive messaging · capability-driven broadcasting · per-`Customer` omnichannel targeting** — designed, not yet built; each is a bounded add along an existing seam. See the Meta-parity roadmap.
- **WhatsApp Embedded Signup** (no more manual credential paste) — needs Meta Tech-Provider review; after the product is worth onboarding into. Build **v4** directly: **v2 is deprecated 2026-10-15**. The model and ingest are already ready for it — the WABA is an entity that can hold zero numbers (`FINISH_ONLY_WABA`), `WhatsappPortfolio.source` distinguishes an ES-asserted `business_id` from a Graph-verified one, and the app-level callback exists (§12). What remains is the flow itself: the JS SDK launch, the `code` → business-token exchange, `POST /{WABA_ID}/subscribed_apps`, and phone-number registration. [`apps/api/src/workspace-settings/whatsapp/`](apps/api/src/workspace-settings/whatsapp/).
- **Unified `Customer` implementation** — ✅ shipped (§6). Remaining: merge/split audit record + person-level field lift + omnichannel targeting.
- **Redis Socket.io adapter, standalone worker container, per-tenant media isolation, encryption-at-rest for message bodies, analytics dashboards, per-agent unread** — each has a named trigger in [`deploy/README.md`](deploy/README.md) / the security docs. Don't pre-build.

---

## 20. Where the detail lives

`docs/` was **removed on purpose** — its contents had gone stale, and a stale
doc is worse than none: it is read as authority. **This file is the source of
truth.** Deeper detail lives next to the code it describes, which is the only
place that cannot drift out of sync with it:

| Topic | Authority |
|---|---|
| Provider engine, adding a channel, Meta onboarding | [apps/api/src/lib/providers/README.md](apps/api/src/lib/providers/README.md) |
| Workflow engine internals | [apps/api/src/lib/workflows/README.md](apps/api/src/lib/workflows/README.md) |
| Assignment routing internals | [apps/api/src/lib/assignment/README.md](apps/api/src/lib/assignment/README.md) |
| The domain layer as a whole | [apps/api/src/lib/README.md](apps/api/src/lib/README.md) |
| Event bus: tiers, subscribers, outbox | [apps/api/src/lib/events/bus.ts](apps/api/src/lib/events/bus.ts) |
| Realtime rooms + fanout scoping | [apps/api/src/realtime/fanout-rules.ts](apps/api/src/realtime/fanout-rules.ts) |
| Data model + every invariant comment | [prisma/schema.prisma](prisma/schema.prisma) |
| External `/v1` API reference | the in-app `/docs/api` page — [apps/web/src/app/docs/api/page.tsx](apps/web/src/app/docs/api/page.tsx), kept honest by `scripts/check-v1-docs.mjs` |
| Local setup & dev matrix | [ONBOARDING.md](ONBOARDING.md) |
| Deploy, heap, shutdown, queues, Caddy | [deploy/README.md](deploy/README.md) |
| What has been verified, how, and when | [tests/VERIFICATION-2026-07-29.md](tests/VERIFICATION-2026-07-29.md) |

Everything else is a docblock on the module that owns the behaviour. When a
rule matters, it is written where someone changing that code will see it.
