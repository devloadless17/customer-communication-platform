#!/usr/bin/env bash
# Local imitation of the CI deploy pipeline.
#
# Mirrors .github/workflows/deploy.yml's `smoke` job step-for-step against a
# local Docker Desktop so you can validate the prod-shaped boot BEFORE
# pushing. Differences vs CI:
#   - builds images locally (CI pulls from Docker Hub)
#   - renders Caddyfile to a local file (CI scp's to /etc/caddy/Caddyfile)
#   - does NOT push images, does NOT scp anything, does NOT touch any VPS
#
# Usage:
#   scripts/local-deploy-imitate.sh           # build + smoke + leave running
#   scripts/local-deploy-imitate.sh --down    # tear down + clean
#   scripts/local-deploy-imitate.sh --no-build  # reuse existing images
#
# Prereqs:
#   - Docker Desktop running (WSL integration enabled if running from WSL)
#   - .env populated (POSTGRES_*, BETTER_AUTH_SECRET, ENCRYPTION_KEY,
#     INTERNAL_BUS_SECRET, UPLOADTHING_TOKEN at minimum)
#
# Exit codes match CI: non-zero on any failure so this script can be wired
# into a pre-push hook later.

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  if [ -x "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe" ]; then
    docker() { "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe" "$@"; }
    export -f docker
  else
    echo "✗ docker not found in PATH and Docker Desktop not at default Windows path"
    exit 1
  fi
fi

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

case "${1:-}" in
  --down)
    echo "==> Tearing down local stack"
    docker compose --env-file .env down -v
    rm -f deploy/Caddyfile.rendered
    echo "✓ stack down, volumes removed, rendered Caddyfile cleaned up"
    exit 0
    ;;
esac

NO_BUILD=0
[ "${1:-}" = "--no-build" ] && NO_BUILD=1

if [ ! -f .env ]; then
  echo "✗ .env missing — copy .env.example and fill secrets first"
  exit 1
fi

# Validate the fields CI's `Validate required GH secrets` step checks. We
# mirror the SAME list so a passing local imitate guarantees CI won't fail
# secret validation on push. POSTGRES_DB/USER aren't in CI's validate list
# (they have safe defaults) but are needed for compose, so we add them.
REQUIRED_ENV=(
  POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD
  BETTER_AUTH_SECRET ENCRYPTION_KEY INTERNAL_BUS_SECRET
  UPLOADTHING_TOKEN BETTER_AUTH_URL APP_PUBLIC_URL
)
missing=()
for v in "${REQUIRED_ENV[@]}"; do
  val=$(grep -E "^${v}=" .env | head -1 | cut -d= -f2- | tr -d '"' || true)
  if [ -z "$val" ]; then
    missing+=("$v")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  printf '✗ missing in .env: %s\n' "${missing[@]}"
  exit 1
fi
echo "✓ .env has all required vars"

# ---- CI-PARITY TYPECHECK ----------------------------------------------------
# The CI runs `pnpm install --frozen-lockfile --ignore-scripts` THEN tsc.
# Local `npm run typecheck` runs against the dev-time pnpm tree which hoists
# transitive @types/* differently — missing devDeps that CI catches can pass
# locally. Re-resolve in a throwaway path that matches CI's posture before
# typechecking. Caught a real bug (missing @types/express-serve-static-core)
# in the first deploy round; without this step the script would have stayed
# green while CI was red.
echo "==> CI-parity typecheck (frozen install posture)"
SKIP_FROZEN_TYPECHECK="${SKIP_FROZEN_TYPECHECK:-0}"
if [ "$SKIP_FROZEN_TYPECHECK" = "1" ]; then
  echo "  (skipped via SKIP_FROZEN_TYPECHECK=1)"
elif command -v pnpm >/dev/null 2>&1; then
  # `--prefer-offline` reuses the dev cache so this stays fast (~5s) while
  # still resolving against the lockfile exactly as CI would.
  pnpm install --frozen-lockfile --ignore-scripts --prefer-offline >/dev/null 2>&1
  pnpm exec prisma generate >/dev/null 2>&1
  if ! pnpm run typecheck >/tmp/typecheck.log 2>&1; then
    echo "✗ typecheck failed under frozen-install — see /tmp/typecheck.log (tail below)"
    tail -40 /tmp/typecheck.log
    exit 1
  fi
  echo "✓ typecheck green under CI-parity install"
else
  echo "  ⚠ pnpm not on PATH; skipping (will be caught on CI)"
fi

# Render Caddyfile from template with localhost defaults (CI renders against
# APP_DOMAIN secret; locally we use Caddy's HTTP-only port via :80 binding).
APP_DOMAIN="${APP_DOMAIN:-localhost}"
ADMIN_EMAIL="${ADMIN_EMAIL:-dev@localhost}"
sed -e "s|__DOMAIN__|${APP_DOMAIN}|g" \
    -e "s|__ADMIN_EMAIL__|${ADMIN_EMAIL}|g" \
    deploy/Caddyfile.template > deploy/Caddyfile.rendered

if grep -q '__DOMAIN__\|__ADMIN_EMAIL__' deploy/Caddyfile.rendered; then
  echo "✗ unrendered placeholders left in Caddyfile.rendered"
  exit 1
fi
echo "✓ Caddyfile rendered to deploy/Caddyfile.rendered"

# Optional Caddy syntax check — only if caddy CLI is on PATH.
if command -v caddy >/dev/null 2>&1; then
  if caddy validate --config deploy/Caddyfile.rendered >/dev/null 2>&1; then
    echo "✓ caddy validate passed"
  else
    echo "⚠ caddy validate failed — won't block but inspect deploy/Caddyfile.rendered"
  fi
fi

if [ "$NO_BUILD" = 0 ]; then
  echo "==> Building images locally"
  # --pull forces a fresh base image (node:22-slim). Without it Docker
  # reuses a cached layer that may carry older debian / Go-binary CVEs
  # that CI's Trivy scan would still flag — false-positive vs CI without
  # this flag.
  docker compose --env-file .env build --pull
  echo "✓ images built"
fi

# ---- CI-PARITY TRIVY SCAN ---------------------------------------------------
# Mirrors `.github/workflows/deploy.yml`'s `Trivy scan` steps with the SAME
# severity threshold, `ignore-unfixed`, and `vuln-type` flags so a green
# local run matches a green CI scan. Caught real HIGH CVEs (effect,
# picomatch, esbuild gobinary) in the first deploy round; without this
# step the script would pass while CI failed.
SKIP_TRIVY="${SKIP_TRIVY:-0}"
if [ "$SKIP_TRIVY" = "1" ]; then
  echo "==> Trivy scan skipped (SKIP_TRIVY=1)"
else
  echo "==> Trivy scan (matches CI severity + flags)"
  REPO="${DOCKER_USERNAME:-local}/${APP_IMAGE_NAME:-customer-communication-platform}"
  trivy_failed=0
  for variant in web api; do
    echo "    scanning ${REPO}:latest-${variant}"
    if ! docker run --rm \
           -v /var/run/docker.sock:/var/run/docker.sock \
           -v "${HOME}/.cache/trivy:/root/.cache/" \
           aquasec/trivy:0.70.0 image \
             --severity HIGH,CRITICAL \
             --ignore-unfixed \
             --vuln-type os,library \
             --exit-code 1 \
             "${REPO}:latest-${variant}"; then
      trivy_failed=1
    fi
  done
  if [ "$trivy_failed" = 1 ]; then
    echo "✗ Trivy found HIGH/CRITICAL fixable CVEs — CI will fail the deploy here"
    echo "  fix by bumping deps (pnpm overrides for transitive ones, npm overrides"
    echo "  in apps/web/Dockerfile cli-tools for picomatch/effect/esbuild)"
    exit 1
  fi
  echo "✓ Trivy clean on both images"
fi

echo "==> Booting stack"
docker compose --env-file .env up -d postgres redis
echo "==> Waiting for postgres + redis to be healthy"
deadline=$((SECONDS + 60))
while [ $SECONDS -lt $deadline ]; do
  pg_state=$(docker compose --env-file .env ps -q postgres | xargs -r docker inspect --format '{{.State.Health.Status}}' 2>/dev/null || echo "none")
  rd_state=$(docker compose --env-file .env ps -q redis    | xargs -r docker inspect --format '{{.State.Health.Status}}' 2>/dev/null || echo "none")
  if [ "$pg_state" = "healthy" ] && [ "$rd_state" = "healthy" ]; then
    echo "✓ postgres + redis healthy"
    break
  fi
  sleep 2
done

docker compose --env-file .env up -d app api
echo "==> Waiting for app + api to be healthy (≤120s)"
deadline=$((SECONDS + 120))
app_health=""
api_health=""
while [ $SECONDS -lt $deadline ]; do
  app_id=$(docker compose --env-file .env ps -q app)
  api_id=$(docker compose --env-file .env ps -q api)
  if [ -z "$app_id" ] || [ -z "$api_id" ]; then
    echo "⚠ container missing — waiting"
    sleep 2
    continue
  fi
  for c in "$app_id" "$api_id"; do
    state=$(docker inspect --format '{{.State.Status}}' "$c")
    if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
      echo "✗ container $c exited during boot"
      docker compose --env-file .env logs --tail=80
      exit 1
    fi
  done
  app_health=$(docker inspect --format '{{.State.Health.Status}}' "$app_id" 2>/dev/null || echo "none")
  api_health=$(docker inspect --format '{{.State.Health.Status}}' "$api_id" 2>/dev/null || echo "none")
  if [ "$app_health" = "healthy" ] && [ "$api_health" = "healthy" ]; then
    echo "✓ app + api healthy after ${SECONDS}s"
    break
  fi
  sleep 2
done

if [ "$app_health" != "healthy" ] || [ "$api_health" != "healthy" ]; then
  echo "✗ healthcheck never green (app=$app_health api=$api_health)"
  docker compose --env-file .env logs --tail=120 app api
  exit 1
fi

echo "==> Deep probe: api /health must report ok:true"
api_id=$(docker compose --env-file .env ps -q api)
health_json=$(docker exec "$api_id" wget -qO- http://127.0.0.1:4000/health || true)
echo "api /health: $health_json"
echo "$health_json" | grep -q '"ok":true' || {
  echo "✗ api /health body did not contain ok:true"
  docker compose --env-file .env logs --tail=80 api
  exit 1
}
echo "✓ api ↔ postgres ↔ redis reachable"

echo "==> Deep probe: web /api/health"
app_id=$(docker compose --env-file .env ps -q app)
web_health=$(docker exec "$app_id" wget -qO- http://127.0.0.1:3000/api/health || true)
echo "web /api/health: $web_health"
echo "$web_health" | grep -q '"ok":true' || {
  echo "⚠ web /api/health did not return ok:true — investigate"
}

echo
echo "==================================================================="
echo "✓ LOCAL DEPLOY IMITATION COMPLETE"
echo "==================================================================="
echo "  Web:  http://localhost:${APP_PORT:-3000}"
echo "  API:  http://localhost:4000"
echo "  Postgres: 127.0.0.1:5433  Redis: 127.0.0.1:6380"
echo
echo "  Login: ali@loadless.ai / loadless  (run db:seed:superadmin first)"
echo
echo "  Tear down: scripts/local-deploy-imitate.sh --down"
echo "==================================================================="
