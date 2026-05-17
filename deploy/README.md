# Deploy

**Pattern: build in CI, pull from Docker Hub on the VPS.** The VPS holds no
source code — only config files.

Every deploy is one workflow (`.github/workflows/deploy.yml`):

1. `typecheck` job — `npm ci`, `prisma generate`, `tsc --noEmit`. Runs on every push and PR.
2. `deploy` job — runs only on push to `main` (or manual `workflow_dispatch`). Needs typecheck to pass.
   - retags the current `:latest` as `:previous` on Docker Hub (manifest-only copy, free)
   - builds the new image and pushes it as `:latest`
   - SSHes to the VPS and writes/refreshes 4 config files
   - `docker compose pull && systemctl restart ccp && systemctl reload caddy`
   - polls `/api/health` end-to-end

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

Four files, split between the `deploy` user's app dir and system locations.

```
/opt/ccp/docker-compose.yml   ← owned by deploy, shipped from ./docker-compose.yml
/opt/ccp/.env                 ← owned by deploy (mode 600), rendered from GitHub Secrets
/etc/caddy/Caddyfile          ← owned by root, rendered from deploy/Caddyfile.template
/etc/systemd/system/ccp.service  ← owned by root, copied from deploy/ccp.service
```

The systemd unit runs as `User=deploy` so its `docker compose` calls share
the deploy user's `docker login` credentials. The two `/etc/...` files are
written by the workflow via `sudo`.

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
manually by running `prisma/seed-superadmin.ts` once after the first deploy.
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

Credentials are hardcoded in `prisma/seed-superadmin.ts` (currently
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
docker login -u <docker-username>             # interactive password prompt
docker compose -f /opt/ccp/docker-compose.yml --env-file /opt/ccp/.env pull app
sudo systemctl restart ccp
sudo systemctl reload caddy
sudo journalctl -u ccp -f
```

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

Every deploy retags the prior `:latest` as `:previous` on Docker Hub
(manifest-only copy, no layer transfer, no extra storage). To roll back
one step: promote `:previous` back to `:latest`, then pull + restart.

From your dev machine (one-shot):

```bash
REPO=<docker-username>/customer-communication-platform
docker buildx imagetools create --tag $REPO:latest $REPO:previous

ssh deploy@central.loadless.site '
  docker compose -f /opt/ccp/docker-compose.yml --env-file /opt/ccp/.env pull app
  sudo systemctl restart ccp
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

# Security note: deploy user + sudo

The workflow SSHes as `deploy`, which is in the `docker` group and has
passwordless sudo (`NOPASSWD: ALL` in `/etc/sudoers.d/deploy`). The
systemd unit runs as `deploy` too. Trade-off: a leaked `VPS_SSH_KEY`
still gets full root via the NOPASSWD sudo — the real protection here
is the SSH key, not the sudo restriction.

If you ever add collaborators with deploy-user access, replace
`NOPASSWD: ALL` with an allowlist:

```
deploy ALL=(root) NOPASSWD: /usr/bin/mv, /usr/bin/mkdir, /usr/bin/chown, /usr/bin/caddy, /usr/bin/systemctl
```

The workflow only needs those five binaries with sudo.

# Things to set up later (with trigger conditions)

- **Database backups** — Hostinger snapshots + a daily `pg_dump | gzip` cron.
- **Uptime monitoring** — UptimeRobot or BetterStack on `/api/health`.
- **Docker Hub image scanning** — Hub's built-in scan, or Trivy in CI before push.
