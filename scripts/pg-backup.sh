#!/usr/bin/env bash
# Nightly Postgres backup. Runs `pg_dump` inside the postgres container,
# gzips to /opt/ccp/backups, retains 14 days. Run from /opt/ccp as the
# `deploy` user via cron — see deploy/README.md "Backups".
#
# Restore: gunzip -c /opt/ccp/backups/<file>.sql.gz | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
#
# OFFSITE COPY (config-driven — NO-OPs cleanly when unset). The on-VPS dumps
# live on the SAME disk as the postgres_data volume, so a disk failure loses
# both. Set ONE of these in /opt/ccp/.env to push each fresh dump offsite:
#   BACKUP_RCLONE_REMOTE   e.g. "myremote:ccp-backups"  (needs `rclone` + a
#                          configured remote on the VPS: `rclone config`)
#   BACKUP_S3_BUCKET       e.g. "s3://my-bucket/ccp-backups" (needs `aws` CLI
#                          + credentials in the env / ~/.aws on the VPS)
# Optional BACKUP_GPG_RECIPIENT encrypts the dump with `gpg -e -r <recipient>`
# before upload (the offsite copy is then `.sql.gz.gpg`); leave unset to rely
# on the bucket's own SSE/KMS. No bucket name or credential is ever hardcoded
# here — the script is inert until the operator wires the env vars.
#
# DEAD-MAN'S SWITCH (optional). Set BACKUP_HEALTHCHECK_URL to a healthchecks.io
# (or similar) ping URL; the script pings <url>/start at the top and <url> on
# success, so a SILENTLY-failing nightly backup pages you when no ping arrives.
set -euo pipefail

cd /opt/ccp

# .env on the VPS holds POSTGRES_USER / POSTGRES_DB plus the optional backup
# knobs above. Parse ONLY the keys we need with grep|cut — do NOT `. ./.env`.
# Sourcing the compose .env under `set -euo pipefail` is a footgun deploy.yml
# deliberately avoids: any unrelated secret value containing a shell
# metacharacter would abort the backup (silent backup loss) or execute as code.
# We only assign to variables here (never eval them), so even a hostile value
# can't run. `|| true` keeps a missing key from tripping `set -e`; the `:=`
# defaults then match compose.
read_env() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
if [ -f .env ]; then
  POSTGRES_USER="$(read_env POSTGRES_USER)" || true
  POSTGRES_DB="$(read_env POSTGRES_DB)" || true
  : "${BACKUP_RCLONE_REMOTE:=$(read_env BACKUP_RCLONE_REMOTE)}"
  : "${BACKUP_S3_BUCKET:=$(read_env BACKUP_S3_BUCKET)}"
  : "${BACKUP_GPG_RECIPIENT:=$(read_env BACKUP_GPG_RECIPIENT)}"
  : "${BACKUP_HEALTHCHECK_URL:=$(read_env BACKUP_HEALTHCHECK_URL)}"
fi
: "${POSTGRES_USER:=app}"
: "${POSTGRES_DB:=ccp}"
: "${BACKUP_RCLONE_REMOTE:=}"
: "${BACKUP_S3_BUCKET:=}"
: "${BACKUP_GPG_RECIPIENT:=}"
: "${BACKUP_HEALTHCHECK_URL:=}"

# Dead-man's switch: signal "backup started". Best-effort — a ping failure must
# never abort the backup itself, so swallow errors.
if [ -n "$BACKUP_HEALTHCHECK_URL" ] && command -v curl >/dev/null 2>&1; then
  curl -fsS -m 10 "${BACKUP_HEALTHCHECK_URL%/}/start" >/dev/null 2>&1 || true
fi

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

# --- Offsite copy (config-driven; no-op when unset) --------------------------
# Optionally encrypt before upload. We push the (optionally-encrypted) LATEST
# dump; the offsite remote keeps its own retention. A push failure FAILS the
# script (non-zero exit) so the dead-man's switch below does NOT fire a success
# ping — an offsite leg that silently stops is exactly the gap this closes.
UPLOAD_SRC="$OUT"
if [ -n "$BACKUP_GPG_RECIPIENT" ]; then
  if ! command -v gpg >/dev/null 2>&1; then
    echo "pg-backup: BACKUP_GPG_RECIPIENT set but gpg not installed" >&2
    exit 1
  fi
  gpg --batch --yes --trust-model always -e -r "$BACKUP_GPG_RECIPIENT" -o "$OUT.gpg" "$OUT"
  UPLOAD_SRC="$OUT.gpg"
fi

if [ -n "$BACKUP_RCLONE_REMOTE" ]; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "pg-backup: BACKUP_RCLONE_REMOTE set but rclone not installed" >&2
    exit 1
  fi
  rclone copyto "$UPLOAD_SRC" "${BACKUP_RCLONE_REMOTE%/}/$(basename "$UPLOAD_SRC")"
  echo "pg-backup: pushed $(basename "$UPLOAD_SRC") → $BACKUP_RCLONE_REMOTE"
elif [ -n "$BACKUP_S3_BUCKET" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "pg-backup: BACKUP_S3_BUCKET set but aws CLI not installed" >&2
    exit 1
  fi
  aws s3 cp "$UPLOAD_SRC" "${BACKUP_S3_BUCKET%/}/$(basename "$UPLOAD_SRC")"
  echo "pg-backup: pushed $(basename "$UPLOAD_SRC") → $BACKUP_S3_BUCKET"
else
  echo "pg-backup: no offsite target configured (BACKUP_RCLONE_REMOTE / BACKUP_S3_BUCKET unset) — local copy only"
fi

# Drop the transient .gpg artifact — the plaintext .sql.gz is the on-VPS copy;
# the encrypted one only existed for the upload.
[ -n "$BACKUP_GPG_RECIPIENT" ] && rm -f "$OUT.gpg"

# Dead-man's switch: signal success. Best-effort ping; reaching here means the
# dump (and any configured offsite push) succeeded.
if [ -n "$BACKUP_HEALTHCHECK_URL" ] && command -v curl >/dev/null 2>&1; then
  curl -fsS -m 10 "$BACKUP_HEALTHCHECK_URL" >/dev/null 2>&1 || true
fi
