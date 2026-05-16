# Project: WhatsApp Multi-Agent Shared Inbox

## What I'm building
A web platform where multiple internal agents collaborate on WhatsApp conversations through a shared inbox. Think Front, Intercom, or Missive but for WhatsApp. Core value is collaboration: assignments, attribution, internal notes, real-time updates. Target customer: SaaS for small/medium businesses. I have one pilot customer lined up.

## My situation
- Solo developer who likes modern designs (shadcn + framer-motion).
- Comfortable with JavaScript/Node and Next.js.
- New to realtime systems and message queues.
- 4-week MVP timeline.
- Building on the **official Meta WhatsApp Cloud API**. Evolution / Baileys / unofficial bridges have been removed from this project on purpose — the ban risk for self-hosted bridges isn't acceptable for a SaaS.

## Stack (decided, don't suggest alternatives)
- **Frontend:** Next.js (App Router)
- **Backend:** Next.js API routes + custom server for Socket.io
- **Database:** PostgreSQL (via Prisma)
- **Realtime:** Socket.io (rejected managed alternatives — I want to learn this)
- **Auth:** Better Auth (DB-backed sessions, custom bcrypt hasher, see [lib/auth/better-auth.ts](lib/auth/better-auth.ts))
- **WhatsApp provider:** Meta WhatsApp Cloud API (only)
- **Infra:** Docker Compose, single VPS for MVP

## Architecture

```
Customer's WhatsApp
    ↓
Meta WhatsApp Cloud API
    ↓ HTTPS webhook (X-Hub-Signature-256 verified)
Next.js API route (/api/webhooks/meta)
    ↓
Provider adapter → normalize → dedupe → save to Postgres
    ↓
Socket.io emit to subscribed clients
    ↓
Browser updates in realtime
```

Browsers connect Socket.io to my app server. Meta NEVER talks to browsers directly. WhatsApp protocol details are hidden behind a `MessagingProvider` interface so a future channel (SMS via Twilio, Instagram DM, etc.) can plug in without touching ingest or routes.

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
- **Onboarding.** No QR scan. Customers either (a) paste their `META_*` credentials into a settings page, or (b) we build WhatsApp Embedded Signup, which requires Meta Tech Provider review. (b) is the right answer for SaaS scale and is post-MVP.

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
- Analytics dashboards, per-agent unread, advanced permissions, audit log UI, billing, Redis pub/sub for Socket.io scaling, NestJS, voice/calling, native CRM integrations (Salesforce/HubSpot — n8n via the external API covers this).

> Note: tags, labels, template send/manage, bulk send, BullMQ, and media send/receive were on this list at MVP-start but are now shipped — see [audit on 2026-05-16]. The three "depth pass" workstreams above are the active expansion; treat them as in-flight, not deferred.

## Operations & deployment notes (don't forget)

### Node heap — already set
`package.json` runs both `dev` and `start` with `NODE_OPTIONS=--max-old-space-size=4096`. This is intentional — Node 24 on this WSL2 setup defaults to a ~2GB heap which OOMs `tsx watch` during heavy edit sessions. **Don't strip this flag** thinking it's leftover dev tooling — production needs it too because the broadcast runner + Socket.io fanout occasionally need headroom.

### Before pilot launch (must-do)
1. **systemd unit** on the VPS, NOT pm2. Single VPS, no clustering, systemd is already there. Set `Restart=on-failure`, `RestartSec=3`, and pass through `NODE_OPTIONS=--max-old-space-size=4096`. If anything kills the process — OOM, panic, manual bump — it's back in 3s.
2. **Caddy reverse proxy** in front for HTTPS (not nginx — Caddy handles Let's Encrypt automatically and forwards WebSocket upgrade headers by default, which Socket.io needs). Bonus: during the rare app restart, the proxy returns 502 for ~3s instead of a hard "connection refused."
3. **VPS sizing**: ≥4GB RAM for the app, +2GB for Postgres, +headroom. 8GB total is the floor.

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

The 4-week MVP is shipped — inbox, realtime, templates, broadcasts, contacts (with tags / stages / custom fields / audience groups), media send+receive, snippets, internal notes, forwarding, external API, and a first-pass automations engine (triggers + conditions + webhook actions, BullMQ-backed) are all live. Next two workstreams, in this order:

### 1. Workflow automations — depth pass

The current engine ([lib/automations/](lib/automations/)) is real but thin: three triggers (`message_received`, `conversation_assigned`, `conversation_status_changed`), AND-only conditions, one action type (`webhook`). Goal is to make this a usable workflow builder, not a feature-match against respond.io.

- More triggers: `conversation_created`, `tag_added`, `contact_created`, `keyword_match`, time-based ("no reply in N hours")
- More actions, in priority order: `send_template`, `send_snippet`, `assign_to_user`/`assign_to_round_robin`, `set_status`, `add_tag`/`remove_tag`, `move_stage`, `add_note`. `webhook` stays.
- Condition logic: OR groups + nesting (current AND-only is too rigid)
- Run history UI: surface `AutomationRun` rows with replay/inspect, not just a JSON dump
- Multi-step workflows (action chains with branching) — defer until single-action flows are proven in pilot

### 2. AI agents — auto-reply, lead qualify, multilingual

The data layer is already there: [app/api/conversations/[id]/messages/context/route.ts](app/api/conversations/%5Bid%5D/messages/context/route.ts) loads the message window. No LLM calls wired yet. Approach:

- Start with **suggested replies** (agent-in-the-loop) before autonomous send — lower trust bar, faster to ship, gives us prompt-quality signal
- Then **auto-reply when no human is online** with a configurable "handoff" trigger (keyword or AI confidence threshold flips conversation to `pending` + assigns to a human)
- **Lead qualification** = an automation action that runs an LLM classifier on the conversation and writes to contact custom fields / stage / tags. Reuses workstream 1's plumbing — that's why automations come first.
- **Multilingual** is mostly free if we use a frontier model; the work is detection + per-team language preferences, not translation
- Provider: Claude API ([claude-opus-4-7] for reasoning-heavy, [claude-haiku-4-5-20251001] for classification), with prompt caching on the system prompt + conversation history
- Per-team `aiEnabled` flag + per-team prompt overrides on the `Team` table. Per-team API keys later if cost shaping is needed.
- Guardrails: never auto-send a template (cost + Meta policy), never auto-send outside the 24h window, hard cap on auto-replies per conversation per hour.

### 3. External API for integrations — depth pass

Today's [app/api/external/v1/](app/api/external/v1/) routes are Bearer-auth'd via `TeamApiKey` and cover contacts + conversations + messages + notes — enough for n8n today, not enough for a real integrations story. Goal is to make this the public API a customer (or Zapier/Make/n8n template) can build on without us hand-holding.

- **Outbound webhooks (we POST out)**: subscribe per-team to events — `message.received`, `message.sent`, `conversation.assigned`, `conversation.status_changed`, `contact.created`, `contact.updated`, `automation.run`. Signed payloads (HMAC), retries with backoff, delivery log. This is what closes the loop with n8n/Zapier without them polling.
- **Coverage gaps in inbound API**: tags CRUD, snippets, audience groups, broadcasts (create + status), templates list, automations list. Anything an admin can do in the UI should be doable via API.
- **Auth hygiene**: scoped API keys (read-only vs read-write vs admin), rotation, IP allowlists optional. Today's keys are full-access.
- **Versioned + documented**: keep `/v1/`, write a minimal OpenAPI spec, ship a Postman collection. Don't build a full docs site yet — README + spec is enough for pilot-era.
- **Rate limiting**: per-key, sliding window. Pick numbers when we have one external integration actually live.

### Why this order

Automations is the runway. AI agents reuse its triggers, conditions, and action machinery — building AI first means rebuilding it on top of a shallow engine, then doing the deep pass anyway. External API webhooks pair naturally with the new automation triggers (same event taxonomy on both sides — internal automations *and* outbound webhooks fire from the same dispatcher). Pilot customer feedback still trumps the roadmap; if they ask for analytics first, that jumps the queue.
