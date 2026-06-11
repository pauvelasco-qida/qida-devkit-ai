# qida-base

QidaBase local-dev commands for Claude Code: bring up the faked dev stack and operate
on `ScreeningCall` rows directly in the Postgres DB.

## Prerequisites

- Docker + Docker Compose
- A checkout of the QidaBase repo — **all commands must be run with the QidaBase repo
  root as the working directory** (where `docker-compose.yml` lives).

## Commands

### `/qida-base:run-faker [up | down | restart-faker]`

Bring up the local dev stack with third-party services faked via the `faker` mock
server (`:3030`). Merges `docker-compose.yml` + `docker-compose.local.yml`.

- `up` (default) — start the stack, show status
- `down` — tear it down
- `restart-faker` — reload faker mocks only (re-reads `./mocks`)

### `/qida-base:remove-screening <candidate-id | screening-id>`

Hard-delete a candidate's `ScreeningCall` row. The REST API only soft-cancels
(`status` → `CANCELLED`); this is the only hard-delete path. Runs the delete via the
Django ORM inside the base compose.

### `/qida-base:update-screening <id> field=value ... [--dry-run]`

Update `ScreeningCall` fields (status, decision, timestamps, JSON fields). Validated
with `full_clean()` before save. Bypasses the Selena callback flow — does NOT notify
Selena.

## Installation

From the qida-devkit-ai marketplace:

```
/plugin marketplace add <path-or-url-to-qida-devkit-ai>
/plugin install qida-base@qida-devkit-ai
```

Or test locally:

```bash
claude --plugin-dir /path/to/qida-devkit-ai/plugins/qida-base
```
