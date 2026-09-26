#!/bin/sh
# Hashes the basic-auth password at start, so only a bcrypt hash is ever in
# Caddy's configuration, then runs Caddy.
set -eu

: "${BASIC_AUTH_USER:?set BASIC_AUTH_USER}"
: "${BASIC_AUTH_PASSWORD:?set BASIC_AUTH_PASSWORD}"

if [ "${#BASIC_AUTH_PASSWORD}" -lt 16 ]; then
  echo "BASIC_AUTH_PASSWORD must be at least 16 characters." >&2
  exit 1
fi

BASIC_AUTH_HASH=$(caddy hash-password --plaintext "$BASIC_AUTH_PASSWORD")
export BASIC_AUTH_HASH
unset BASIC_AUTH_PASSWORD

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
