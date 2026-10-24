#!/bin/sh
# Creates encrypted PostgreSQL backups and prunes only this backup directory's retained archives.
set -eu

require_positive_integer() {
  name="$1"
  value="$2"
  case "$value" in
    ''|*[!0-9]*|0*) echo "$name must be a positive integer without leading zeroes." >&2; exit 1 ;;
  esac
}

: "${DB_HOST:?Missing DB_HOST}"
: "${DB_NAME:?Missing DB_NAME}"
: "${DB_USER:?Missing DB_USER}"
: "${DB_PASSWORD:?Missing DB_PASSWORD}"
: "${BACKUP_AGE_RECIPIENT:?Missing BACKUP_AGE_RECIPIENT}"

DB_PORT="${DB_PORT:-5432}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_RETRY_SECONDS="${BACKUP_RETRY_SECONDS:-300}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_DIRECTORY="${BACKUP_DIRECTORY:-/backups}"
export PGPASSWORD="$DB_PASSWORD"

require_positive_integer DB_PORT "$DB_PORT"
require_positive_integer BACKUP_INTERVAL_SECONDS "$BACKUP_INTERVAL_SECONDS"
require_positive_integer BACKUP_RETRY_SECONDS "$BACKUP_RETRY_SECONDS"
require_positive_integer BACKUP_RETENTION_DAYS "$BACKUP_RETENTION_DAYS"
mkdir -p "$BACKUP_DIRECTORY"
chmod 0700 "$BACKUP_DIRECTORY"

plaintext=''
partial=''
cleanup() {
  [ -z "$plaintext" ] || rm -f -- "$plaintext"
  [ -z "$partial" ] || rm -f -- "$partial"
}
trap cleanup EXIT INT TERM HUP

run_backup() {
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  destination="$BACKUP_DIRECTORY/calibrate-$timestamp.dump.age"
  # BusyBox mktemp requires the random X suffix at the end of the template.
  plaintext="$(mktemp /tmp/calibrate-postgres.dump.XXXXXX)"
  partial="$destination.partial"

  if ! pg_dump \
    --host="$DB_HOST" \
    --port="$DB_PORT" \
    --username="$DB_USER" \
    --dbname="$DB_NAME" \
    --format=custom \
    --no-owner \
    --no-acl \
    --file="$plaintext"; then
    return 1
  fi
  if ! age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$partial" "$plaintext"; then
    return 1
  fi
  chmod 0600 "$partial" || return 1
  mv "$partial" "$destination" || return 1
  rm -f -- "$plaintext" || return 1
  plaintext=''
  partial=''

  # Retention applies only to completed encrypted dumps; partial files are never promoted on failure.
  find "$BACKUP_DIRECTORY" -type f -name 'calibrate-*.dump.age' \
    -mtime "+$BACKUP_RETENTION_DAYS" -delete || return 1
  date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIRECTORY/.last-success" || return 1
  chmod 0600 "$BACKUP_DIRECTORY/.last-success" || return 1
  echo "Encrypted Postgres backup completed: $destination"
}

while true; do
  if run_backup; then
    sleep "$BACKUP_INTERVAL_SECONDS"
  else
    echo "Encrypted Postgres backup failed; retrying in ${BACKUP_RETRY_SECONDS}s." >&2
    cleanup
    plaintext=''
    partial=''
    sleep "$BACKUP_RETRY_SECONDS"
  fi
done
