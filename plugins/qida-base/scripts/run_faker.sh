#!/usr/bin/env bash
# Bring up the local dev stack with third-party services FAKED via faker.
#
# Merges base compose + the local override (docker-compose.local.yml), which adds
# the `faker` mock server (dotronglong/faker on :3030) and `mongo`. With this overlay
# all third-party API calls are stubbed -- no real credentials needed.
#
# Must be run from the QidaBase repo root (where docker-compose.yml lives).
#
# Usage:
#   run_faker.sh            # up -d, then show status
#   run_faker.sh down       # tear the stack down
#   run_faker.sh restart-faker   # reload faker mocks only (re-reads ./mocks)
set -euo pipefail

if [[ ! -f docker-compose.yml || ! -f docker-compose.local.yml ]]; then
  echo "Error: docker-compose.yml / docker-compose.local.yml not found in $(pwd)." >&2
  echo "Run this command from the QidaBase repo root." >&2
  exit 2
fi

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.local.yml)
ACTION="${1:-up}"

case "$ACTION" in
  up)
    # Retry once after clearing stale containers -- a previous failed run can leave
    # `mongo`/`faker` behind and cause "container name already in use". Scoped to
    # compose-managed containers so unrelated containers with the same names survive.
    if ! "${COMPOSE[@]}" up -d; then
      echo "up failed -- removing stale mongo/faker containers and retrying..." >&2
      "${COMPOSE[@]}" rm -sf mongo faker >/dev/null 2>&1 || true
      "${COMPOSE[@]}" up -d
    fi
    "${COMPOSE[@]}" ps
    echo
    echo "django  -> http://localhost:8000"
    echo "faker   -> http://localhost:3030 (third-party APIs mocked)"
    ;;
  down)
    "${COMPOSE[@]}" down
    ;;
  restart-faker)
    "${COMPOSE[@]}" restart faker
    ;;
  *)
    echo "Usage: $0 [up|down|restart-faker]" >&2
    exit 2
    ;;
esac
