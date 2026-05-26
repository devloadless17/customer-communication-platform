#!/usr/bin/env bash
# Nightly Postgres backup. Runs `pg_dump` inside the postgres container,
# gzips to /opt/ccp/backups, retains 14 days. Run from /opt/ccp as the
# `deploy` user via cron — see deploy/README.md "Backups".
#
# Restore: gunzip -c /opt/ccp/backups/<file>.sql.gz | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
set -euo pipefail

cd /opt/ccp

# .env on the VPS holds POSTGRES_USER / POSTGRES_DB. Defaults match compose.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${POSTGRES_USER:=app}"
: "${POSTGRES_DB:=ccp}"

DIR=/opt/ccp/backups
mkdir -p "$DIR"
chmod 700 "$DIR"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/${POSTGRES_DB}-${STAMP}.sql.gz"

# pg_dump custom-format-then-plain would be smaller, but a plain dump
# restores with `psql` alone — no pg_restore version-matching headaches.
docker compose exec -T postgres pg_dump \
  --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
  --no-owner --no-privileges --clean --if-exists \
  | gzip -9 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"

# 14-day retention. -mtime +14 = strictly older than 14 days.
find "$DIR" -maxdepth 1 -type f -name '*.sql.gz' -mtime +14 -delete

# Fail loudly if the dump is suspiciously small (<10KB) — empty DB is fine,
# but a real one with seeded teams + messages is always larger.
SIZE=$(stat -c %s "$OUT" 2>/dev/null || stat -f %z "$OUT")
if [ "$SIZE" -lt 10240 ]; then
  echo "pg-backup: $OUT is only ${SIZE} bytes — backup likely failed" >&2
  exit 1
fi

echo "pg-backup: wrote $OUT (${SIZE} bytes)"
