# Deploy

**Pattern: build in CI, pull from Docker Hub on the VPS.** The VPS holds no
source code — only config files.

Every deploy is one workflow (`.github/workflows/deploy.yml`):

1. `typecheck` job — `npm ci`, `prisma generate`, `tsc --noEmit`. Runs on every push and PR.
2. `deploy` job — runs only on push to `main` (or manual `workflow_dispatch`). Needs typecheck to pass.
   - builds the Docker image
   - tags it `${DOCKER_USERNAME}/customer-communication-platform:sha-<commit>` and `:latest`
   - pushes to Docker Hub
   - SSHes to the VPS and writes/refreshes 4 config files
   - `docker compose pull && systemctl restart ccp && systemctl reload caddy`
   - polls `/api/health` end-to-end

## Topology

```
   Docker Hub                              Hostinger KVM2 (Ubuntu, as root)
   ┌────────────────────────┐              ┌─────────────────────────────────┐
   │ <docker_username>/     │              │  Caddy (host) :443 (HTTPS)      │
   │   customer-communica…  │              │   ↓                             │
   │   :sha-<commit>        │   ──pull──►  │  app    :3000  ← from Docker Hub│
   │   :latest              │              │   ↓                             │
   └────────────────────────┘              │  postgres :5432                 │
                                           │  redis    :6379                 │
                                           └─────────────────────────────────┘
                                                    central.loadless.site
                                                    187.77.180.44
```

## What lives on the VPS

That's it. Four files.

```
/root/docker-compose.yml      ← shipped verbatim from ./docker-compose.yml
/root/.env                    ← rendered by the workflow from GitHub Secrets
/etc/caddy/Caddyfile          ← rendered from deploy/Caddyfile.template
/etc/systemd/system/ccp.service  ← copied from deploy/ccp.service
```

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

## 1. Install docker + caddy + ufw on the VPS (done already)

```bash
apt-get install -y docker.io docker-compose-plugin caddy ufw
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
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

## 3. SSH key for GitHub Actions (already done earlier in this project)

```bash
# On your dev machine
ssh-keygen -t ed25519 -f ~/.ssh/ccp_deploy_v2 -N "" -C "gha-deploy-ccp"
# Public key already in /root/.ssh/authorized_keys on the VPS.
# Private key goes into GitHub Secret VPS_SSH_KEY.
```

## 4. GitHub Secrets — full list

```bash
gh secret list --repo devloadless17/customer-communication-platform
```

Should show all of:

```
VPS_HOST           central.loadless.site (or 187.77.180.44)
VPS_USER           root
VPS_SSH_KEY         (private OpenSSH key, full contents incl. BEGIN/END)
HEALTHCHECK_URL       https://central.loadless.site/api/health

DOCKER_USERNAME       (your Docker Hub username)
DOCKER_PASSWORD       (Docker Hub PAT from step 2)

APP_DOMAIN            central.loadless.site
ADMIN_EMAIL           your.real.email@example.com

POSTGRES_DB           ccp
POSTGRES_USER         app
POSTGRES_PASSWORD     (openssl rand -hex 32)
NEXTAUTH_SECRET       (openssl rand -base64 32)
UPLOADTHING_TOKEN     (from UploadThing dashboard)

SUPER_ADMIN_EMAIL     you@loadless.ai
SUPER_ADMIN_PASSWORD  (strong password — bcrypt-hashed at container start)
SUPER_ADMIN_NAME      (optional — display name, defaults to email's local part)
```

15 required + 1 optional. The `SUPER_ADMIN_*` secrets are the source of
truth for the platform-root login. `prisma/bootstrap-admin.ts` runs on
every container start (between `prisma migrate deploy` and the server)
and upserts that user with the hashed password. **Rotating the password
in GitHub Secrets and redeploying rotates the live password** — predictable
but it also means changing the password from inside the UI will be reset
on the next deploy. Acceptable trade-off for declarative secrets.

### One-shot to set them all (after you have the values)

```bash
REPO=devloadless17/customer-communication-platform

# Server / SSH
gh secret set VPS_HOST       --repo "$REPO" --body "central.loadless.site"
gh secret set VPS_USER       --repo "$REPO" --body "root"
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
gh secret set NEXTAUTH_SECRET   --repo "$REPO" --body "$(openssl rand -base64 32)"

# Blob storage
gh secret set UPLOADTHING_TOKEN --repo "$REPO" --body "<your-uploadthing-token>"

# SuperAdmin bootstrap (auto-upserted by prisma/bootstrap-admin.ts on every deploy)
gh secret set SUPER_ADMIN_EMAIL    --repo "$REPO" --body "you@loadless.ai"
gh secret set SUPER_ADMIN_PASSWORD --repo "$REPO" --body "$(openssl rand -base64 24)"
gh secret set SUPER_ADMIN_NAME     --repo "$REPO" --body "Your Name"   # optional

# Clean up the GHCR pull token if you set it for the previous iteration —
# no longer used now that we pull from Docker Hub.
gh secret delete GHCR_PULL_TOKEN --repo "$REPO" 2>/dev/null || true
```

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
ssh root@central.loadless.site
docker login -u <docker-username>             # interactive password prompt
docker compose -f /root/docker-compose.yml --env-file /root/.env pull app
systemctl restart ccp
systemctl reload caddy
journalctl -u ccp -f
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
and runs it. In production, the workflow ships the same file to `/root/docker-compose.yml`
and the VPS pulls the prebuilt image instead of building.

| | Local (`prod:local`) | Production |
|---|---|---|
| Compose file | `./docker-compose.yml` (run with `--build`) | `/root/docker-compose.yml` (shipped from this same file) |
| Image source | Built from your working tree | Pulled from Docker Hub |
| Reverse proxy | None — hit `http://localhost:3000` | Caddy with HTTPS |
| Secrets file | `.env` in repo (gitignored) | `/root/.env` (workflow-rendered) |

If `prod:local` works but the VPS deploy fails, the diff is in one of
those four rows.

---

# Rolling back

`git revert` the offending commit on `main` and push — the deploy workflow
rebuilds + redeploys.

For a faster rollback to a previously-known-good image (no rebuild required):
SSH in and edit `APP_IMAGE_TAG` in `/root/.env` to the older SHA, then
`docker compose pull && systemctl restart ccp`. List previous images at
https://hub.docker.com/r/<your-username>/customer-communication-platform/tags
(or via `docker search`).

Database migrations do NOT auto-revert — fix forward.

# Bumping image versions for Postgres / Redis

`docker-compose.yml` pins both. To bump:

1. Edit the `image:` line for `postgres` or `redis` in `docker-compose.yml`.
2. `npm run prod:local` — verify nothing broke.
3. Open a PR to `main`, merge.

# Security note: root deploy

You opted to run as `root` on the VPS rather than create a dedicated `ccp`
user. Trade-off: a leaked `VPS_SSH_KEY` is full VPS compromise instead of
"can only restart the app service". Accept now for solo pilot ease; revisit
when you have collaborators or real customer data.

# Things to set up later (with trigger conditions)

- **Database backups** — Hostinger snapshots + a daily `pg_dump | gzip` cron.
- **Uptime monitoring** — UptimeRobot or BetterStack on `/api/health`.
- **Docker Hub image scanning** — Hub's built-in scan, or Trivy in CI before push.
- **Image tag cleanup** — Docker Hub keeps tags forever. Set a retention
  policy or write a monthly cron that prunes `sha-*` tags older than N days
  via Hub's API.
