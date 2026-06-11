---
name: run-faker
description: This skill should be used when the user asks to "run faker", "start the faked dev stack", "bring up the local stack with mocked third-party APIs", "stop the faker stack", or "reload faker mocks" for QidaBase.
argument-hint: "[up | down | restart-faker]"
allowed-tools: ["Bash"]
model: haiku
---

Bring up the QidaBase local dev stack with third-party services **faked** via faker.

Must be run from the QidaBase repo root (where `docker-compose.yml` lives). The script
exits 2 with a clear error if not.

## Arguments

`$ARGUMENTS` (optional):

- empty / `up` → `up -d` the full stack, then show status.
- `down` → tear the stack down.
- `restart-faker` → reload faker mocks only (re-reads `./mocks`, no full restart).

## What it does

Merges base compose + `docker-compose.local.yml`, which adds the `faker` mock server
(`dotronglong/faker` on `:3030`) and `mongo`. With this overlay every third-party API
call is stubbed — no real credentials needed. Equivalent to:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

The script also auto-recovers from a stale-container `name already in use` error by
removing `mongo`/`faker` and retrying once.

## Run

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/run_faker.sh $ARGUMENTS
```

## Expected output

`up` prints the compose status table (all services `Up`) then:

```
django  -> http://localhost:8000
faker   -> http://localhost:3030 (third-party APIs mocked)
```

## Notes

- The overlay's `mongo` uses `bitnamilegacy/mongodb:6.0.4` — Bitnami pulled the old
  `bitnami/mongodb` tags from Docker Hub (Aug 2025). If you hit
  `failed to resolve reference "docker.io/bitnami/mongodb:6.0.4"`, the overlay still
  has the old image ref; fix it to `bitnamilegacy/...`.
- On arm64 Macs `mongo` runs amd64 under emulation (platform-mismatch warning) — works,
  slightly slower.
- Plain `docker compose up` (no overlay) hits real third-party services and needs
  credentials; `--env-file django.env up` runs them with your creds.
