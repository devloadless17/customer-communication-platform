# Deploy

Production deployment is **fully driven by CI/CD**. Pushing to `main` runs
`.github/workflows/deploy.yml` which:

- rsyncs the repo to `/opt/ccp/` on the VPS
- renders `/etc/ccp.env` from GitHub Secrets
- renders `/etc/caddy/Caddyfile` from `deploy/Caddyfile.template`
- installs/refreshes `/etc/systemd/system/ccp.service`
- builds the app Docker image (old containers keep serving)
- restarts `ccp.service` + reloads Caddy
- polls `https://central.loadless.site/api/health` end-to-end

Every step is idempotent — the workflow doubles as the first-time provisioner.

## Topology

```
   GitHub                                Hostinger KVM2 (Ubuntu)
   ┌────────────────┐                    ┌─────────────────────────────────┐
   │ main branch    │  push              │  Caddy (host) :443 (HTTPS)      │
   │   ↓            │ ─────────────────► │   ↓                             │
   │ deploy.yml     │  rsync + scp +     │  app    :3000 (Next + Socket.io)│
   │   ↓            │  ssh restart       │   ↓                             │
   │ /api/health    │                    │  postgres :5432                 │
   │   verify       │                    │  redis    :6379                 │
   └────────────────┘                    └─────────────────────────────────┘
                                                    central.loadless.site
                                                    187.77.180.44
```

## Branch + deploy model

| Branch | Purpose | Trigger |
|---|---|---|
| `main` | Production. `central.loadless.site` always tracks the latest commit. | Push → `.github/workflows/deploy.yml` |
| `dev` | Integration. Feature branches PR into here. | Push → CI checks only (no deploy) |
| `feat/*` | Feature work. | PR to `dev` → CI checks |

Release flow: PR `dev` → `main` → automatic deploy.

---

# Manual setup — one-time, ~10 minutes

There are exactly **three** things you do by hand. Everything else is in CI/CD.

## 1. Generate the deploy SSH key

On your dev machine:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ccp_deploy -C "gha-deploy-ccp" -N ""
cat ~/.ssh/ccp_deploy.pub          # the PUBLIC half — copy this
```

Then on the VPS (as root, one time):

```bash
mkdir -p /root/.ssh
chmod 700 /root/.ssh
echo "ssh-ed25519 AAAA…REPLACE_WITH_YOUR_PUBLIC_KEY… gha-deploy-ccp" \
  >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
```

> Heads-up: this key has root shell access on the VPS. The deploy workflow
> needs to install systemd units and write `/etc/ccp.env`, so a
> command-restricted key won't work for full provisioning. If the GitHub
> repo or the `VPS_SSH_KEY` secret ever leaks, treat it as a VPS
> compromise — rotate the key on the VPS first.

## 2. Add GitHub Secrets

GitHub → repo Settings → **Secrets and variables** → **Actions** → **New repository secret**:

| Name | Value | Notes |
|---|---|---|
| `VPS_HOST` | `central.loadless.site` | Or `187.77.180.44` if you'd rather skip DNS for SSH |
| `VPS_USER` | `root` | |
| `VPS_SSH_KEY` | **entire contents of `~/.ssh/ccp_deploy`** (the private half) | Paste from `-----BEGIN OPENSSH PRIVATE KEY-----` through the trailing `-----END` line |
| `HEALTHCHECK_URL` | `https://central.loadless.site/api/health` | What the workflow polls to verify the deploy |
| `APP_DOMAIN` | `central.loadless.site` | Used in Caddyfile + NEXTAUTH_URL + APP_PUBLIC_URL |
| `ADMIN_EMAIL` | your email | Let's Encrypt expiry warnings land here. Use a real inbox. |
| `POSTGRES_DB` | `ccp` | DB name. Leave as `ccp` unless you have a reason. |
| `POSTGRES_USER` | `app` | DB user. Leave as `app` unless you have a reason. |
| `POSTGRES_PASSWORD` | **strong random** | Generate with `openssl rand -hex 32` and save it somewhere safe (1Password). Used by both the postgres container and the app. |
| `NEXTAUTH_SECRET` | **strong random** | Generate with `openssl rand -base64 32`. Reused as `AUTH_SECRET` too. Rotating it logs all users out. |
| `UPLOADTHING_TOKEN` | from the UploadThing dashboard | Blob storage for media. |

## 3. Push to main

That's it. Push to `main`, watch the Actions tab, the workflow does the rest.

---

# Local development

Two modes, by intent:

## Fast iteration (95% of the time)

```bash
docker compose up -d postgres redis     # backing services only
npm install
npm run db:migrate                       # apply migrations to local postgres
npm run db:seed                          # demo data (dev-only)
npm run dev                              # tsx watch + Next dev
```

App at `http://localhost:3000`. Code edits hot-reload. NOT a prod mirror —
NODE_ENV=development, no Caddy, no production build.

## Production mirror (before merging to main)

```bash
npm run prod:local                       # docker compose up --build
```

Runs the EXACT same stack production runs: same Dockerfile, same Postgres 16.6,
same Redis 7.4, same env shape (loaded from `.env`), same `npx prisma migrate
deploy` on container start.

| | Local | Production |
|---|---|---|
| Reverse proxy | None — hit `http://localhost:3000` directly | Caddy with HTTPS |
| Domain | `localhost` | `central.loadless.site` |
| Restart policy | docker | systemd |
| Secrets file | `.env` in repo (gitignored) | `/etc/ccp.env` (CI-rendered from secrets) |

If something works locally with `prod:local` but fails on the VPS, the diff is
in one of those four rows.

```bash
npm run prod:local:logs       # follow app logs
npm run prod:local:down       # stop containers, keep volumes
npm run prod:local:nuke       # stop containers + drop volumes (clean slate)
```

---

# Deploying day-to-day

```bash
git checkout dev
# … work …
git push origin dev                      # CI checks only
# Open PR dev → main on GitHub, merge it.
# deploy.yml fires automatically.
```

Manual redeploy (after rotating a secret, etc.): GitHub → Actions → Deploy →
"Run workflow" → main.

Emergency manual deploy (e.g. GitHub Actions is down): SSH in and replicate
what the workflow does. There's no shortcut script — the workflow IS the
source of truth.

```bash
ssh root@central.loadless.site

# Pull latest manually
cd /opt/ccp && git pull   # only works if you bootstrap a git remote here
                          # — usually easier to wait for GitHub to come back

# Or rebuild from whatever's already on disk
docker compose --env-file /etc/ccp.env -f /opt/ccp/docker-compose.yml build --pull app
systemctl restart ccp
systemctl reload caddy
journalctl -u ccp -f
```

# Editing what gets deployed

| Want to change | Edit this | Effect |
|---|---|---|
| Domain / admin email | A GitHub Secret (`APP_DOMAIN`, `ADMIN_EMAIL`) | Next deploy re-renders Caddyfile + env |
| Caddy config (headers, routes, etc.) | [deploy/Caddyfile.template](Caddyfile.template) | Next deploy ships new Caddyfile |
| Systemd unit | [deploy/ccp.service](ccp.service) | Next deploy reinstalls + daemon-reload |
| App env that isn't in secrets | `.github/workflows/deploy.yml` "Render production .env" step | Next deploy ships new env file |
| App code | Just push | Next deploy rebuilds + restarts |
| Postgres / Redis image version | [docker-compose.yml](../docker-compose.yml) | Next deploy rebuilds — verify locally first via `npm run prod:local` |

**Never** edit `/etc/ccp.env`, `/etc/caddy/Caddyfile`, or `/etc/systemd/system/ccp.service`
on the VPS directly. The next deploy overwrites all three from git + secrets.

# Bumping image versions

`docker-compose.yml` pins Postgres + Redis to specific minor versions. To
bump on a planned cadence:

1. Read upstream release notes (security CVEs especially).
2. Edit the `image:` line in `docker-compose.yml`.
3. `npm run prod:local` — verify nothing broke locally.
4. PR `dev` → `main`, merge.

# Rollback

`git revert` the offending commit on `main` and push — the deploy workflow
rebuilds and rolls the VPS back. Database migrations do NOT auto-revert; if a
migration broke prod, fix forward (a new migration that undoes the bad one)
rather than running `prisma migrate reset` on production.

# Things to set up later (with trigger conditions)

- **Database backups** — Hostinger panel snapshots + a `pg_dump` cron. Worth
  doing before the first real customer hits the pilot.
- **Uptime monitoring** — UptimeRobot or BetterStack pinging `/api/health`
  every 5 min, paging on 503. Free tier covers this.
- **Log rotation** — `journalctl --vacuum-size=500M` cron weekly. Caddy
  already rotates via `roll_size` in the Caddyfile.
- **CDN in front of Caddy** — Cloudflare (free tier). Only useful once you
  have international traffic.
- **Restrict the deploy SSH key** — once the bootstrap is settled and the
  manual provisioning steps stop changing, switch the key to a
  `command="/usr/local/bin/ccp-deploy.sh"` forced-command in
  `/root/.ssh/authorized_keys`. The wrapper script becomes the only thing
  the leaked key can do; rsync + scp inside the workflow then need a
  different shape (typically: a single tarball delivery + extract on the
  VPS). Worth doing once the pilot has real users.
