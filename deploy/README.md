# Deploy

**Pattern: build in CI, pull from Docker Hub on the VPS.** The VPS holds no
source code — only config files.

Every deploy is one workflow (`.github/workflows/deploy.yml`):

1. `typecheck` job — `npm ci`, `prisma generate`, `tsc --noEmit`. Runs on every push and PR.
2. `deploy` job — runs only on push to `main` (or manual `workflow_dispatch`). Needs typecheck to pass.
   - retags the current `:latest` as `:previous` on Docker Hub (manifest-only copy, free)
   - builds the new image and pushes it as `:latest`
   - SSHes to the VPS and writes/refreshes the config files
   - `docker compose pull && docker compose up -d --remove-orphans && docker image prune -f && systemctl reload caddy`
   - polls `/api/health` end-to-end

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

- `/api/auth/change-password*` and `/api/*`, `/webhooks/*`, `/socket.io/*` → api (NestJS)
- everything else (`/`, `/_next/*`, `/api/auth/*`, `/api/health`, `/api/webhooks/meta/*`) → web (Next.js)

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
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
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
UPLOADTHING_TOKEN     (from UploadThing dashboard)
```

12 secrets. The superAdmin login is **not** in GitHub Secrets — it's seeded
manually by running `prisma/seeds/seed-superadmin.ts` once after the first deploy.
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

# Blob storage
gh secret set UPLOADTHING_TOKEN --repo "$REPO" --body "<your-uploadthing-token>"
```

## First-time superAdmin seed

The superAdmin is **not** bootstrapped automatically — run it once after
the first deploy on a fresh DB:

```bash
ssh deploy@central.loadless.site
docker exec -it $(docker ps -q --filter "name=app") npm run db:seed:superadmin
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
npm install
npm run db:migrate
npm run db:seed
npm run dev                              # tsx watch + Next dev
```

App at `http://localhost:3000`. NOT a prod mirror — uses npm directly, no
Docker for the app.

## Production mirror (before merging to main)

```bash
npm run prod:local                       # docker compose up --build
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

## Fast rollback (~30s) — `:previous` swap

Every deploy retags the prior `:latest-{web,api}` as `:previous-{web,api}`
on Docker Hub (manifest-only copy, no layer transfer, no extra storage). To
roll back one step: promote `:previous-*` back to `:latest-*`, then pull +
recreate. (The deploy workflow's auto-rollback does this for you when a
post-deploy health check fails — this is the manual equivalent.)

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
2. `npm run prod:local` — verify nothing broke.
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
# bunching with everyone else's 3:00 jobs). Stdout/stderr → syslog via logger,
# so failures surface in `journalctl -t ccp-backup`.
( crontab -l 2>/dev/null; echo '17 3 * * * cd /opt/ccp && ./pg-backup.sh 2>&1 | logger -t ccp-backup' ) | crontab -
```

**Restore** (the only step that matters — practice it once before you need it):

```bash
# Pick the dump file you want.
ls /opt/ccp/backups/

# Stop the app so nothing writes during restore, but keep postgres up.
docker compose stop web api

# Restore into the running postgres. --clean --if-exists in the dump means
# the file already DROPs existing objects, so this is a full overwrite.
gunzip -c /opt/ccp/backups/ccp-20260526T031700Z.sql.gz \
  | docker compose exec -T postgres psql -U app -d ccp

# Bring the app back.
docker compose start api web
```

**Offsite copy** (recommended; the on-VPS backups don't survive a disk
failure). Two simple options:

- `rclone copy /opt/ccp/backups remote:bucket/ccp-backups --max-age 24h` after
  the cron job. Add an `&&` to the cron line.
- For S3/R2/Backblaze: `aws s3 sync /opt/ccp/backups s3://bucket/ccp-backups
  --delete` (requires `aws` CLI on the VPS and an IAM key in `/opt/ccp/.env`).

Either path: the dump is plain SQL and gzip-compressed; encrypt at rest with
the bucket's KMS / SSE setting, or pipe through `gpg -c` before upload if the
target bucket isn't encrypted.

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
