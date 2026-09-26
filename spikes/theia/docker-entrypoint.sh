#!/bin/sh
# Starts Theia on /workspace. WHITEBOARD_CLONE_URLS (space-separated git URLs)
# are cloned into /workspace on first start, so a fresh volume has a checkout
# to review; existing clones are left alone.
set -eu

for url in ${WHITEBOARD_CLONE_URLS:-}; do
  name=$(basename "$url" .git)

  if [ ! -d "/workspace/$name/.git" ]; then
    git clone --quiet "$url" "/workspace/$name" || echo "Could not clone $url" >&2
  fi
done

exec node lib/backend/main.js /workspace --hostname "$WHITEBOARD_HOST" --port "$PORT"
