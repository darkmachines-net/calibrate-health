#!/bin/sh
# Restores an explicitly selected encrypted backup only into a confirmed empty, disposable database.
set -eu

: "${DB_HOST:?Missing DB_HOST}"
: "${DB_NAME:?Missing DB_NAME}"
: "${DB_USER:?Missing DB_USER}"
: "${DB_PASSWORD:?Missing DB_PASSWORD}"
: "${RESTORE_FILE:?Set RESTORE_FILE to an encrypted file under /backups}"
: "${AGE_IDENTITY_FILE:?Mount and set AGE_IDENTITY_FILE to the age private identity}"

if [ "${CONFIRM_RESTORE_TO_EMPTY_DATABASE:-}" != "RESTORE" ]; then
  echo "Refusing restore. Set CONFIRM_RESTORE_TO_EMPTY_DATABASE=RESTORE after verifying the target is disposable and empty." >&2
  exit 1
fi
case "$RESTORE_FILE" in
  /backups/calibrate-*.dump.age) ;;
  *) echo "RESTORE_FILE must be a completed /backups/calibrate-*.dump.age file." >&2; exit 1 ;;
esac
[ -f "$RESTORE_FILE" ] || { echo "Encrypted restore file does not exist." >&2; exit 1; }
[ -f "$AGE_IDENTITY_FILE" ] || { echo "Age identity file does not exist." >&2; exit 1; }

DB_PORT="${DB_PORT:-5432}"
export PGPASSWORD="$DB_PASSWORD"

table_count="$(psql \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --command="SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');")"
if [ "$table_count" != "0" ]; then
  echo "Refusing restore: target database contains $table_count user tables. Restore only into a clean database." >&2
  exit 1
fi

# Validate the encrypted custom-format dump before changing the target database.
age --decrypt --identity "$AGE_IDENTITY_FILE" "$RESTORE_FILE" | pg_restore --list >/dev/null
age --decrypt --identity "$AGE_IDENTITY_FILE" "$RESTORE_FILE" | pg_restore \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --no-owner \
  --no-acl \
  --exit-on-error

restored_tables="$(psql \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --command="SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');")"
if [ "$restored_tables" = "0" ]; then
  echo "Restore completed without application tables; refusing to report success." >&2
  exit 1
fi
echo "Encrypted Postgres restore completed with $restored_tables application tables. Start the app to apply any newer migrations."
