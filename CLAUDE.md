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
- **Auth:** NextAuth
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
- Next.js project with NextAuth, Prisma schema with team_id everywhere
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

Tags, labels, analytics, automations, AI replies, template send/manage UI, bulk send, multi-channel, per-agent unread, advanced permissions, audit log UI, billing, Redis pub/sub for Socket.io scaling, BullMQ, NestJS, Embedded Signup, media (images/audio/video) send + receive.

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

[REPLACE THIS WITH YOUR CURRENT TASK]

## My first ask

[REPLACE THIS WITH YOUR FIRST CONCRETE REQUEST]
