# Launch checklist

> Written 2026-07-23, before the first real-client launch. The steps are ordered
> so each one fails *cheaply* — config before deploy, deploy before traffic.

---

## Pre-launch security audit (2026-07-23)

A full audit of the Team→Workspace tenancy restructure found and fixed **8
defects** before launch — 2 CRITICAL, 1 HIGH, 5 MED/LOW. The two that would have
bitten on day one:

- **Cross-org access via the `ccp.ws` cookie** — any org owner could set the
  cookie to another tenant's workspace and act as its admin. Fixed: the
  workspace is now verified to belong to the caller's org.
- **Fresh Meta onboarding left a placeholder as the default account** — inbound
  webhooks 403'd and default sends failed. Fixed: `normalizeDefaultAccount`
  cleans the placeholder and promotes the real number on connect.

Plus a HIGH that 500'd every directory role change (`User.role` was removed in
the restructure). All fixed, regression-tested, and covered by the battery
below. Detail in `restructure-security-audit` (memory).

## 0. Before you push

- [ ] **Commit the working tree.** Everything below assumes the code is on
      `main` first. `git status` should be clean.
- [ ] **`pnpm typecheck && pnpm run check:prisma-fields`** — both are CI gates,
      so failing here just means failing slower.

## 1. VPS environment

The compose file uses an **explicit allowlist** (`environment:` with named
keys), not `env_file`, so a local `.env` cannot leak dev flags into production.
Four flags nonetheless make the API **refuse to boot** in prod, by design:

| Flag | Must be | If wrong |
|---|---|---|
| `META_WEBHOOK_INSECURE_SKIP_VERIFY` | unset or `0` | fatal on boot |
| `ENABLE_DEV_TOOLS` | unset or `0` | fatal on boot |
| `INTEGRATIONS_ALLOW_PRIVATE_HOSTS` | unset or `0` | fatal on boot |
| `RUN_WORKER_INLINE` | `1` (default) | fatal on boot |

- [ ] On the VPS, check the `.env` used for compose interpolation carries **none
      of the first three set to `1`**. Refusing to boot is the safe direction,
      but it is still a failed deploy at the worst moment.
- [ ] Required secrets are non-empty: `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`,
      `R2_*`, `APP_PUBLIC_URL`, `BETTER_AUTH_URL`. CI validates these, but only
      on the deploy job.

> `ENCRYPTION_KEY` is load-bearing and **not rotatable in place** — every
> `ChannelConnection.secrets` is envelope-encrypted with it. Changing it orphans
> every channel credential.

## 2. Deploy

Deploys fire **only on push to `production`**. A push to `main` runs typecheck +
lint and deploys nothing.

- [ ] `git push origin main` (integration), then fast-forward `production`.
- [ ] Watch the run: `gh run watch`. Trust `gh run view --json conclusion`, not
      the live log.
- [ ] The api container runs `prisma migrate deploy` before serving. **Three new
      migrations** land on this deploy, all additive — two `CREATE TABLE`, one
      nullable `ADD COLUMN`, three `CREATE INDEX`. No destructive statements, no
      backfill, no downtime expected.

> One caveat worth knowing: the two `BroadcastRecipient` indexes are plain
> `CREATE INDEX` (Prisma runs migrations in a transaction, so `CONCURRENTLY`
> isn't available). That takes a brief write lock on that table. Today it is
> effectively empty, so it is instant — but do this deploy *before* you run a
> large campaign, not during one.

## 3. First-traffic checks

- [ ] `/health` is 200 and `/` renders (CI health-checks both, but look).
- [ ] Send one inbound WhatsApp message to the connected number → it appears in
      the inbox live, without a refresh.
- [ ] Reply → it sends, and the status ticks through sent → delivered.
- [ ] Open **Settings → WhatsApp** → the *Messaging health* panel shows a tier
      and quality rating. If it says "No snapshot yet", press **Refresh**.

## 4. Known-and-accepted states on day one

These are correct, not bugs — but they look like gaps if you don't expect them:

- **Views section is empty.** Saved views are opt-in; the six built-in presets
  (Active / All / Mine / Unassigned / Closed / Flagged) cover the basics.
- **Meta analytics says "Nothing fetched yet".** Template analytics need a
  **one-time, irreversible** opt-in per WABA (Settings → WhatsApp). Until you
  enable it, Meta reports nothing and the panel says so.
- **Business portfolio: "Not resolved".** The connected token lacks
  `business_management`. Everything works; only the portfolio *id* is unknown,
  and the 24h cap falls back to the number's own tier.
- **`BROADCAST_RATE_LIMITER_ENABLED=0`.** The per-number send-rate bucket ships
  **dark**. Today's per-lane pacing is unchanged. See §5.

## 5. After launch — in this order

1. **Run one small template broadcast** and read the campaign report's
   *Delivery over time* curve. That is the measurement everything else waits on.
2. **Then** flip `BROADCAST_RATE_LIMITER_ENABLED=1` and run another. Compare
   achieved msg/s against the target for your throughput level (75 STANDARD /
   900 HIGH), and check the inbox stayed responsive during the send.
3. **Only then** consider the dedicated broadcast worker container (Part 2
   Phase 3). Its trigger is *10k+ recipient campaigns*; at TIER_250 the
   in-process runner is not close to stressed, and shipping a second container
   before the measurement would be adding a failure mode to solve a problem you
   have not yet observed. See `docs/campaign-analytics.md` §9.

## 6. If something breaks

| Symptom | Look at |
|---|---|
| No inbound messages | Meta → WhatsApp → Configuration: is the `messages` field subscribed? Then check the api log for `bad_signature` |
| Replies fail, inbound fine | `needsReconnect` on the channel — the token expired. Settings → WhatsApp → Update credentials |
| Broadcast refused before sending | 24h budget exhausted — Settings → WhatsApp → Messaging health |
| A page 500s | api log; the error carries the `X-Request-Id` from the response header |

Rollback is a redeploy of the previous image tag; the migrations are additive so
the old code runs fine against the new schema.
