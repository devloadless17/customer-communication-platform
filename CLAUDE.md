# Project: WhatsApp Multi-Agent Shared Inbox

## What I'm building
A web platform where multiple internal agents collaborate on WhatsApp conversations through a shared inbox. Think Front, Intercom, or Missive but for WhatsApp. Core value is collaboration: assignments, attribution, internal notes, real-time updates. Target customer: SaaS for small/medium businesses. I have one pilot customer lined up.

## My situation
- Solo developer who likes modern designs (shadcn + framer-motion).
- Comfortable with JavaScript/Node and Next.js.
- New to realtime systems and message queues.
- 4-week MVP timeline.
- Building on the **official Meta WhatsApp Cloud API**. Evolution / Baileys / unofficial bridges have been removed from this project on purpose — the ban risk for self-hosted bridges isn't acceptable for a SaaS.

## Stack
- **Frontend:** Next.js (App Router, RSC, Zustand) — **owns rendering + auth pages only** post-migration.
- **Backend:** **NestJS** (HTTP + Socket.io gateway + webhook ingest + BullMQ workers + workflow engine). Currently mid-migration from Next.js API routes. Until migration completes both processes run side-by-side behind Caddy.
- **Database:** PostgreSQL (via Prisma). One `PrismaService` shared between Next.js (auth + RSC reads) and NestJS (everything else).
- **Realtime:** Socket.io. Browser connects via Caddy → NestJS gateway (single-process with the event sources = zero cross-process emit latency).
- **Auth:** Better Auth — **stays in Next.js** (login/logout/signup pages, session cookie issuance). NestJS validates the session cookie via a guard that hits the Better Auth session table directly through Prisma.
- **WhatsApp provider:** Meta WhatsApp Cloud API (only)
- **Infra:** Docker Compose, single VPS. Two app containers: `web` (Next.js, 3000) + `api` (NestJS, 4000). Caddy routes `/`, `/_next/*`, `/api/auth/*` → web; `/api/*`, `/socket.io/*`, `/webhooks/*` → api.

## Architecture (target — post NestJS migration)

```
                           ┌──────────────────────────────────────┐
                           │   Caddy (HTTPS + WS upgrade)         │
                           └──┬───────────────────┬───────────────┘
                              │ /, /_next/*       │ /api/*
                              │ /api/auth/*       │ /socket.io/*
                              │                   │ /webhooks/*
                       ┌──────┴────────┐   ┌──────┴──────────────┐
                       │ Next.js :3000 │   │ NestJS :4000        │
                       │ - RSC pages   │   │ - HTTP controllers  │
                       │ - Better Auth │   │ - Socket.io gateway │
                       │   pages       │   │ - Webhook ingest    │
                       │ - Frontend    │   │ - Workflow engine   │
                       │   bundles     │   │ - BullMQ workers    │
                       └──────┬────────┘   └──────┬──────────────┘
                              │                   │
                              └───────┬───────────┘
                                      │
                              ┌───────┴───────┐
                              │ Postgres │ Redis │
                              └───────────────┘

Inbound: Meta → Caddy → NestJS WebhooksController → HMAC verify (guard) →
         MetaProvider.parse → dedupe (compound unique on teamId+provider+externalId) →
         Prisma upsert → publish DomainEvent → in-process Socket.io fanout → browser.

Outbound: Browser → NestJS REST → MessagingService.sendText → Meta API →
          publish message.sent → in-process Socket.io fanout → browser.
```

NestJS owns every backend concern that isn't auth pages. Socket.io lives in the same process as REST + workflows + webhooks, so domain-event → emit is in-process with zero pub/sub hop. Meta NEVER talks to browsers directly. Provider details hidden behind `MessagingProvider` interface so a future channel (SMS / IG DM) plugs in without touching ingest or controllers.

## Critical architectural rules (don't violate these)

1. **Provider abstraction, even with one provider.** Define a `MessagingProvider` interface. Implement `MetaProvider` only for now. App code only ever talks to the interface, never directly to Meta's API shape. New channels plug in here.

2. **Multi-tenancy from day one.** Every table has a `team_id` column, defaulting to 1. I'm single-tenant for MVP but I will not pay for that migration later.

3. **Deduplication is critical.** Meta sometimes delivers the same `wamid` twice (at-least-once semantics) and retries on non-200. Unique index on `external_id` in the messages table. Use `upsert` / `findUnique` gate, not bare `create`.

4. **Keep raw payloads.** Every message row has a `raw_payload` JSONB column with the original Meta webhook body. Critical for debugging.

5. **Webhook security.** Meta webhook authenticity is proven by HMAC-SHA256 of the raw body using the app secret (header `X-Hub-Signature-256`). Verify on every POST; reject malformed signatures with 403. The verify-token flow is only used at subscription setup.

6. **Per-team secrets when we go multi-tenant.** Today `META_*` secrets live in `process.env`. When customer #2 onboards, those move to nullable columns on the `Team` table — read by the provider via a `getProviderConfig(teamId)` helper. This is the migration alluded to in rule #2; flagging now so it's not a surprise.

## Things to know about Meta Cloud API specifically

- **No history sync.** From the moment you subscribe to webhooks, you receive new events. Anything that happened before that point is not retrievable. There is no "list past chats" endpoint.
- **24-hour customer service window.** Outbound free-form messages only work to numbers that messaged you within the last 24h. Outside the window: pre-approved templates only. Plan UX around this from the start.
- **Pre-approved templates.** Required for cold outbound (re-engagement, marketing, notifications, post-24h). Submitted via WhatsApp Manager, reviewed by Meta. Adding template send is its own work item, deferred.
- **Test numbers vs real business numbers.** While the Meta app is unpublished, only numbers explicitly added as test recipients in the dashboard will receive your sends. Once published + verified, any number works.
- **Onboarding.** No QR scan. Customers either (a) paste their `META_*` credentials into a settings page, or (b) we build WhatsApp Embedded Signup, which requires Meta Tech Provider review. (b) is the right answer for SaaS scale and is post-MVP. Future onboarding (Embedded Signup) playbook — see [docs/onboarding-future.md](docs/onboarding-future.md).

## Database schema (initial)

- `users` — id, team_id, role (admin/agent), name, email
- `teams` — id, name
- `contacts` — id, team_id, phone_number, name
- `conversations` — id, team_id, contact_id, assigned_user_id, status (open/pending/closed)
- `messages` — id, team_id, conversation_id, external_id (UNIQUE), sender_user_id (nullable for inbound), body, direction (in/out), provider, status (sent/delivered/read/failed), raw_payload (JSONB), timestamp
- `internal_notes` — id, conversation_id, author_user_id, body, timestamp

`provider` is currently a single-value enum (`meta_cloud`). Kept as an enum so adding a second channel is a non-destructive migration.

## Docker Compose layout

Two services on one internal network: `postgres` and `app`. Only `app` publishes a port. Postgres is reachable from `app` at `postgres:5432` and from the host (for migrations / Prisma Studio) at `127.0.0.1:5433`. Meta is reached over the public internet, so no other local services are needed.

## Week-by-week MVP plan

**Week 1 — Foundations**
- Docker Compose: Postgres + Next.js
- Next.js project with Better Auth, Prisma schema with team_id everywhere
- Meta app set up, webhook verified, test recipient added
- Webhook endpoint: receive → verify signature → normalize → dedupe → save (raw_payload kept)
- `MessagingProvider` interface + `MetaProvider` implementation (parse + sendText)
- Test full round trip: receive a Meta message, send a reply, both rows in DB

**Week 2 — Inbox UI + Socket.io realtime**
- Conversation list, message thread, reply box (Tailwind, simple and clean)
- Socket.io server (custom Next.js server), rooms per conversation + per team
- Frontend subscribes to active conversation + team-wide list
- Two-browser test: agent A sends, agent B sees instantly
- Agent attribution: every outbound message records sender_user_id
- Assignment dropdown + filtered views (All / Mine / Unassigned)

**Week 3 — Collaboration + polish**
- Internal notes (Reply vs Note toggle, never sent to WhatsApp) — DO NOT SKIP
- Conversation status (open/pending/closed)
- Team-wide unread counters (per-agent unread is harder, defer)
- Contact search
- 24h-window awareness in the reply box (greyed when expired, hint about templates)
- Self-use, fix real bugs

**Week 4 — Deploy + pilot**
- Deploy to a VPS, single Socket.io instance (sticky sessions later)
- Public HTTPS for the app (Caddy reverse proxy — chosen over nginx/Traefik for auto-HTTPS and zero-config WebSocket upgrade for Socket.io)
- Basic logging
- Onboard pilot customer: either they hand us their `META_*` credentials, or we walk them through the Meta app setup. Embedded Signup is post-MVP.

## Explicitly deferred (don't build, don't suggest)

**Current focus is WhatsApp depth, not breadth.** Perfecting WhatsApp chatting + the three active workstreams (automations, AI agents, external API) comes first. Everything below stays off the table until that's done — *especially* don't suggest these as shortcuts when one of the active workstreams hits friction.

**Deferred until WhatsApp + automations + AI agents are solid:**
- **WhatsApp Embedded Signup.** Right answer for SaaS-scale onboarding (no more manual `META_*` credential pasting), needs Meta Tech Provider review. Comes *after* the product itself is worth onboarding into.
- **Multi-channel (Instagram / FB Messenger / SMS / Email / etc.).** Provider interface is ready, don't add one until a pilot actively asks and WhatsApp depth is done. Resisting this is the single biggest scope discipline call on the project.

**Deferred indefinitely (no clear trigger yet):**
- Analytics dashboards, per-agent unread, advanced permissions, audit log UI, billing, Redis pub/sub for Socket.io scaling, voice/calling, native CRM integrations (Salesforce/HubSpot — n8n via the external API covers this).

> Note: tags, labels, template send/manage, bulk send, BullMQ, and media send/receive were on this list at MVP-start but are now shipped — see [audit on 2026-05-16]. The three "depth pass" workstreams above are the active expansion; treat them as in-flight, not deferred.

## Operations & deployment notes (don't forget)

### Node heap — already set
**Production (`start`) runs both web + api with `NODE_OPTIONS=--max-old-space-size=4096`** and **must keep it** — the broadcast runner + Socket.io fanout occasionally need that headroom. **Don't strip the prod flag.**

**Dev is lower on purpose** (2026-05-21): web `dev` = 3072, api `dev` = 2048. Reason: the dev box is a 15.4 GB Windows host giving WSL ~9.7 GB. Running BOTH dev servers at a 4 GB heap (8 GB combined) overcommitted during a webpack compile spike and the Linux OOM-killer killed the api (`exited (137)` — SIGKILL), which manifested as cascading flakiness (proxy `ECONNRESET`, socket dropping `message:new` → optimistic send bubbles hitting the 30s watchdog and going red). 3 GB + 2 GB fits in 9.7 GB with headroom. A big `.wslconfig` `memory=` bump is NOT the fix here — the host is too small to give WSL more without starving Windows (browser + VS Code + Docker Desktop). If a dev server ever throws a *V8* "JavaScript heap out of memory" (distinct from 137), bump that one's dev cap back up a notch.

### Before pilot launch (must-do)
1. **systemd unit** on the VPS, NOT pm2. Single VPS, no clustering, systemd is already there. Live unit at [deploy/ccp.service](deploy/ccp.service). Set `Restart=always`, `RestartSec=3`, and rely on the Dockerfile's `ENV NODE_OPTIONS=--max-old-space-size=4096` (systemd env vars on the host don't propagate through `docker compose up`). **`TimeoutStopSec=120`** so systemd waits long enough for `app.enableShutdownHooks()` to drain BullMQ workers — must exceed the 90s `lockDuration` in [lib/workflows/worker.ts](apps/api/src/lib/workflows/worker.ts) plus the sweeper-stop tail. Lowering this re-executes Meta sends on every restart. See "Graceful shutdown" below.
2. **Caddy reverse proxy** in front for HTTPS (not nginx — Caddy handles Let's Encrypt automatically and forwards WebSocket upgrade headers by default, which Socket.io needs). Bonus: during the rare app restart, the proxy returns 502 for ~3s instead of a hard "connection refused."
3. **VPS sizing**: ≥4GB RAM for the app, +2GB for Postgres, +headroom. 8GB total is the floor.

### Graceful shutdown — load-bearing for workers
`apps/api/src/main.ts` calls `app.enableShutdownHooks()`. Without it, NestJS does NOT fire `OnModuleDestroy` on SIGTERM. The `WorkflowWorkerService` lifecycle hook stops the BullMQ worker via `worker.close()` (BullMQ awaits the in-flight job, then releases the Redis lock cleanly), stops the sweepers, and closes the queue. The chain is:

```
SIGTERM → enableShutdownHooks → OnModuleDestroy hooks fire in reverse-init order →
  stopContactDriftSweeper → stopWorkflowWaitingSweeper → stopInboundMediaSweeper →
  stopWorkflowWorker (awaits in-flight job; bounded by BullMQ lockDuration=90s) →
  closeWorkflowQueue
```

If you skip `enableShutdownHooks()` (or systemd's `TimeoutStopSec` is too low), the worker dies mid-job, Redis releases the lock after 90s, the new process picks the same job up and re-executes — irreversible Meta sends, tag changes, etc. double-fire. Don't strip the call.

### Per-user rate limiting
`RateLimitGuard` (in CommonModule, applied globally via `APP_GUARD`) buckets every session-authenticated mutation at **300 req/min per user** by default, with `@RateLimit({ perMinute: 60 })` overriding `MessagesController` (text/media/template/forward share the same bucket so a single user can't multiply quota by hitting different routes). API-key routes have their own per-key limit upstream (`ApiKeyGuard`); guard no-ops on requests without `req.session`. Tune by adding the `@RateLimit` decorator at the controller or handler level. In-memory only — moves to Redis on the same trigger as everything else (second app instance).

### Request correlation IDs
`apps/api/src/common/correlation.ts` exposes `getCorrelationId()` and `withCorrelation(msg)`. Correlation middleware runs FIRST in main.ts (before bodyParser) so the ALS scope covers the whole request. Echoed back via `X-Request-Id`. For framework-agnostic `lib/` code that doesn't use NestJS's `Logger`, wrap log messages with `withCorrelation(...)` — see `lib/events/bus.ts` for the pattern. NestJS Logger calls inside HTTP handlers carry the ID via the controller's module context plus the surrounding ALS scope.

### Contact.lastInboundAt drift sweeper
`apps/api/src/lib/sweepers/contact-last-inbound-drift.ts` runs once daily and reconciles `Contact.lastInboundAt` against `MAX(Message.timestamp)` per contact for inbound messages. Self-disables after 7 days of zero drift (re-enables on process restart). The denorm is steady-state correct; this is defense-in-depth against a crash between the Message insert and the Contact bump.

### Realtime cache patch matrix
When adding a socket event that mutates per-thread state (status, assignment, custom field, tag, note, etc.), wire it in BOTH places:
1. `apps/web/src/features/inbox/lib/thread-reducers.ts` — pure reducer
2. `useConversationEvents` AND `inbox-shell.tsx` — both call the same reducer

See the comment block at the top of `thread-reducers.ts` for the full event → reducer → consumer table. Skipping the cached-shell side means a chat-switch + back reverts the field to a stale snapshot.

### Read-state + reconnect convergence (read before touching unread)
Inbox unread is **team-wide only** (`Conversation.unreadCount`) — there is NO per-agent inbox read state (team chat has its own, `TeamChannelReadReceipt`). Two load-bearing rules; breaking either is the recurring "stuck / wrong unread" bug class (all fixed 2026-05-21: stuck-after-reconnect, hidden-tab-clears-team-unread, stale-notes-after-sleep):

1. **`markRead` fires ONLY when the agent is actually viewing — visible AND on the thread.** Triggers in `use-conversation-events.ts`: mount (when `initialUnread > 0`), live `onMessageNew` (gated on `document.visibilityState === "visible"`, else deferred via `sawInboundWhileHiddenRef`), and `onVisibility` (fires the deferred read on return). A hidden background tab parked on a thread must NOT clear team-wide unread for a message nobody saw — that silently drops customer messages from triage.
2. **Every recovery path must converge to server state.** The displayed thread has three: live socket reducers, the SSR/open `?after=` **delta** backfill (`runBackfill`), and a **full** refetch (`runFullRefetch` → `GET /api/inbox/conversation/:id`) on a real RECONNECT. First connect = delta (SSR is fresh); reconnect-after-drop = full refetch (the delta can't carry notes / contact / message-status that changed while offline). Both clear unread when `unreadCount > 0`. Wire any new unread-clear or thread-state trigger into ALL paths — a fix on the live path alone leaves a stuck-after-reconnect bug.
3. **The list badge clears via a LOCAL `conversation:read` dispatch, NOT the server frame.** `markRead`'s server-side CAS publishes `conversation.read` ONLY on the `1→0` transition — it's one-shot. Once the DB unread is zeroed, no future frame ever fires, so a single missed delivery (socket not yet joined to the team room on a fresh open, a throttled/background tab, a transient drop) would leave the LIST badge stuck at >0 forever even though the DB says read (reappearing on every chat-switch / nav). Fix: `inbox-shell.tsx`'s `handleMarkRead` (the `onMarkRead` callback) fires `dispatchLocalSocketEvent("conversation:read", …)` on POST success. That one frame drives all three consumers via their already-wired reducers — `useTeamEvents.onRead` (list badge), the inbox-shell reducer (LRU cache snapshot), and the `useConversationEvents` reducer (live thread `data.unreadCount`, so snapshot-on-leave can't write a stale 1 back). Don't make the list badge depend on the server round-trip frame again — it's the same "optimistic socket dispatch" rule every other inbox mutation (status / assignment / contact) follows.

### Coalesced bulk fanout
Bulk paths (`/api/contacts/bulk` tag-add/tag-remove today) publish per-contact `contact.updated` events with `suppressSocketFanout: true` (workflow + audit subscribers still fire — they don't read the flag), AND publish one `contact.bulk_updated` event for socket fanout. Clients listening to `contacts:bulk_updated` should invalidate / refetch the affected ids in one query. Bounds a 500-contact × 25-agent bulk operation from ~12,500 socket frames to 25.

### Dev-environment OOM (`tsx watch` chewing memory) 
Symptom: `FATAL ERROR: Ineffective mark-compacts near heap limit` after a long edit session. Cause: `tsx watch` + Next.js dev mode accumulate bundler/AST state across hot-reloads. Fix order:
1. `rm -rf .next` (the dev cache bloats past 500MB after heavy days)
2. Restart `npm run dev`
3. Re-bump heap to 6GB if even 4GB isn't enough during a particularly heavy session
4. As a habit, restart dev once an hour during heavy work

This is a `tsx watch` artifact, NOT a memory leak in our code. Don't chase phantom leaks in app code based on the dev-mode OOM alone.

### Skip until forced to revisit (with trigger conditions)
- **pm2** — only if we move beyond a single VPS or want clustered Node workers.
- **Datadog / New Relic** — only when `process.memoryUsage()` logging stops being enough.
- **Redis pub/sub for Socket.io** — only when a second app instance shows up.
- **Cache eviction on `lib/providers/config.ts`** — only past ~5 tenants (current `Map` is grow-only by design).
- **Move broadcast runner to a separate worker / BullMQ** — only when a single broadcast crosses ~10k recipients OR a broadcast crashes the app mid-flight.
- **Per-tenant UploadThing isolation** — single `UPLOADTHING_TOKEN` shared across all teams today; compromise of the token exposes everyone's media. Trigger: ~10 customers OR a partner explicitly asks for per-tenant blob scoping. Fix: either per-team UploadThing apps (operational + cost overhead) or move to S3/R2 with a `<teamId>/` prefix policy on signed URLs.
- **Encryption-at-rest for customer data (`Message.body`, `Contact.phoneNumber`, etc.)** — today only credentials (`Team.metaAppSecret`, `TeamApiKey.secret`) are encrypted via the envelope crypto. Trigger: enterprise customer compliance requirement. Fix: Postgres TDE at the disk level, OR per-team data keys with explicit encrypt/decrypt at every read site — much wider change than the credential pattern. Don't selectively encrypt one column ("just `OutboundWebhookDelivery.payload`") — the payload duplicates data already plaintext on `Message.body`, so partial encryption is security theater.

### Behaviors that look fixable but are correct as-is
- **Socket.io connection-state-recovery is bounded at 2 minutes** ([apps/api/src/realtime/ws-adapter.ts](apps/api/src/realtime/ws-adapter.ts)). After a longer offline (laptop sleep, WiFi hop), non-displayed cached threads in the LRU are evicted on the next reconnect; clicking back to one triggers a refetch. The DISPLAYED thread isn't evicted — instead `useConversationEvents` full-refetches it on reconnect (`runFullRefetch`, see "Read-state + reconnect convergence"). Both are the same simple answer: refetch, don't build a custom replay layer. Don't extend the recovery window.
- **The bulk DELETE endpoint at `/api/contacts/bulk` fires per-contact `contact.deleted` events** rather than coalescing through a `contact.bulk_deleted` frame. Looks like the symmetric of `contact.bulk_updated` (tag bulk), but the audit pattern doesn't apply: bulk delete is rare in practice, and the per-contact events drive workflow + audit subscribers that need granular triggers. Adding a coalesced socket frame would require either a parallel suppress-then-emit pattern (cost: new event type + new fanout rule + new client handler for a rare path) or losing workflow trigger granularity. Skip unless a customer reports lag from a 500+ bulk-delete.

### Scaling cliffs to anticipate (don't pre-build)
- **50-200 tenants**: in-process credential cache + grow-only Maps start to leak. Fix when seen.
- **10k+ recipient broadcasts**: in-process loop holds too much state. Move to a worker.
- **Multi-region or HA**: requires Redis Socket.io adapter, sticky sessions, shared media storage. Not pilot scope.

## How I want you to work with me

- **Match the stack above.** Don't suggest Pusher, Ably, Supabase Realtime, tRPC, GraphQL, Evolution / Baileys, or any rewrites.
- **Code first, explanation second.** I'm a working developer. Show me the code, then a short note on what's non-obvious.
- **Surface tradeoffs, don't hide them.** When you make a design choice, tell me what you rejected and why in 1-2 sentences.
- **Flag Meta-specific gotchas.** If I ask for something that runs into the 24h window, requires a template, or requires a permission I don't have yet, say so before writing code.
- **Ask before scaffolding huge things.** If a request implies generating 10+ files, propose a file list first and let me approve it.
- **Prisma over raw SQL** for schema and queries. Migrations via `prisma migrate dev`.
- **TypeScript everywhere.** Strict mode.
- **Don't write tests yet** unless I ask. I'll add them after the MVP works end-to-end.

## What I'm working on right now

**Active and only workstream: NestJS migration — code-complete, smoke-booted, awaiting dev soak + deploy sign-off.** Everything else (AI agents, outbound webhooks, scoped API keys, round-robin assignment) is paused until the deploy lands.

The 4-week MVP plus the workflow / external API / team-chat depth passes are all already shipped — inbox, realtime, templates, broadcasts, contacts (tags / stages / custom fields / audience groups), media send+receive, snippets, internal notes, forwarding, external API, workflow engine + React Flow canvas, team chat with channels / mentions / reactions / pins / threads.

### Migration state — complete

Phases 1–5 all landed. Both typechecks green; both processes (Next.js + NestJS) boot cleanly in dev with `/api/health` returning healthy.

| Phase | Deliverable | Status |
|---|---|---|
| 1 | NestJS scaffold (`apps/api/`) — guards, pipes, Prisma module, BullMQ, Socket.io gateway, health endpoint | ✅ |
| 2 | Realtime + ingest — full Socket.io gateway port, `RealtimeFanoutService` bus subscriber, Meta webhook controller (HMAC verify + 2-phase inbound media), frontend `NEXT_PUBLIC_API_URL` flag | ✅ |
| 3a | Catalog REST: tags / snippets / stages / contact-fields / audience-groups / api-keys / team-chat channels / WhatsApp settings + templates | ✅ |
| 3b | Inbox REST: conversations (full) + notes + contacts (full CRUD + bulk + import + lookup/count/preview/export/tags) + messages (text + template + **media + forward**) | ✅ |
| 3c | Admin REST: invites + users + admin/teams + team root + change-password + workflows (all 8 routes incl. public HMAC incoming-webhook) | ✅ |
| 3d | Broadcasts: create + list + get + delete + media/[messageId]. Runner stays in [lib/broadcast-runner.ts](lib/broadcast-runner.ts) (framework-agnostic). | ✅ |
| 3e | External `/v1` API: all 6 endpoints | ✅ |
| 4 | Workflow engine in NestJS: `WorkflowWorkerService`, `WorkflowSubscribersService`, `WorkflowDispatcherService`. Engine in [lib/workflows/](lib/workflows/). | ✅ |
| 5 | Cleanup: ~82 files deleted (server.ts, worker.ts, lib/socket/server.ts, lib/events/redis-bridge.ts, lib/api/*, lib/events/subscribers/{socket-fanout,index}.ts, every migrated `app/api/**/route.ts`). New `instrumentation.ts` registers cache-revalidate on Next.js boot. Dev tool ported to NestJS as `DevEmitController`. | ✅ |

**Runtime stack** — `@swc-node/register` powers `api:dev` / `api:start` (NOT `tsx`; see lessons below). Next.js dev/start use `next dev` / `next start` — no more custom `server.ts`.

### Bus events introduced for the cleanup

Direct `emitToTeam` calls in lib/ couldn't survive Phase 5 because the Socket.io singleton moved to NestJS. Two new event types added to keep emit-from-lib working from any process WITHOUT triggering audit/analytics/workflows when that's not the intent:

- `broadcast.recipient_message_sent` + `broadcast.conversation_reopened` — broadcast runner uses these instead of `message.sent` / `conversation.status_changed`. Only socket-fanout subscribes; analytics + audit are structurally excluded (a 1k-recipient broadcast must not bump counters or write 1k timeline rows).
- The conversation audit timeline is DB-only: `recordConversationEvent` (`lib/inbox/events.ts`, called from the audit subscriber) writes the `ConversationEvent` row and does NOT emit a socket frame — the timeline is fetched on demand. (No `conversation.event_recorded` bus event exists; an earlier draft of this section described one that was never wired.)

### Remaining non-migrated routes (intentional, post-Phase-5)

| Route | Reason |
|---|---|
| `apps/web/src/app/api/auth/[...all]` | Better Auth catch-all — must stay on Next.js (Caddy routes `/api/auth/*` here, EXCEPT `/api/auth/change-password` which lives on NestJS — see Cutover step 2 below) |
| `apps/web/src/app/api/health` | Different URL space (`/api/health` vs NestJS `/health`); kept for backwards-compat probes |
| `apps/web/src/app/api/webhooks/meta/[teamId]` | Server-side proxy to `/webhooks/meta/{teamId}` on NestJS. Forwards raw bytes verbatim so HMAC verification still passes. Insurance for Meta subscriptions still pointing at the old URL. **DELETION DEADLINE: 2026-06-19** (30 days post NestJS cutover; checklist + extension policy in the file's header doc-comment). |

The generic `app/api/webhooks/[provider]/[teamId]` dispatcher shim was removed in Phase 5 and not re-added — there's only one provider (Meta) today, so a generic dispatcher buys nothing.

### Cutover playbook (dev → prod)

The pre-cutover env-flag dance is gone. The Next.js-side flags (`SKIP_SOCKET_FANOUT`, `BUS_REDIS_BRIDGE`, `SKIP_WORKFLOW_DISPATCH`, `RUN_WORKER_INLINE` on the `app` service) no longer exist in [docker-compose.yml](docker-compose.yml) — ownership is now structural (Next.js: pages + auth; NestJS: everything else). One flag survives by design: `RUN_WORKER_INLINE=1` on the `api` service, which keeps BullMQ processors inside the NestJS process. Set to `0` only if you re-introduce a standalone worker container; the default is correct for single-VPS pilot.

Remaining steps for the actual deploy:

1. **Dev smoke** (one-time before each deploy):
   ```bash
   npm install
   npm run typecheck && npm run api:typecheck
   npm run dev       # Next.js on :3000
   npm run api:dev   # NestJS on :4000
   ```
   `.env` should set `NEXT_PUBLIC_API_URL=http://localhost:4000` so the browser Socket.io client points at NestJS.

2. **Caddy routing**: see [deploy/Caddyfile.example](deploy/Caddyfile.example) — commit-controlled config so the rule ordering doesn't live only in this prose. The non-obvious lines:
   - `/api/auth/change-password` → NestJS (moved off Better Auth). Must come BEFORE the `/api/auth/*` → Next.js wildcard or change-password 404s.
   - `/api/webhooks/meta/*` → Next.js (the legacy URL is handled by the proxy at [apps/web/src/app/api/webhooks/meta/[teamId]/route.ts](apps/web/src/app/api/webhooks/meta/[teamId]/route.ts) which forwards bytes verbatim to NestJS so HMAC integrity is preserved).
   - Default for everything else: `/`, `/_next/*`, `/api/auth/*` → Next.js; `/api/*`, `/webhooks/*` → NestJS. (The Socket.io client connects on `/api/socket/*` and is caught by the `/api/*` matcher; no separate `/socket.io/*` rule is needed.)

3. **Meta webhook URL flip (pre-deploy)**: update the Meta App Dashboard to point at the canonical `https://<host>/webhooks/meta/{teamId}` path (NestJS). The legacy proxy at `/api/webhooks/meta/{teamId}` keeps existing subscriptions alive during cutover, but it's insurance — not a permanent design. Once every subscription is on the new URL, delete `apps/web/src/app/api/webhooks/meta/[teamId]/route.ts`.

### Architectural calls (locked, do not re-litigate)

- **Socket.io lives in NestJS, not Next.js.** Same process as REST + webhooks + workflows = in-process emit, zero pub/sub hop.
- **Better Auth stays in Next.js.** Moving it costs ~2 weeks of risk for zero functional benefit. NestJS guard reads `better-auth.session_token` cookie + hits the session table via Prisma. ~1ms overhead per request.
- **Existing service modules** ([lib/messaging/](lib/messaging/), [lib/conversations/](lib/conversations/), [lib/contacts/](lib/contacts/), [lib/workflows/](lib/workflows/), [lib/providers/](lib/providers/)) stay where they are — framework-agnostic; NestJS wraps them as Nest providers.
- **Zod everywhere.** `zBody / zQuery / zParam` pipes at [apps/api/src/common/zod-validation.pipe.ts](apps/api/src/common/zod-validation.pipe.ts) reuse the schemas already written for Next.js routes. No class-validator / class-transformer.
- **Prisma stays.** One `PrismaModule` in NestJS (the `PrismaService` instance is the canonical client; `apps/api/src/lib/db.ts` is a Proxy that delegates to it so framework-agnostic helpers + module-load Better Auth + worker callbacks all share the same pool — see the `setSharedDb` wiring). The existing `lib/db.ts` singleton lives in Next.js. Same `DATABASE_URL`, one pool per process.
- **Workers run in-process by default.** `RUN_WORKER_INLINE=1` (default on the api container) keeps BullMQ processors inside the NestJS app. The standalone `worker` docker service was removed post-Phase-5; add it back only if scaling forces a split.
- **Two processes total**, single VPS, single docker-compose. No microservices.

### Runtime + DI lessons (load-bearing)

- **NestJS DI requires `emitDecoratorMetadata`. `tsx` (esbuild backend) does NOT emit it.** This was a pre-existing latent bug — typecheck stayed green forever but `OnModuleInit` hooks crashed on first injection. We switched the api scripts + docker `command` to `@swc-node/register` with `SWC_NODE_PROJECT=apps/api/tsconfig.json` so SWC picks up `experimentalDecorators` + `emitDecoratorMetadata` from the right tsconfig.
- **`--conditions=react-server` is required** on the NestJS node invocation. Many shared `lib/` files do `import "server-only"` which throws unless that condition picks `server-only`'s `empty.js` no-op variant. Both `api:dev` and `api:start` already set this; the Next.js side gets it automatically.
- **Next.js needs [instrumentation.ts](instrumentation.ts) for boot-time wiring.** The old `server.ts` called `registerAllSubscribers` directly; with `next start` replacing it, the standard Next.js `register()` hook handles cache-revalidate registration. `NEXT_RUNTIME === "nodejs"` guard is there because instrumentation also fires in edge — where Prisma + bus would crash.

### Paused workstreams (resume after deploy sign-off)

- **AI agents** (suggested replies → auto-reply → lead qualification). Plugs in as new step types in the workflow registry + an `AiModule` in NestJS.
- **Outbound webhooks**. A subscriber on the event bus + a `webhook:deliver` BullMQ queue. Natural fit for NestJS now that the bus lives inside it.
- **Scoped API keys, IP allowlists, OpenAPI spec.** Pair naturally with the external-v1 controller migration.
- **Workflow Round 2c**: Ask-a-Question step, business-hours branch, round-robin assignment, platform integrations as steps.
