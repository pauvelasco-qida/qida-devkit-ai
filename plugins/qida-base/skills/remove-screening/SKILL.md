---
name: remove-screening
description: This skill should be used when the user asks to "remove a screening", "delete a screening call", "hard-delete a candidate's screening", or "remove the ScreeningCall row" from the QidaBase Postgres DB.
argument-hint: "<candidate-id | screening-id>"
allowed-tools: ["Bash"]
model: haiku
---

Hard-delete a candidate's screening (`ScreeningCall`) row from the QidaBase Postgres DB.

Must be run from the QidaBase repo root (where `docker-compose.yml` lives). The script
exits 2 with a clear error if not.

## Arguments

`$ARGUMENTS` = `<id>`

- `<id>` — **required**, a UUID. Accepts EITHER the candidate UUID or the
  ScreeningCall's own pk: the script filters by `candidate_id` first, then falls
  back to `pk`. The script exits 2 if no id is passed.

If no id is given, ask for it. Otherwise delete it directly — **do NOT ask for
confirmation** and do NOT do a dry-run first. Always pass `--yes`.

**Local dev only.** This performs an irreversible hard delete with no confirmation
gate. Only run it against the local compose stack — never against a shared, staging,
or production database.

## Why this exists (not the API)

`DELETE /api/v1/candidates/<id>/screening` does **not** remove the row — it soft-cancels
(`status` → `CANCELLED`, `qida_base/candidates/services/screening_call_service.py:111`).
The row stays. The only hard-delete path is the ORM, which this command runs.
`ScreeningCall.candidate` is a `OneToOneField` (`qida_base/candidates/models.py:180`) →
at most one row per candidate.

## Run

Run the delete directly with `--yes` (no confirmation, no dry-run):

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/remove_screening.sh $ARGUMENTS --yes
```

The script runs the delete inside the **base** compose (`django` + `postgres` only,
`docker-compose.yml:54`) — no mongo/faker overlay, so it avoids the
`bitnami/mongodb:6.0.4` image (removed from Docker Hub Aug 2025).

## Expected output

- Has a row → `Found ScreeningCall by candidate_id|screening pk: ...` + `Deleted: (1, {'candidates.ScreeningCall': 1})` + `Remaining for this match: 0`
- No row → `No ScreeningCall found for id <id> (tried candidate_id and pk). Nothing to delete.`
- Malformed id → `'<id>' is not a valid UUID. Nothing to delete.`
- No id → usage line, exit code 2.

After deletion, `GET /api/v1/candidates/<id>/screening` returns `404 No screening found`
(`qida_base/candidates/api/views.py:416`). Re-trigger with `POST` if needed.

## Notes

- If the mongo/faker overlay stack is running, base compose prints a harmless
  `Found orphan containers ([faker mongo])` warning. Ignore it — the delete still runs.
- `--yes` is the only confirmation gate; there is no interactive prompt.
