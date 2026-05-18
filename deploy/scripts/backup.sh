#!/usr/bin/env bash
#
# Daily Postgres backup for the WhatsApp shared-inbox VPS.
#
# Idempotent. Run from cron as the `deploy` user (no sudo needed —
# `docker exec` works via the docker group):
#
#   0 2 * * *  /opt/ccp/scripts/backup.sh >> /var/log/ccp/backup.log 2>&1
#
# Restore (copy the dump locally first, then):
#
#   gunzip -c postgres-2026-05-18_020000.sql.gz | docker exec -i \
#     $(docker compose -f /opt/ccp/docker-compose.yml ps -q postgres) \
#     psql -U app -d ccp
#
# Off-host copy (recommended): pipe stdout to an scp / aws s3 cp / restic
# command. The script keeps a 7-day local rotation; without an off-host
# copy, a VPS-level failure still loses everything.
#
# What this script does NOT do:
#   - Backup Redis. BullMQ jobs are ephemeral — losing them re-fires
#     workflow waits up to 60s late (sweeper recovers). Not worth the
#     storage.
#   - Backup uploaded media. Lives in UploadThing (out-of-band).
#   - Backup secrets (.env). Restore from GitHub Secrets after re-deploy.

set -euo pipefail

readonly COMPOSE_FILE="/opt/ccp/docker-compose.yml"
readonly ENV_FILE="/opt/ccp/.env"
readonly BACKUP_DIR="/var/backups/ccp"
readonly RETENTION_DAYS=7
readonly DATE="$(date -u +%Y-%m-%d_%H%M%S)"
readonly OUT="${BACKUP_DIR}/postgres-${DATE}.sql.gz"

mkdir -p "${BACKUP_DIR}"

# Read POSTGRES_USER + POSTGRES_DB from the deploy env so a future
# rename here doesn't silently fail. Defaults match docker-compose.yml.
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi
readonly DB_USER="${POSTGRES_USER:-app}"
readonly DB_NAME="${POSTGRES_DB:-ccp}"

# Locate the running postgres container by compose service name. Resolving
# via `compose ps` instead of a hardcoded name handles project-prefix and
# version-suffix variations across docker compose minor versions.
pg_container="$(docker compose -f "${COMPOSE_FILE}" ps -q postgres)"
if [[ -z "${pg_container}" ]]; then
  echo "[$(date -u +%FT%TZ)] ERROR: postgres container not running — skipping backup" >&2
  exit 1
fi

echo "[$(date -u +%FT%TZ)] dumping ${DB_NAME} → ${OUT}"

# --clean --if-exists: dump emits DROP statements so restoring into a
# non-empty DB is safe (overwrites). --no-owner / --no-acl: portable
# across DB users — important when restoring into a freshly-provisioned
# Postgres where the owning role doesn't exist yet.
docker exec "${pg_container}" \
  pg_dump \
    --username="${DB_USER}" \
    --dbname="${DB_NAME}" \
    --format=plain \
    --no-owner \
    --no-acl \
    --clean \
    --if-exists \
  | gzip > "${OUT}.tmp"

# Atomic rename so a partial dump (disk full, container killed mid-stream)
# doesn't replace a successful prior backup with an empty file. cron
# retries tomorrow, prior backup still recoverable.
mv "${OUT}.tmp" "${OUT}"
chmod 600 "${OUT}"

# Rotate. -mtime +N catches files modified MORE than N days ago — N=7
# keeps the last 7 dailies. Use -delete (not rm -rf) so a malformed
# variable here can't blow away the whole disk.
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'postgres-*.sql.gz' \
  -mtime "+${RETENTION_DAYS}" -delete

size_human="$(du -h "${OUT}" | cut -f1)"
remaining="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'postgres-*.sql.gz' | wc -l)"
echo "[$(date -u +%FT%TZ)] ok — ${size_human}, ${remaining} dump(s) retained"
