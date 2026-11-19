#!/usr/bin/env bash
set -euo pipefail

# Self-hosted container entrypoint. Apply pending migrations with bounded retries before starting Express.
#
# We avoid storing a full DATABASE_URL secret by injecting DB components (host/user/password)
# separately. Prisma migrations still require DATABASE_URL, so we compose it here before
# running `prisma migrate deploy`.

urlencode() {
  # URL-encode a value for safe inclusion in DATABASE_URL (handles special chars in passwords).
  node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"
}

if [[ -z "${DATABASE_URL:-}" ]]; then
  : "${DB_HOST:?Missing DB_HOST}"
  : "${DB_NAME:?Missing DB_NAME}"
  : "${DB_USER:?Missing DB_USER}"
  : "${DB_PASSWORD:?Missing DB_PASSWORD}"

  DB_PORT="${DB_PORT:-5432}"
  DB_SCHEMA="${DB_SCHEMA:-public}"
  DB_SSLMODE="${DB_SSLMODE:-require}"

  ENCODED_USER="$(urlencode "${DB_USER}")"
  ENCODED_PASS="$(urlencode "${DB_PASSWORD}")"
  ENCODED_DB_NAME="$(urlencode "${DB_NAME}")"
  ENCODED_SCHEMA="$(urlencode "${DB_SCHEMA}")"
  ENCODED_SSLMODE="$(urlencode "${DB_SSLMODE}")"

  export DATABASE_URL="postgresql://${ENCODED_USER}:${ENCODED_PASS}@${DB_HOST}:${DB_PORT}/${ENCODED_DB_NAME}?schema=${ENCODED_SCHEMA}&sslmode=${ENCODED_SSLMODE}"
fi

MIGRATION_MAX_ATTEMPTS="${MIGRATION_MAX_ATTEMPTS:-30}"
MIGRATION_RETRY_SECONDS="${MIGRATION_RETRY_SECONDS:-5}"
case "${MIGRATION_MAX_ATTEMPTS}" in
  ''|*[!0-9]*|0*)
    echo "MIGRATION_MAX_ATTEMPTS and MIGRATION_RETRY_SECONDS must be positive integers." >&2
    exit 1
    ;;
esac
case "${MIGRATION_RETRY_SECONDS}" in
  ''|*[!0-9]*|0*)
    echo "MIGRATION_MAX_ATTEMPTS and MIGRATION_RETRY_SECONDS must be positive integers." >&2
    exit 1
    ;;
esac

attempt=1
until ./node_modules/.bin/prisma migrate deploy; do
  if [[ "${attempt}" -ge "${MIGRATION_MAX_ATTEMPTS}" ]]; then
    echo "Database migrations failed after ${attempt} attempts; the container will exit for its restart policy." >&2
    exit 1
  fi
  echo "Database is unavailable or migrations could not acquire their lock (attempt ${attempt}/${MIGRATION_MAX_ATTEMPTS}); retrying in ${MIGRATION_RETRY_SECONDS}s." >&2
  attempt=$((attempt + 1))
  sleep "${MIGRATION_RETRY_SECONDS}"
done
exec node dist/backend/src/index.js
