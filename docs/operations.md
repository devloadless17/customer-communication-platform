# Operations & Deployment Runbook

Deep-dive companion to [CLAUDE.md](../CLAUDE.md). Everything here is load-bearing production knowledge that used to live inline in the handbook. If you change any number or ordering rule below, update the handbook's "Non-negotiable invariants" section too.

The whole platform runs on **one Hostinger KVM2 VPS** (8 GB RAM). Buy more iron only when a named scaling cliff (below) is actually hit — not preemptively.

---

## 1. Process & container topology

`docker compose` drives the stack directly — **no process supervisor** (no pm2, no systemd unit for the app). The legacy `ccp` systemd unit was removed 2026-05-26 because its `Restart=always` fought every manual `docker stop`/`down` and never pruned images (the VPS disk filled).

Five services in [docker-compose.yml](../docker-compose.yml), one internal network (`ccp_net`):

| Service | Image | `mem_limit` / reservation | cpus | `stop_grace_period` | Notes |
|---|---|---|---|---|---|
| `postgres` | `postgres:16.6-alpine` | 1500m / 512m | 1.0 | — | host `127.0.0.1:5433`, container `postgres:5432` |
| `redis` | `redis:7.4-alpine` | 256m / 64m | 0.5 | — | BullMQ + rate-limit buckets (in-process today) |
| `app` (web, :3000) | `…:latest-web` | 2g / 768m | 1.5 | 30s | Next.js; `depends_on: api healthy` |
| `api` (:4000) | `…:latest-api` | 3g / 1g | 2.0 | **100s** | NestJS; CMD runs `prisma migrate deploy` first |
| `caddy` | `caddy:2-alpine` | — | — | 20s | only for the local `--profile local` stack |

**Restart policy is `restart: unless-stopped` on every prod service.** Docker auto-restarts on crash and on VPS reboot, but a manual `docker compose down` / `docker stop` sticks (Docker's own desired-state tracking, unlike the removed systemd wrapper).

In the VPS deploy, **Caddy runs host-native** (`systemctl reload caddy`) from the rendered template — only the *app* stack is in compose. The compose `caddy` service exists for the local prod-imitate stack.

---

## 2. Node heap — must fit UNDER the container `mem_limit`

Heap caps live in each **Dockerfile's `ENV NODE_OPTIONS`**, not compose (env-on-host never propagates through compose):

- api: `--max-old-space-size=2048 --conditions=react-server` (container `mem_limit: 3g`)
- web runtime: `--max-old-space-size=1536` (container `mem_limit: 2g`); web build uses `3072`

**Rule: `--max-old-space-size` ≤ ~75% of the service's compose `mem_limit`.** RSS ≈ heap + 0.5–1 GB for native/buffers/Socket.io, so it must have headroom under the cgroup cap.

These were `4096` until 2026-06-01 — a latent bug. The 8 GB box already commits ~6.75 GB across the four mem_limits (postgres 1.5 + redis 0.25 + api 3 + web 2), so the limits can't be raised. A 4 GB V8 heap can never be backed when the cgroup caps the process at 2–3 GB: V8 grows toward 4 GB while the cgroup **OOM-kills at the mem_limit BEFORE GC engages** (`exited (137)`), producing cascading flakiness (proxy `ECONNRESET`, dropped `message:new` frames, optimistic sends hitting the watchdog and going red). Don't bump back to 4096. If a service genuinely needs more heap, raise its `mem_limit` first — which this box can't afford without shrinking postgres/redis.

**Dev is lower on purpose** (WSL host ~9.7 GB): web `dev` = 3072, api `dev` = 2048. Running both dev servers at 4 GB (8 GB combined) overcommitted during webpack spikes and the Linux OOM-killer killed the api (`exited (137)`). A big `.wslconfig` `memory=` bump is *not* the fix — the host is too small to give WSL more without starving Windows. If a dev server throws a **V8** "JavaScript heap out of memory" (distinct from 137), bump that one's dev cap a notch.

### Dev-watcher OOM (not an app leak)
Symptom: `FATAL ERROR: Ineffective mark-compacts near heap limit` after a long edit session. Cause: `next dev` (Turbopack) + `node --watch -r @swc-node/register` accumulate bundler/AST state across hot-reloads. Fix: `rm -rf .next` → restart `pnpm dev` → (last resort) bump heap to 6 GB for that heavy session. Habit: restart dev ~hourly during heavy work. This is a dev-watcher artifact — don't chase phantom leaks in app code from a dev-mode OOM.

---

## 3. Graceful shutdown — load-bearing for workers

`apps/api/src/main.ts` installs its **own** `SIGTERM`/`SIGINT` handlers (NOT `app.enableShutdownHooks()`, which fires `OnModuleDestroy` before the HTTP server closes — leaving a window where the api still accepts requests that get SIGKILL'd when the drain budget expires). The manual handler inverts the order: **stop accepting first, then drain.**

```
SIGTERM → main.ts shutdown() →
  drainSockets()                            (Socket.io: deliberate disconnect on "/" and
                                             "/widget" so clients reconnect immediately)
  server.close() + closeIdleConnections()   (stop accepting; Caddy sees us down fast)
  → ~3s flush budget for in-flight responses
  → app.close()  (capped at APP_CLOSE_BUDGET_MS = 90_000)
       → OnModuleDestroy hooks fire in reverse-init order →
            stop sweepers → stop workers (BullMQ worker.close() awaits the in-flight
            job, bounded by lockDuration; then releases the Redis lock cleanly)
            → close queues
  → process.exit(0)
```

`app.close()` fires the full NestJS lifecycle on its own — we only wire the signal listeners ourselves. `uncaughtException` drains via the same path (30s backstop) then exits so Docker restarts clean; `unhandledRejection` is log-and-continue (dominated by fire-and-forget `void publish(...)` sites).

**Why the socket drain comes first:** open WebSockets keep the HTTP server alive, so `server.close()` could never resolve while an agent had the inbox open — it always fell through its 3s fallback and the sockets died with the process. A browser sees that as an abrupt reset and waits out its full reconnect backoff, so every deploy blacked out the inbox for seconds. `drainSockets()` (`realtime/ws-adapter.ts`) sends a real disconnect instead; clients reconnect at once and `server.close()` resolves on its own. Measured with 3 visitor sockets attached: shutdown completed inside the same second, and clients reported `io server disconnect` rather than `transport close`. It is best-effort and fully caught — a failure here must never block shutdown.

**Invariants:** keep the socket drain and `server.close()` ordered BEFORE `app.close()`; don't strip the manual handlers; don't drop `stop_grace_period` below ~100s on api. **Every BullMQ worker's `lockDuration` must stay ≤ 90s and its own close cap ≤ 85s** — hooks run sequentially inside one 90s `app.close()` budget, so a worker whose lock outlives the process gets its job re-claimed and re-executed on the next boot (for the AI reply worker that meant a second model call and a second billed send; it was 120s until this was caught). If a worker dies mid-job, BullMQ re-claims the job after `lockDuration` (90s) and re-executes it — the `OutboundSendAttempt` ledger is what prevents a double Meta send in that window.

---

## 4. Queues (Redis / BullMQ)

All workers run **in-process** by default. `RUN_WORKER_INLINE !== "0"` starts them inside the NestJS process; **`main.ts` refuses to boot in production if `RUN_WORKER_INLINE=0`** — there is no external worker entrypoint (the standalone `worker` compose service was removed post-migration), so `0` would be a silent outage (sends still 2xx, health green, nothing drains). Set `0` only if you re-introduce a standalone worker container.

| Queue | Files | Retry / notes |
|---|---|---|
| `workflows` | `lib/workflows/queue.ts` + `worker.ts` | 3 attempts, exp 2s; `lockDuration=90s`; per-team concurrency cap |
| `message-sends` | `messages/send-queue.ts` + `send-worker.service.ts` | 3; `lockDuration=90s`; `OutboundSendAttempt(jobId)` idempotency gate before the Meta call |
| `webhook-deliver` | `lib/outbound-webhooks/queue.ts` + `worker.ts` | 7 attempts, exp 30s (~31 min tail); auto-disables a webhook after a failure threshold |
| `coexistence-history` | `lib/coexistence/history-queue.ts` + `history-worker.ts` | WhatsApp Coexistence history backfill |
| `broadcast-schedule` | `lib/broadcasts/schedule-queue.ts` + `schedule-worker.ts` | delayed job fires a scheduled broadcast (CAS `scheduled→queued`) |

Queue discipline: bounded retries, dead-letter via `removeOnFail` retention, idempotent enqueue (`jobId` derived from a stable key), never a recursive job, never a queue storm. Dedicated blocking Redis connection per worker (`.duplicate()`; never share the producer connection). The workflow worker `lockDuration` is boot-asserted to exceed `MAX_STEP_TIMEOUT_MS + 10s` so a slow `http_request` step can't outlive its lock and double-fire.

---

## 5. Sweepers

Started by `WorkflowWorkerService.onModuleInit` (files under `apps/api/src/lib/sweepers/`). Each is defense-in-depth reconciliation, not the primary write path:

`inbound-media`, `stale-calls`, `workflow-waiting`, `workflow-awaiting-reply`, `contact-last-inbound-drift`, `conversation-analytics-drift`, `auth-table-cleanup`, `outbound-webhook-delivery-cleanup`, `api-idempotency-cleanup`, `blob-orphan`, `outbound-event-retention` (bus outbox TTL), `outbound-send-attempt-retention`, `workflow-run-retention`, `conversation-event-retention`, `message-rawpayload-retention` (opt-in), `broadcast-schedule-drift`, `orphan-webhook-delivery`.

Example: `contact-last-inbound-drift` runs daily, reconciles `Contact.lastInboundAt` against `MAX(Message.timestamp)`, and self-disables after 7 days of zero drift (re-enables on process restart).

---

## 6. Rate limiting & correlation

**`RateLimitInterceptor`** (`apps/api/src/common/rate-limit.interceptor.ts`, registered `APP_INTERCEPTOR`) — an *interceptor*, not a guard, because global guards run before per-controller `@UseGuards` and would see no principal. Buckets by `u:${userId}` or `k:${apiKeyId}`. Default **300 req/min/user**; `@RateLimit({ perMinute })` overrides (e.g. `messages.send` 60, external list 600, bulk-tag 20). The bucket key includes a scope (default = controller class) so unrelated controllers sharing a `perMinute` don't collide. Refunds tokens on idempotent `/v1` replays. In-memory today; moves to Redis on the same trigger as everything else (a second app instance).

API-key routes get their own limits in `ApiKeyGuard`: 60 req/min/key + a 30 req/min/IP negative-path bucket.

**Correlation IDs** (`apps/api/src/common/correlation.ts`) — `correlationMiddleware()` runs FIRST in `main.ts` (before bodyParser) so the `AsyncLocalStorage` scope covers the whole request. Accepts inbound `X-Request-Id` (`/^[A-Za-z0-9_-]{8,64}$/`), else mints a UUID; echoes `X-Request-Id`. Also carries `chainDepth` (from `X-CCP-Depth`, the cross-system loop counter) and an `idempotentReplay` flag. For framework-agnostic `lib/` code, wrap logs with `withCorrelation(msg)`.

---

## 7. Deploy pipeline (CI)

[.github/workflows/deploy.yml](../.github/workflows/deploy.yml):

- **Triggers**: PR → typecheck + lint only; push to `main` → full pipeline; `workflow_dispatch` → forced full rebuild (use this to force a deploy when a config-only commit was skipped by paths-filter).
- **Job graph**: `typecheck` ∥ `changes` (dorny/paths-filter decides web/api rebuild, skips the unchanged app's `next build`) → `build-web`/`build-api` (conditional) → `smoke` → `ship` → `wait-for-health` → auto-rollback-on-failure.
- **Trivy gate**: `severity: HIGH,CRITICAL`, `exit-code: 1`, `ignore-unfixed: true`, honors root `.trivyignore`. Runs per-image in build jobs AND **re-scans both `:latest-{web,api}` in `smoke`** (closes the "only one app rebuilt, other pulled stale" bypass).
- **Secrets never hit CI disk**: the deploy bundle (`ccp-deploy.tar.gz` = compose + rendered Caddyfile + `pg-backup.sh`) is secret-free; the real `/opt/ccp/.env` is read on the VPS over the SSH env channel. Sets `NEXT_PUBLIC_API_URL=` (empty → same-origin), `META_GRAPH_VERSION=v25.0`.
- **Ship**: snapshots `/etc/caddy/Caddyfile.prev`, pre-migration `pg_dump`, `docker compose pull && up -d --remove-orphans`, `docker image prune -f`, installs nightly pg-backup cron (03:17 UTC).
- **Health gate** 150s (must exceed api's 120s start_period). `:previous-{web,api}` promoted only after health passes. **Auto-rollback** on health/ship failure: retags `:previous`→`:latest` (also pushed to registry), restores `Caddyfile.prev`, detects P3009 failed-migration with a runbook.

**Deploy trigger note**: config-only commits skip build+ship (paths-filter). Force with `gh workflow run deploy.yml --ref main`. The CI "typecheck" job also runs lint. `gh run watch` shows a false X on the SSH step — trust the settled `gh run view --json conclusion`.

---

## 8. Caddy routing (order is load-bearing — first match wins)

[deploy/Caddyfile.template](../deploy/Caddyfile.template) is rendered per-deploy (`__DOMAIN__`, `__ADMIN_EMAIL__`). Handle blocks in order:

1. `/api/auth/change-password*` → api :4000 (moved off Better Auth — must come BEFORE the wildcard)
2. `/api/auth/*` → web :3000 (Better Auth catch-all)
3. `/api/health` → web :3000
4. `/api/webhooks/meta/*` → web :3000 (legacy proxy forwards raw bytes so HMAC still verifies)
5. `/api/internal/*` → `respond 404` (edge-refused; internal-only over docker net)
6. `{path /api/* /webhooks/*}` → api :4000 (covers Socket.io `/api/socket/*`; 5m read/write timeout, active `health_uri /health`)
7. default → web :3000 (probes shallow `/api/health/web` so an api blip doesn't blackout `/login`)

Global: HTTP/3 (`protocols h3 h2 h1`), HSTS/nosniff/`X-Frame-Options SAMEORIGIN`, immutable cache for `/_next/static/*`, `encode zstd gzip` (off for `/api/*`). No Caddy-layer rate limiting or CSP — both are in-process (CSP set by `proxy.ts`).

**Meta webhook URL flip**: point the Meta App Dashboard at the canonical `https://<host>/webhooks/meta/{teamId}` (api). The legacy `/api/webhooks/meta/{teamId}` proxy is insurance during cutover — delete `apps/web/src/app/api/webhooks/meta/[teamId]/route.ts` once every subscription is on the new URL.

---

## 9. Observability — health, degradation, alerting

`GET /health` (no auth) reports `ok`, `db`, `redis`, `uptimeSec`, `pgPool`, `jobFailures`, `outboxLag`, `widgetVisitorSockets`, `ffmpeg`, and **`degraded: string[]`**.

**`ok`/503 is a ROUTING decision, not a health verdict.** It 503s only when Postgres is down. A wedged outbox, an exhausted connection pool, a queue burning through retries, and a media backlog all keep `ok: true` **on purpose** — a degraded api must stay in Caddy's rotation rather than stop accepting Meta webhooks it could still ingest. The cost of that choice is that the process can be in serious trouble and still answer 200.

`degraded` closes the gap: it is the same raw numbers, evaluated against thresholds (`health/health-thresholds.ts`), rendered as plain sentences. Empty means healthy.

- **External monitoring** (the half we can't build from inside — a crashed process cannot report on itself). **Point it at the public `https://<host>/api/health`, NOT the api's `/health`**: Caddy routes `/api/health` to Next.js and does not expose the api's own `/health` to the internet at all (it is reachable only on the docker network and by Caddy's active upstream probe). The public endpoint forwards a **`degradedCount`** integer — alert on **`degradedCount > 0`**, plus the usual non-200 / timeout checks. It carries the count only, never the `degraded` strings, which describe our capacity and current load and stay internal. `degradedCount` deliberately does **not** change the status code: that endpoint is the web container's healthcheck, and 503ing over a saturated pool would restart-loop the container during the exact load spike that caused it.
- **`HealthWatchdogService`** re-evaluates the same list every 60s and logs on TRANSITION — `HEALTH DEGRADED: …` on entry and on any change to which conditions are breached, `HEALTH RECOVERED: …` on return, and a re-statement hourly while a condition persists. Transitions, not levels, so a long outage doesn't emit 1,440 identical lines and train everyone to ignore it. Grep those two prefixes for log-based alerting.

Thresholds (tune in `health-thresholds.ts`): pool ≥85% saturated, ≥5 requests waiting for a connection, outbox oldest-pending >30s, ≥8 media jobs queued behind the ffmpeg cap, ≥25 jobs/hour exhausting retries on any queue.

**Concurrency ceilings** — every one is a single-process in-memory gate (see the scaling cliffs below):

| Env | Default | Bounds |
|---|---|---|
| `SEND_PER_TEAM_CONCURRENCY` | 3 | Per-team in-flight message sends |
| `BROADCAST_PER_TEAM_CONCURRENCY` | 2 | Concurrent broadcasts per team |
| `BROADCAST_PER_TEAM_RECIPIENT_CONCURRENCY` | 16 | Per-team in-flight broadcast recipients |
| `MAX_RUNNING_BROADCASTS` | 6 | Concurrent broadcasts **process-wide** |
| `FFMPEG_CONCURRENCY` | 2 | Concurrent ffmpeg subprocesses **process-wide** |

The two process-wide caps exist because per-team fairness does not imply a survivable total: ~30 tenants × 2 broadcasts × 16 lanes is ~960 concurrent sends, and unbounded ffmpeg spawns are charged to the api container's `mem_limit`, so a burst of inbound videos OOM-kills the **API**, not the transcode. Work that can't get a slot queues (broadcasts stay `queued` and retry; ffmpeg callers degrade to no-thumbnail / send-original after their wait budget) — deferred, never dropped.

---

## 10. Scaling cliffs (don't pre-build)

- **Second app instance** → move Socket.io to the Redis adapter, add sticky sessions, and move rate-limit buckets + provider-config cache to Redis. (Everything in-process today assumes a single process.)
- **50–200 tenants** → the in-process credential cache + grow-only Maps start to leak. Add eviction / move to Redis then.
- **10k+ recipient broadcasts** → the in-process broadcast runner holds too much state; move it to a dedicated BullMQ worker.
- **Multi-region / HA** → Redis Socket.io adapter + sticky sessions + shared media storage (already on R2). Not pilot scope.
- **Per-tenant media isolation** → single R2 bucket with team-prefixed keys today; a compromise of the token exposes all teams' media. Trigger: ~10 customers or a partner asks. Fix: per-team buckets or a `<teamId>/` signed-URL policy (already the key layout).
