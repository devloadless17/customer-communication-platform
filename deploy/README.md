# Deploy

**Pattern: build in CI, pull from Docker Hub on the VPS.** The VPS holds no
source code — only config files.

Every deploy is one workflow (`.github/workflows/deploy.yml`):

1. `typecheck` job — `pnpm install --frozen-lockfile`, `prisma generate`, `tsc --noEmit`, `lint`. Runs on every push and PR. (pnpm-only — npm breaks the `workspace:*` lockfile.)
2. `deploy` job — runs only on push to `main` (or manual `workflow_dispatch`). Needs typecheck to pass.
   - builds the new image and pushes it as `:latest` (Trivy CVE gate + smoke-boot before ship)
   - SSHes to the VPS and writes/refreshes the config files
   - `docker compose pull && docker compose up -d --remove-orphans && docker image prune -f && systemctl reload caddy`
   - polls `/api/health` end-to-end
   - **only after health is green**, retags the now-verified-live `:latest` as
     `:previous` on Docker Hub (manifest-only copy, free) — so the rollback
     target is always an image that actually served traffic, never a
     Trivy/smoke/health-blocked one

> **No systemd.** The stack is driven directly by `docker compose` (there is
> no `ccp` systemd unit any more — the deploy auto-removes a legacy one if it
> finds it). Every service is now `restart: unless-stopped` (was `"no"` up to
> 2026-05-26): Docker auto-restarts on **crash** and on **VPS reboot**, but a
> manual `docker compose down` / `docker stop` STICKS. This is Docker's own
> policy — it doesn't have the bounce-back pathology the removed systemd
> wrapper had (which fought manual stops). See "Starting / stopping the
> stack" below.

## Topology

```
   Docker Hub                              Hostinger KVM2 (Ubuntu, as root)
   ┌────────────────────────┐              ┌──────────────────────────────────┐
   │ <docker_username>/     │              │  Caddy (host) :443 (HTTPS)       │
   │   customer-communica…  │              │   ↓ (path-based routing)         │
   │   :latest              │   ──pull──►  │  ┌────────────┐ ┌──────────────┐ │
   │   :previous            │              │  │ web  :3000 │ │ api    :4000 │ │
   └────────────────────────┘              │  │ (Next.js)  │ │ (NestJS)     │ │
                                           │  └────────────┘ └──────────────┘ │
                                           │   ↓                ↓             │
                                           │  postgres :5432   redis :6379    │
                                           └──────────────────────────────────┘
                                                    central.loadless.site
                                                    187.77.180.44
```

Caddy splits traffic by path between the two app containers — see
`deploy/Caddyfile.template` for the exact rule order. Short version:

- `/api/auth/change-password*` and `/api/*`, `/webhooks/*` → api (NestJS). The
  Socket.io client connects on `/api/socket/*` (caught by the `/api/*` matcher —
  there is no separate `/socket.io/*` rule).
- everything else (`/`, `/_next/*`, `/api/auth/*`, `/api/health`) → web (Next.js)

## What lives on the VPS

Three files, split between the `deploy` user's app dir and system locations.

```
/opt/ccp/docker-compose.yml   ← owned by deploy, shipped from ./docker-compose.yml
/opt/ccp/.env                 ← owned by deploy (mode 600), rendered from GitHub Secrets
/etc/caddy/Caddyfile          ← owned by root, rendered from deploy/Caddyfile.template
```

There is no systemd unit: the deploy job runs `docker compose up -d` as the
`deploy` user directly (its own `docker login` credentials). The one
`/etc/...` file (Caddyfile) is written via `sudo`. Caddy itself still runs as
a host service (`systemctl reload caddy`) — only the *app* stack moved off
systemd.

State that survives across deploys (Docker volumes):

```
postgres_data     ← your database
redis_data        ← BullMQ queue state
```

These live under `/var/lib/docker/volumes/`. Wipe them with
`docker compose down -v` and you start from a clean DB.

## Branch + deploy model

| Branch | Purpose | Trigger |
|---|---|---|
| `main` | Production. Tracks `central.loadless.site` exactly. | PR → typecheck. Merge → typecheck + deploy. |

(Once you add a `dev` branch, extend the workflow's `push:` + `pull_request:` branch list.)

---

# One-time setup

You only do this once. Future deploys are fully automated.

## 1. Install docker + caddy + ufw on the VPS

```bash
apt-get install -y docker.io docker-compose-plugin caddy ufw
# 443/udp is REQUIRED for HTTP/3 (QUIC) — the Caddyfile enables `protocols h3
# h2 h1`, and h3 runs over UDP. Without this rule Caddy still advertises
# `h3=":443"` via Alt-Svc but every QUIC attempt is dropped at the firewall,
# costing clients a failed handshake before they silently fall back to h2.
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw enable
```

## 1b. Create the `deploy` user + prerequisites

The workflow SSHes as `deploy`, not `root`. The deploy user needs three
things: docker-group membership, passwordless sudo (for the `sudo mv` /
`sudo systemctl` calls in the workflow), and an `/opt/ccp` directory it
owns. Run as root once on a fresh VPS:

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Passwordless sudo so the workflow's `sudo mv` / `sudo systemctl` work
# without TTY. Pragmatic for solo MVP — restrict via command allowlist
# later if you add collaborators with deploy-user SSH access.
echo "deploy ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
visudo -c   # sanity-check syntax

# App directory the workflow writes into
mkdir -p /opt/ccp
chown deploy:deploy /opt/ccp
chmod 750 /opt/ccp
```

Verify before continuing:

```bash
sudo -u deploy docker ps           # should not say "permission denied"
sudo -u deploy sudo -n true        # should exit 0 (NOPASSWD works)
sudo -u deploy ls -ld /opt/ccp     # should be deploy:deploy 750
```

## 2. Create a Docker Hub access token

Docker Hub passwords don't work for CLI/CI auth on accounts with 2FA, and
even without 2FA an access token is best practice (scoped, revocable
independently of your account password).

1. Log in to https://hub.docker.com
2. Profile → **Account Settings** → **Personal access tokens** → **Generate new token**
   - Description: `ccp-gha-deploy`
   - Permissions: **Read, Write, Delete** (needed for the build job to push and overwrite tags)
   - Expiration: 1 year (rotate annually)
3. Copy the token — you can't view it again.

This token is what you'll put in the `DOCKER_PASSWORD` secret. Your
Docker Hub username goes in `DOCKER_USERNAME`.

## 3. SSH key for GitHub Actions

```bash
# On your dev machine
ssh-keygen -t ed25519 -f ~/.ssh/ccp_deploy_v2 -N "" -C "gha-deploy-ccp"
# Public key goes into /home/deploy/.ssh/authorized_keys on the VPS
# (copied from /root/.ssh/authorized_keys by step 1b).
# Private key goes into GitHub Secret VPS_SSH_KEY.
```

## 4. GitHub Secrets — full list

```bash
gh secret list --repo devloadless17/customer-communication-platform
```

Should show all of:

```
VPS_HOST           central.loadless.site (or 187.77.180.44)
VPS_USER           deploy
VPS_SSH_KEY         (private OpenSSH key, full contents incl. BEGIN/END)
HEALTHCHECK_URL       https://central.loadless.site/api/health

DOCKER_USERNAME       (your Docker Hub username)
DOCKER_PASSWORD       (Docker Hub PAT from step 2)

APP_DOMAIN            central.loadless.site
ADMIN_EMAIL           your.real.email@example.com

POSTGRES_DB           ccp
POSTGRES_USER         app
POSTGRES_PASSWORD     (openssl rand -hex 32)
BETTER_AUTH_SECRET    (openssl rand -base64 32)
ENCRYPTION_KEY        (openssl rand -base64 32)
INTERNAL_BUS_SECRET   (openssl rand -base64 32)
R2_ACCOUNT_ID         (Cloudflare R2 account id)
R2_ACCESS_KEY_ID      (R2 S3 API token — Object Read & Write)
R2_SECRET_ACCESS_KEY  (R2 S3 API token secret)
R2_BUCKET             (e.g. central-ccp)
```

**Optional, and only once you are a Meta Tech Provider** — the app-level webhook
callback (`POST /webhooks/meta`, no workspaceId in the path):

```
META_APP_ID           (the platform Meta app id)
META_APP_SECRET       (its app secret; comma-separated to run a rotation window)
META_APP_VERIFY_TOKEN (openssl rand -hex 24)
```

Leave all three unset until then: the route answers `200 {dropped:
"app_level_not_configured"}` and the GET handshake 403s, so nothing breaks. Setting
`META_APP_ID` without the other two is a **boot failure** by design — an app-level
ingest route that cannot verify a signature is an open endpoint, and a callback with
no verify token could never be saved in Meta's dashboard. Why the route has to exist
at all: Meta delivers every onboarded customer's webhooks to the app's callback URL,
and `override_callback_uri` cannot redirect template or account webhooks. See
CLAUDE.md §12.

17 secrets. ENCRYPTION_KEY and INTERNAL_BUS_SECRET are **hard-validated** by the
deploy workflow's `changes` job (empty → the deploy fails fast), so missing
either breaks the very first deploy — they belong in this list. The superAdmin
login is **not** in GitHub Secrets — it's seeded automatically on every deploy
(idempotent upsert; credentials hardcoded in `prisma/seeds/seed-superadmin.ts`).
See "First-time superAdmin seed" below.

### One-shot to set them all (after you have the values)

```bash
REPO=devloadless17/customer-communication-platform

# Server / SSH
gh secret set VPS_HOST       --repo "$REPO" --body "central.loadless.site"
gh secret set VPS_USER       --repo "$REPO" --body "deploy"
gh secret set VPS_SSH_KEY     --repo "$REPO" < ~/.ssh/ccp_deploy_v2
gh secret set HEALTHCHECK_URL   --repo "$REPO" --body "https://central.loadless.site/api/health"

# Docker Hub
gh secret set DOCKER_USERNAME   --repo "$REPO" --body "<your-dockerhub-username>"
gh secret set DOCKER_PASSWORD   --repo "$REPO" --body "<your-dockerhub-access-token>"

# Caddy / app
gh secret set APP_DOMAIN        --repo "$REPO" --body "central.loadless.site"
gh secret set ADMIN_EMAIL       --repo "$REPO" --body "<your-real-email>"

# DB
gh secret set POSTGRES_DB       --repo "$REPO" --body "ccp"
gh secret set POSTGRES_USER     --repo "$REPO" --body "app"
gh secret set POSTGRES_PASSWORD --repo "$REPO" --body "$(openssl rand -hex 32)"
gh secret set BETTER_AUTH_SECRET --repo "$REPO" --body "$(openssl rand -base64 32)"

# Envelope encryption (per-team Meta + API-key + webhook secrets) and the
# web↔api internal-bridge shared secret. Both are deploy-blocking.
gh secret set ENCRYPTION_KEY     --repo "$REPO" --body "$(openssl rand -base64 32)"
gh secret set INTERNAL_BUS_SECRET --repo "$REPO" --body "$(openssl rand -base64 32)"

# Blob storage (Cloudflare R2 — private bucket + presigned serving)
gh secret set R2_ACCOUNT_ID        --repo "$REPO" --body "<r2-account-id>"
gh secret set R2_ACCESS_KEY_ID     --repo "$REPO" --body "<r2-access-key-id>"
gh secret set R2_SECRET_ACCESS_KEY --repo "$REPO" --body "<r2-secret-access-key>"
gh secret set R2_BUCKET            --repo "$REPO" --body "central-ccp"
```

## First-time superAdmin seed

The superAdmin is **not** bootstrapped automatically — run it once after
the first deploy on a fresh DB:

```bash
ssh deploy@central.loadless.site
# pnpm, NOT npm — the web runtime image strips npm/npx (corepack-pinned pnpm only)
docker exec -it $(docker ps -q --filter "name=app") pnpm run db:seed:superadmin
```

Credentials are hardcoded in `prisma/seeds/seed-superadmin.ts` (currently
`ali@loadless.ai` / `loadless`). Change them in the UI after first login.
Re-running the seed is idempotent (upsert) — won't break anything but will
reset the password back to what's in the file.

## 5. Branch protection on main

Repo Settings → Branches → Add rule for `main`:

- ✅ Require a pull request before merging
- ✅ Require status checks to pass (select `typecheck` from the Deploy workflow)
- ✅ Require branches to be up to date
- ✅ Do not allow bypassing

---

# Day-to-day deploys

```bash
git checkout -b feat/whatever
# … work …
git push -u origin feat/whatever         # typecheck runs on the PR
# Open PR → main on GitHub, merge it.
# Merge triggers the same workflow: typecheck + deploy.
```

Manual redeploy: GitHub → Actions → **Deploy** → **Run workflow** → main.

Emergency manual deploy if GHA is down:

```bash
ssh deploy@central.loadless.site
cd /opt/ccp
docker login -u <docker-username>             # interactive password prompt
docker compose --env-file .env pull
docker compose --env-file .env up -d --remove-orphans
docker image prune -f                          # reclaim the dangling layers the pull orphaned
sudo systemctl reload caddy
docker compose --env-file .env logs -f         # tail logs (replaces `journalctl -u ccp -f`)
```

---

# Starting / stopping the stack

No systemd, no auto-start. You drive the stack directly with `docker compose`
from `/opt/ccp` (all commands as the `deploy` user). **Nothing comes back on
its own** — not after `down`, not after a `docker stop`, not after a VPS
reboot. That's intentional.

```bash
cd /opt/ccp

# Start everything (or bring it back after a reboot / down)
docker compose --env-file .env up -d

# Stop everything — STAYS stopped. No bounce-back.
docker compose --env-file .env stop          # stop containers, keep them
docker compose --env-file .env down          # stop AND remove containers (keeps volumes)

# Stop / remove a single service
docker compose --env-file .env stop api
docker compose --env-file .env rm -sf api

# Status + logs
docker compose --env-file .env ps
docker compose --env-file .env logs -f api
```

> **Why a manual `docker stop` used to bounce back:** the old `ccp` systemd
> unit ran `docker compose up` with `Restart=always`, so the moment you
> stopped a container the unit's `up` recreated it. That unit is gone now
> (deploy auto-removes it if it's still installed). The compose `restart:`
> policy is now `unless-stopped` on every prod service — Docker's own
> policy honors a manual stop, so the bounce-back doesn't recur.

> **Reclaiming disk:** each deploy already runs `docker image prune -f`, which
> removes the dangling (untagged) layers a fresh `:latest` pull orphans — the
> main cause of disk creep. To clean up by hand at any time:
> ```bash
> docker image prune -f          # dangling images only (safe; keeps :latest-* + :previous-*)
> docker container prune -f      # exited/stopped containers
> docker system df               # see what's actually using disk
> ```
> Do NOT run `docker image prune -a` (removes ALL unused images, including
> `:previous-*` which the auto-rollback needs) or `docker system prune -a`
> on the VPS unless you're deliberately wiping the rollback target.

---

# Local development

Two modes.

## Fast iteration (95% of the time)

```bash
docker compose up -d postgres redis     # backing services only
pnpm install                             # pnpm-only — npm install breaks the workspace:* lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev                                 # Next dev + NestJS (@swc-node/register) watch
```

App at `http://localhost:3000`. NOT a prod mirror — uses pnpm directly, no
Docker for the app.

## Production mirror (before merging to main)

```bash
pnpm prod:local                          # docker compose up --build
```

Uses the single `docker-compose.yml` (which has both `image:` and `build:`).
Locally, `--build` builds the image with the tag `local/customer-communication-platform:latest`
and runs it. In production, the workflow ships the same file to `/opt/ccp/docker-compose.yml`
and the VPS pulls the prebuilt image instead of building.

| | Local (`prod:local`) | Production |
|---|---|---|
| Compose file | `./docker-compose.yml` (run with `--build`) | `/opt/ccp/docker-compose.yml` (shipped from this same file) |
| Image source | Built from your working tree | Pulled from Docker Hub |
| Reverse proxy | None — hit `http://localhost:3000` | Caddy with HTTPS |
| Secrets file | `.env` in repo (gitignored) | `/opt/ccp/.env` (workflow-rendered) |

If `prod:local` works but the VPS deploy fails, the diff is in one of
those four rows.

---

# Rolling back

Two paths depending on urgency. Database migrations do NOT auto-revert
either way — fix forward at the schema layer.

> ⚠️ **Migration-aware rollback.** The api container runs `prisma migrate
> deploy` as the first step of boot, so a deploy that ships a migration moves
> the schema FORWARD before the health gate runs. Both rollback paths below
> swap **code only** — they do NOT undo an applied migration. If the failed
> deploy included a migration, the rolled-back `:previous` code is now running
> against a newer schema and may 500 on schema-incompatible queries. The deploy
> job writes a **pre-migration snapshot** to
> `/opt/ccp/backups/pre-deploy-*-<sha>.sql.gz` right before `up`. Decide
> per-incident whether to restore it (see **Backups → Restore** below):
> additive migrations (new nullable column/table) are usually safe to leave
> forward; destructive ones (drop/rename) need the snapshot restore or a
> hand-written down-migration. Prefer expand-contract for destructive changes
> so `:previous` stays schema-compatible and this decision never arises.

## A migration that failed mid-apply (P3009)

This is the one failure class the fast `:previous` swap **cannot** fix on its
own. The api container runs `pnpm prisma migrate deploy` as the first step of
boot. If a migration fails partway (the classic case: a constraint violation
against real pilot data — CI smoke runs on a fresh DB so it can't catch
data-dependent failures), Prisma records a **FAILED** row in
`_prisma_migrations`. From then on *every* `prisma migrate deploy` — including
the one the **rolled-back `:previous-api` image runs on boot** — exits with
**P3009** (`migrate found failed migrations`) and the container crash-loops
(`restart: unless-stopped` keeps retrying). The auto-rollback step in the
workflow detects this (greps the api logs for `P3009`) and prints this runbook
pointer instead of claiming success.

Recover manually over SSH (`cd /opt/ccp`):

```bash
# 1. See which migration is stuck.
docker compose --env-file .env run --rm --entrypoint sh api \
  -c 'cd /app && pnpm prisma migrate status'

# 2a. EASIEST when the migration applied NOTHING (failed on the first
#     statement): mark it rolled-back so deploy retries it cleanly, then bring
#     the stack up. Fix the migration itself in a follow-up commit.
docker compose --env-file .env run --rm --entrypoint sh api \
  -c 'cd /app && pnpm prisma migrate resolve --rolled-back <FAILED_MIGRATION_NAME>'
docker compose --env-file .env up -d

# 2b. If the migration applied PARTIAL changes (some statements landed before
#     the failure), the schema is now inconsistent. Restore the pre-deploy
#     snapshot the deploy wrote seconds before the migration, which resets BOTH
#     the data AND _prisma_migrations to the pre-migration state:
docker compose --env-file .env stop app api
gunzip -c /opt/ccp/backups/pre-deploy-*-<failed-sha>.sql.gz \
  | docker compose --env-file .env exec -T postgres psql -U app -d ccp
# then roll the CODE back to :previous (see "Fast rollback" below) and redeploy
# a corrected migration.
```

Prevention: prefer expand-contract migrations and test data-dependent ones
against a copy of prod data before merging.

## Fast rollback (~30s) — `:previous` swap

Every deploy that goes green retags the just-shipped (health-verified)
`:latest-{web,api}` as `:previous-{web,api}` on Docker Hub at the END of the
ship job (manifest-only copy, no layer transfer, no extra storage). So
`:previous-*` is always the last image that actually served traffic — a
Trivy/smoke/health-blocked deploy never overwrites it. To roll back one step:
promote `:previous-*` back to `:latest-*`, then pull + recreate. (The deploy
workflow's auto-rollback does this for you when a post-deploy health check
fails — this is the manual equivalent.)

From your dev machine (one-shot):

```bash
REPO=<docker-username>/customer-communication-platform
for v in web api; do
  docker buildx imagetools create --tag $REPO:latest-$v $REPO:previous-$v
done

ssh deploy@central.loadless.site '
  cd /opt/ccp
  docker compose --env-file .env pull
  docker compose --env-file .env up -d --remove-orphans
'
```

Only goes one deploy back. If the deploy two-back is also bad, use
`git revert` instead.

## Normal rollback — `git revert`

`git revert` the offending commit on `main` and push — the deploy workflow
rebuilds + redeploys. ~3 min round-trip. Use this when `:previous` is also
bad, or for non-urgent rollbacks.

# Bumping image versions for Postgres / Redis

`docker-compose.yml` pins both. To bump:

1. Edit the `image:` line for `postgres` or `redis` in `docker-compose.yml`.
2. `pnpm prod:local` — verify nothing broke.
3. Open a PR to `main`, merge.

# Pre-pilot hardening (DO BEFORE accepting real traffic)

## Tighten sudo allowlist

The deploy user has `NOPASSWD: ALL` by default — a leaked `VPS_SSH_KEY`
plus this sudoers entry equals immediate full root. The SSH key is your
real protection, but defense-in-depth is cheap. Replace the open entry
with the exact-binary allowlist the workflow needs:

The app stack runs as the `deploy` user via `docker compose` (no `sudo`),
so the only `sudo` the deploy needs now is for Caddy config + the one-time
legacy `ccp` unit removal.

```bash
# On the VPS, as root
cat > /etc/sudoers.d/deploy <<'EOF'
# Deploy user — minimum-needed sudo for the GitHub Actions deploy job.
# See .github/workflows/deploy.yml for the exact invocations.
deploy ALL=(root) NOPASSWD: \
  /bin/rm -f /etc/caddy/Caddyfile.prev, \
  /usr/bin/cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev, \
  /usr/bin/cp -a /etc/caddy/Caddyfile.prev /etc/caddy/Caddyfile, \
  /usr/bin/mv /tmp/ccp-deploy/Caddyfile /etc/caddy/Caddyfile, \
  /usr/bin/mkdir -p /var/log/caddy, \
  /usr/bin/chown -R caddy\:caddy /var/log/caddy, \
  /usr/bin/caddy validate --config /etc/caddy/Caddyfile, \
  /bin/systemctl reload caddy, \
  /bin/systemctl disable --now ccp.service, \
  /bin/systemctl daemon-reload, \
  /bin/rm -f /etc/systemd/system/ccp.service
EOF
chmod 440 /etc/sudoers.d/deploy
visudo -c   # syntax check — refuses to commit if invalid
```

The first three lines are LOAD-BEARING for auto-rollback: the deploy snapshots
the live Caddyfile to `Caddyfile.prev` before overwriting it (run-scoped — it
`rm -f`s any stale `.prev` first), and the rollback restores it. The snapshot
`cp` runs WITHOUT `|| true` in the workflow, so if this allowlist is missing
those exact lines the deploy fails LOUDLY (`a password is required`) instead of
silently disarming the rollback's proxy-config restore.

The `ccp.service` disable / rm / daemon-reload lines are only exercised once
(the first deploy after this change, which removes the legacy systemd unit);
they're harmless no-ops afterward but safe to keep. If you ever add or remove
a `sudo` call in `deploy.yml`, update this file in lockstep — the deploy will
fail with `a password is required` until the allowlist matches.

# Backups

Nightly `pg_dump` of the Postgres volume to `/opt/ccp/backups/`, 14-day
retention. Script lives at `scripts/pg-backup.sh` in this repo and is shipped
to the VPS alongside the other deploy files.

**One-time setup on the VPS** (as the `deploy` user):

```bash
# Cron line — runs every night at 03:17 UTC (off the top of the hour to avoid
# bunching with everyone else's 3:00 jobs). MUST be byte-identical to the line
# the deploy workflow auto-installs (.github/workflows/deploy.yml: absolute
# /opt/ccp/pg-backup.sh path + the same `>> pg-backup.log` redirect), and uses
# the same `grep -Fv` filter-then-append so it dedupes against the deploy job's
# line instead of stacking a second (double-backup) entry. The earlier form
# here used a RELATIVE `./pg-backup.sh | logger` which the deploy job's
# absolute-path filter couldn't match → two cron lines.
CRON_LINE="17 3 * * * cd /opt/ccp && /opt/ccp/pg-backup.sh >> /opt/ccp/pg-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -Fv "/opt/ccp/pg-backup.sh" || true; echo "$CRON_LINE" ) | crontab -
```

**Restore** (the only step that matters — practice it once before you need it):

```bash
# Pick the dump file you want.
ls /opt/ccp/backups/

# Stop the app + api so nothing writes during restore, but keep postgres up.
# The Next.js container's compose service is `app` (NOT `web`) — stopping a
# non-existent `web` service errors AND leaves the still-running app container
# writing Better Auth sessions / RSC reads straight into the DB you're about
# to overwrite. Stop both real app containers.
docker compose --env-file .env stop app api

# Restore into the running postgres. --clean --if-exists in the dump means
# the file already DROPs existing objects, so this is a full overwrite.
# (Use POSTGRES_USER / POSTGRES_DB from /opt/ccp/.env if you changed them.)
gunzip -c /opt/ccp/backups/ccp-20260526T031700Z.sql.gz \
  | docker compose --env-file .env exec -T postgres psql -U app -d ccp

# Bring the app back.
docker compose --env-file .env start api app
```

**Offsite copy** (the on-VPS backups live on the SAME disk as the
`postgres_data` volume — a disk failure loses both). The backup script
(`scripts/pg-backup.sh`) pushes each fresh dump offsite **automatically when
you set one env var** in `/opt/ccp/.env`, and is a clean no-op when unset (so
nothing is hardcoded and the default deploy stays local-only). Wire ONE of:

```bash
# rclone (any of its 70+ remotes — S3, R2, B2, GDrive, …). One-time:
#   rclone config        # create a remote named e.g. "ccpbackup"
echo 'BACKUP_RCLONE_REMOTE=ccpbackup:ccp-backups' >> /opt/ccp/.env

# …or the aws CLI directly (needs creds in the env / ~/.aws on the VPS):
echo 'BACKUP_S3_BUCKET=s3://my-bucket/ccp-backups' >> /opt/ccp/.env
```

Optional hardening, also via `/opt/ccp/.env`:

```bash
# Encrypt each dump with GPG before upload (offsite copy becomes .sql.gz.gpg).
# Import the public key first: `gpg --import backup-pub.asc`. Leave unset to
# rely on the bucket's own SSE/KMS instead.
echo 'BACKUP_GPG_RECIPIENT=backups@yourco.com' >> /opt/ccp/.env

# Dead-man's switch — a silently-failing nightly backup is the worst kind.
# Create a check at healthchecks.io (free) and paste its ping URL; the script
# pings <url>/start at the top and <url> on success, so a missed ping pages
# you. A failed offsite push fails the script → no success ping → you're paged.
echo 'BACKUP_HEALTHCHECK_URL=https://hc-ping.com/<uuid>' >> /opt/ccp/.env
```

No `&&`-on-the-cron-line edit is needed any more — the offsite leg + ping live
inside `pg-backup.sh`, so they stay in lockstep with every deploy. Install the
`rclone` / `aws` / `gpg` binary the chosen path needs on the VPS once.

# Things to set up later (with trigger conditions)

- **Uptime monitoring** — UptimeRobot or BetterStack on `/api/health`.
  Hostinger sends an email when the VPS reboots; not enough on its own.
  Containers now run with `restart: unless-stopped` (since 2026-05-26) so
  a VPS reboot brings the stack back automatically. External monitoring
  still matters for the case where the container is stuck in a restart
  loop (Docker's policy retries on every crash; an unhealthy boot loop
  needs a human).
- **Docker Hub image scanning** — Hub's built-in scan, or Trivy in CI before push.
- **Centralized log aggregation** — `docker compose logs` is fine for one
  VPS; Loki / CloudWatch / Better Stack become worth it when you can't
  ssh in fast enough to read logs during an incident.
- **Caddy proxy-layer rate limit** — requires `xcaddy build --with
  github.com/mholt/caddy-ratelimit`. Add when a bad client at
  `/webhooks/meta/*` saturates the api process before the in-app guards
  (300/min/user, 60/min/api-key) can catch up.
