# Onboarding — Customer Communication Platform

WhatsApp shared-inbox SaaS. Solo-built so far; this doc gets a second dev to "running locally + first PR" in under an hour.

Architecture, rules, deferred-on-purpose lists: read [CLAUDE.md](CLAUDE.md) right after this. It's the source of truth; this doc is just the runway.

## Prerequisites

- **Node 24** (check with `node -v`). Older versions crash on the `--max-old-space-size` flag baked into the scripts.
- **pnpm 10** (`corepack enable && corepack prepare pnpm@10.34.4 --activate`).
- **Docker + docker compose**.
- **Linux / macOS / WSL2.** Native Windows is not tested.

## First-time setup

```bash
git clone <repo>
cd customer-communication-platform
pnpm install                       # also runs `prisma generate`

cp .env.example .env                # fill in BETTER_AUTH_SECRET, ENCRYPTION_KEY, INTERNAL_BUS_SECRET,
                                    # and the R2_* media-storage keys (see "Secrets" below)

docker compose up -d postgres redis # just the data layer
pnpm run db:migrate                 # apply schema
pnpm run db:seed:superadmin         # creates the bootstrap admin user

pnpm run dev                        # boots BOTH apps in parallel (web :3000 + api :4000)
                                    # for separate logs, use two shells: `pnpm web:dev` and `pnpm api:dev`
```

Open http://localhost:3000, log in with the superadmin credentials printed by the seed script. Change the password from `/settings/account`.

### Or run the whole stack in Docker

```bash
pnpm run prod:local                 # docker compose up --build  (foreground)
pnpm run prod:local:detached        # same, -d
pnpm run prod:local:logs            # tail app logs
pnpm run prod:local:down            # stop, keep data
pnpm run prod:local:nuke            # stop + wipe volumes
```

After `:nuke` you have to re-run `pnpm run db:seed:superadmin` against the fresh DB — Docker reset doesn't preserve the seed. (GHA seeds it automatically on every prod deploy; only local resets need the manual step.)

## Daily commands

| Script | What it does |
|---|---|
| `pnpm run dev` | Both apps in parallel (`turbo run dev --parallel`) — web :3000 + api :4000 |
| `pnpm run web:dev` | Next.js dev (`apps/web`) on :3000, standalone |
| `pnpm run api:dev` | NestJS dev (`apps/api`) on :4000, swc-node loader, standalone |
| `pnpm run typecheck` | Both apps |
| `pnpm run lint` | Both apps |
| `pnpm run db:migrate` | `prisma migrate dev` — create + apply a new migration |
| `pnpm run db:reset` | Drop + recreate + reseed (destructive) |
| `pnpm run db:studio` | Prisma Studio at :5555 |

## Branch / PR workflow

- `main` is protected — no direct pushes. Branch off `main`, open a PR, squash-merge.
- One branch per workstream. Keep PRs small enough to read in one sitting.
- Run `pnpm run typecheck` AND smoke-boot both processes (`pnpm run dev` boots web + api together) before requesting review. Typecheck-green is necessary, not sufficient — NestJS DI failures and shared-lib regressions only surface at boot.
- Don't `--no-verify` past a failing hook. If a hook fails, fix the underlying issue.

## Database migrations — coordinate

Only one person creates new migrations at a time. The workflow:

1. Pull `main`, make sure nobody else has an open migration PR.
2. Edit [prisma/schema.prisma](prisma/schema.prisma).
3. `pnpm run db:migrate` → name the migration descriptively.
4. Push immediately and open the PR. The other dev pulls before doing schema work.

Conflicts on migration files are merge-hell — the timestamps clash, Prisma re-orders, and replay against a fresh DB diverges from the merged state. The "push first" rule avoids it.

## Secrets — what you need your own copy of

| Variable | Get your own | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` | Per-dev. Sessions don't need to be portable. |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` | Per-dev. Encrypts per-team Meta secrets at rest. |
| `INTERNAL_BUS_SECRET` | `openssl rand -base64 32` | Per-dev. Both apps must agree (use the same value in your `.env`). |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | A Cloudflare R2 bucket + an S3 API token ("Object Read & Write") | Media storage (inbound/outbound media + avatars). Without these, every inbound media message is silently swallowed. Don't share production keys. |
| Meta credentials (per-team) | Your own Meta test app + a test recipient phone | Pasted in `/settings/meta` + `/settings/whatsapp` after login, not in `.env`. The in-app settings pages walk through the full flow (callback URL, verify token, webhook fields). |

**Never** commit `.env`. It's gitignored, but stay paranoid. Production secrets live on the VPS and in GHA only — they're not in any local env file.

## Stack at a glance

- **`apps/web`** — Next.js 16 (App Router, RSC). Owns auth pages + page rendering only post-migration.
- **`apps/api`** — NestJS 11. Owns REST, Socket.io, Meta webhooks, BullMQ workers, workflow engine.
- **Postgres** via Prisma. One pool per process.
- **Redis** for BullMQ.
- **Caddy** reverse-proxies both processes on a single origin in prod.

Caddy routing (prod): `/`, `/_next/*`, `/api/auth/*` → web. `/api/*`, `/socket.io/*`, `/webhooks/*` → api. The only exception: `/api/auth/change-password` lives on api despite the `/api/auth/` prefix. See [deploy/Caddyfile.template](deploy/Caddyfile.template).

## Gotchas — read before you waste an afternoon

- **NestJS uses `@swc-node/register`, not `tsx`.** esbuild (tsx's backend) doesn't emit decorator metadata, which silently breaks Nest DI. Don't switch back. The `api:dev` / `api:start` scripts already pin this.
- **Dev OOMs after a long edit session** (`FATAL ERROR: Ineffective mark-compacts near heap limit`) are a `@swc-node/register` watch + Next.js dev-mode artifact, not an app leak. Fix: `rm -rf .next` and restart `pnpm run dev`. Bump heap to 6GB if 4GB isn't enough during a heavy session.
- **Local dev tools spoof Meta webhooks** via `POST /api/dev/emit`. Set `ENABLE_DEV_TOOLS=1` in `.env` to use it. The api process hard-crashes on boot if this is `1` with `NODE_ENV=production` — that's intentional.
- **Ghost service worker on localhost.** If `http://localhost:3000` misbehaves with the server down, it's a leftover SW from a prior app on the same origin. Force-unregister in DevTools → Application → Service Workers.
- **Better Auth stays on Next.js.** Don't move auth into NestJS. NestJS validates sessions via a guard that reads the cookie + hits the session table through Prisma. ~1ms overhead, zero migration risk.
- **Realtime cache patches go in BOTH places.** When you add a socket event that mutates per-thread state (status / assignment / tag / etc.), wire it in [apps/web/src/features/inbox/lib/thread-reducers.ts](apps/web/src/features/inbox/lib/thread-reducers.ts) AND `useConversationEvents` AND `inbox-shell.tsx`. Skipping the cached-shell side means chat-switch-and-back reverts the field to a stale snapshot. The header comment in `thread-reducers.ts` has the full table.
- **`pnpm run db:seed:superadmin` after every fresh DB.** `docker compose down -v` wipes the seed.

## Where things live

- **Architecture, rules, deferred-on-purpose:** [CLAUDE.md](CLAUDE.md). Read this next.
- **Web app:** [apps/web/src/](apps/web/src/)
- **API app:** [apps/api/src/](apps/api/src/)
- **Shared lib (framework-agnostic):** [apps/api/src/lib/](apps/api/src/lib/) — messaging, conversations, contacts, workflows, providers.
- **Schema + migrations:** [prisma/](prisma/)
- **Deploy artifacts:** [deploy/](deploy/) — Caddyfile templates + deploy README. (No process supervisor — `docker compose` drives the stack directly.)
- **Future customer-onboarding flow (Meta Embedded Signup):** [docs/onboarding-future.md](docs/onboarding-future.md). Post-MVP.

## Active workstream

Currently: **NestJS migration deploy soak**. Migration code is shipped; we're verifying in dev before pushing to prod. AI agents, outbound webhooks, scoped API keys, round-robin assignment are paused until that lands. Check CLAUDE.md "What I'm working on right now" for the latest state.
