# Local setup & environments (dev / Docker / prod)

The toolchain is bleeding-edge but **internally consistent** (verified 2026-05-22:
`pnpm install --frozen-lockfile` clean, no peer warnings, cold typecheck green):
Next 16 · React 19.2 · Nest 11 · Prisma 7 · TypeScript 6 · zod 4 · node 24 · pnpm 10.

Most "it works on dev but not Docker / it broke after I upgraded" pain comes from a
handful of **env + cwd rules**, not version conflicts. They're below.

## pnpm-only — never npm

This is a pnpm workspace (`packageManager: pnpm@10.33.3`, `workspace:*` deps, single
`pnpm-lock.yaml`). **`npm install` errors** (`Unsupported URL Type "workspace:"`).

```bash
corepack enable     # once — auto-selects the pinned pnpm
pnpm install        # NEVER npm install
```
`npm run <script>` happens to work (it just execs), but use `pnpm` for everything.

## Fresh clone, in order

```bash
cp .env.example .env          # Prisma 7 + the web render worker both need a real .env
corepack enable
pnpm install                  # postinstall runs `prisma generate`
pnpm db:migrate               # from repo ROOT only (see Prisma note)
pnpm dev                      # web :3000 + api :4000 (turbo --parallel)
```

## The three traps (and why)

1. **"`.env` must be in apps/web" / `SASL: client password must be a string`.**
   Next 16 runs route handlers in a *separate render worker* that reads
   `apps/web/.env`, not the repo root. Two mechanisms feed it the single root `.env`:
   `next.config.ts`'s `loadEnvConfig` (main process) **and** the gitignored symlink
   `apps/web/.env -> ../../.env` that the `dev`/`start` scripts create. **Always launch
   web via `pnpm dev` / `pnpm web:dev`, never bare `next dev`** — otherwise the symlink
   is missing and every Prisma query fails. A fresh clone needs one script run to create it.

2. **Prisma "config" / connection errors.** Prisma 7 + `prisma.config.ts` **stops
   auto-loading `.env`**; the config loads it via `process.loadEnvFile(".env")`
   **relative to cwd**. So **run Prisma only from the repo root** (`pnpm db:migrate`,
   `pnpm db:studio`, `pnpm db:reset`). From a subdirectory it can't find `.env`, falls
   back to a placeholder `DATABASE_URL`, and connection fails. (The placeholder exists
   so `pnpm install`'s `prisma generate` works before `.env` is copied.)

3. **"Sometimes tsconfig errors" after an upgrade.** Stale incremental caches
   (`*.tsbuildinfo`, `.next`, `.turbo`) from the previous TS/Next version. After any
   major bump:
   ```bash
   rm -rf apps/web/.next .turbo apps/api/dist node_modules/.cache
   find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete
   pnpm install
   ```

## Workspace package resolution

- `@ccp/shared` resolves via tsconfig `paths` (`@ccp/shared/* -> packages/shared/src/*`);
  `@ccp/config` via its `exports` map (web) / tsconfig path (api). All static imports work.
- **Sharp edge:** a *dynamic* `import()` of a `@ccp/shared` subpath **not listed in
  `packages/shared/package.json#exports`** throws `ERR_PACKAGE_PATH_NOT_EXPORTED` at
  runtime. Use static imports for shared subpaths, or add the subpath to `exports`.
- A new `@ccp/*` import must be added to that app's `package.json` (`workspace:*`).

## URL / env matrix

**Golden rule:** `NEXT_PUBLIC_API_URL` and `INTERNAL_API_URL` are **baked into the web
image at `next build`** — Next inlines `NEXT_PUBLIC_*` and bakes rewrites into the
route manifest. In Docker/prod they MUST be passed as **build args** (compose already
does). Setting them only at runtime does nothing for the browser/proxy — that's the
"infinity-refreshing / ECONNREFUSED" class of bug.

| | **Dev (host)** | **Docker (`pnpm prod:local`)** | **Prod (VPS)** |
|---|---|---|---|
| Run | `pnpm dev` (web+api on host; DB/Redis in Docker) | `docker compose up --build` | systemd + Caddy front |
| DB / Redis | `localhost:5433` / `localhost:6380` | `postgres:5432` / `redis:6379` | same (compose net) |
| Browser → api | same-origin `:3000`; `/api/*` → `127.0.0.1:4000` via next.config rewrite; socket → `NEXT_PUBLIC_API_URL` (`http://localhost:4000`) | via baked build args | Caddy routes `/api/*`,`/socket.io/*` → api; `NEXT_PUBLIC_API_URL` = public origin |
| RSC → api (`INTERNAL_API_URL`) | `http://127.0.0.1:4000` (next.config fallback) | `http://api:4000` (build arg + runtime) | `http://api:4000` |
| api → web (`WEB_INTERNAL_URL`) | `http://app:3000` default † | `http://app:3000` | `http://app:3000` |
| `BETTER_AUTH_URL` | `http://localhost:3000` | from env | `https://<public host>` — must match exactly |

† Doesn't resolve on the host, but harmless in dev (RSC isn't cached). If revalidate
fetch-errors clutter dev logs, add `WEB_INTERNAL_URL=http://localhost:3000` to `.env`.

## Command cheat-sheet

```
Install        pnpm install              (never npm)
Dev (both)     pnpm dev                  (web :3000 + api :4000)
Dev (split)    pnpm web:dev / pnpm api:dev   (separate-terminal logs; web:dev makes the .env symlink)
Typecheck      pnpm typecheck            (turbo: web + api; add --force after a schema/prisma change)
DB             pnpm db:migrate | db:studio | db:reset   (repo ROOT only)
Local prod     pnpm prod:local           (full Docker stack, mirrors VPS)
After upgrade  clear caches (trap #3) then pnpm install
```
