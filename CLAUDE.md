# Project: WhatsApp Multi-Agent Shared Inbox

## What I'm building
A web platform where multiple internal agents collaborate on WhatsApp conversations through a shared inbox. Think Front, Intercom, or Missive but for WhatsApp. Core value is collaboration: assignments, attribution, internal notes, real-time updates. Target customer: SaaS for small/medium businesses. I have one pilot customer lined up.

## My situation
- Solo developer likes modern designs like (shadcn and framermotion)
- Comfortable with JavaScript/Node and Next.js
- New to realtime systems and message queues
- 4-week MVP timeline
- Building Phase 1 with Evolution API + a burner WhatsApp number for self-testing
- Phase 2 (post-MVP) will migrate the pilot customer to the official WhatsApp Cloud API

## Stack (decided, don't suggest alternatives)
- **Frontend:** Next.js (App Router)
- **Backend:** Next.js API routes + custom server for Socket.io
- **Database:** PostgreSQL (via Prisma)
- **Realtime:** Socket.io (rejected managed alternatives — I want to learn this)
- **Auth:** NextAuth
- **WhatsApp provider:** Evolution API (Phase 1) → Official Meta Cloud API (Phase 2)
- **Infra:** Docker Compose, single VPS for MVP
- **Evolution image:** `evoapicloud/evolution-api` pinned to a specific version (NOT `atendai/...` — that's the old publisher, frozen at v2.2.x)

## Architecture

```
Customer WhatsApp
    ↓
Evolution API (Docker container, internal network only)
    ↓ HTTPS webhook
Next.js API route (/api/webhooks/evolution)
    ↓
Provider adapter → normalize → dedupe → save to Postgres
    ↓
Socket.io emit to subscribed clients
    ↓
Browser updates in realtime
```

Browsers connect Socket.io to my app server. Evolution NEVER talks to browsers directly. All WhatsApp protocol details are hidden behind a `MessagingProvider` interface.

## Critical architectural rules (don't violate these)

1. **Provider abstraction from day one.** Define a `MessagingProvider` interface. Implement `EvolutionProvider` first. Phase 2 will add `OfficialMetaProvider`. App code only ever talks to the interface, never directly to Evolution's API shape.

2. **Multi-tenancy from day one.** Every table has a `team_id` column, defaulting to 1. I'm single-tenant for MVP but I will not pay for that migration later.

3. **Deduplication is critical.** Evolution sends duplicate webhooks. Unique index on `external_id` in the messages table. Use `upsert`, not `create`.

4. **Keep raw payloads.** Every message row has a `raw_payload` JSONB column with the original Evolution webhook body. Critical for debugging.

5. **Webhook security.** Evolution → app traffic stays inside the Docker network (`http://app:3000` from the `evolution` container). The webhook route should verify the request came from inside the network, not from the public internet.

6. **Cloud API forward-compatibility.** Some Evolution features won't survive Phase 2 migration:
   - 24-hour customer service window will apply
   - Outbound to a fresh contact requires pre-approved templates
   - Media goes through Meta media IDs, not direct URLs
   - Typing indicators may go away
   Flag any feature I ask for that uses Evolution-only behavior.

## Database schema (initial)

- `users` — id, team_id, role (admin/agent), name, email
- `teams` — id, name
- `contacts` — id, team_id, phone_number, name
- `conversations` — id, team_id, contact_id, assigned_user_id, status (open/pending/closed)
- `messages` — id, team_id, conversation_id, external_id (UNIQUE), sender_user_id (nullable for inbound), body, direction (in/out), provider, status (sent/delivered/read/failed), raw_payload (JSONB), timestamp
- `internal_notes` — id, conversation_id, author_user_id, body, timestamp

## Docker Compose layout

Services on one internal network: `postgres`, `redis`, `evolution`, `app`. Only `app` publishes a port. Evolution is reachable from app at `http://evolution:8080`. App is reachable from Evolution at `http://app:3000/api/webhooks/evolution`. Postgres + Evolution + Redis are completely invisible to the public internet.

## Week-by-week MVP plan

**Week 1 — Foundations**
- Docker Compose: Postgres + Redis + Evolution + Next.js
- Next.js project with NextAuth, Prisma schema with team_id everywhere
- Evolution running, instance created, QR scanned with burner number
- Webhook endpoint: receive → normalize → dedupe → save (raw_payload kept)
- `MessagingProvider` interface + `EvolutionProvider` implementation
- Test full round trip: send from API, reply from phone, both rows in DB

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
- Session status indicator (Connected/Disconnected) — Evolution sessions drop
- Self-use, fix real bugs

**Week 4 — Deploy + pilot**
- Deploy to a VPS, single Socket.io instance (sticky sessions later)
- Public HTTPS for the app (Caddy or Traefik reverse proxy)
- Basic logging
- Onboard pilot customer (still on Evolution, transparent it's beta)

## Explicitly deferred (don't build, don't suggest)

Tags, labels, analytics, automations, AI replies, templates UI, bulk send, multi-channel, per-agent unread, advanced permissions, audit log UI, billing, Redis pub/sub for Socket.io scaling, BullMQ, NestJS.

## How I want you to work with me

- **Match the stack above.** Don't suggest Pusher, Ably, Supabase Realtime, tRPC, GraphQL, or any rewrites.
- **Code first, explanation second.** I'm a working developer. Show me the code, then a short note on what's non-obvious.
- **Surface tradeoffs, don't hide them.** When you make a design choice, tell me what you rejected and why in 1-2 sentences.
- **Flag Phase 2 risks.** If I ask for something that will break when migrating to Meta Cloud API, say so before writing the code.
- **Ask before scaffolding huge things.** If a request implies generating 10+ files, propose a file list first and let me approve it.
- **Prisma over raw SQL** for schema and queries. Migrations via `prisma migrate dev`.
- **TypeScript everywhere.** Strict mode.
- **Don't write tests yet** unless I ask. I'll add them after the MVP works end-to-end.

## What I'm working on right now

[REPLACE THIS WITH YOUR CURRENT TASK — e.g., "Setting up the Docker Compose file and getting Evolution running locally" or "Building the webhook handler" or "Wiring up Socket.io in a Next.js custom server"]

## My first ask

[REPLACE THIS WITH YOUR FIRST CONCRETE REQUEST]