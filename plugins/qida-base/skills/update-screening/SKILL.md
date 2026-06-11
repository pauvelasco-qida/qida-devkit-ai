---
name: update-screening
description: This skill should be used when the user asks to "update a screening", "change screening status", "set a screening decision", "edit ScreeningCall fields", or modify a candidate's screening row in the QidaBase Postgres DB.
argument-hint: "<candidate-id | screening-id> field=value ... [--dry-run]"
allowed-tools: ["Bash"]
model: haiku
---

Update fields of a `ScreeningCall` row in the QidaBase Postgres DB.

Must be run from the QidaBase repo root (where `docker-compose.yml` lives). The script
exits 2 with a clear error if not.

## Arguments

`$ARGUMENTS` = `<id> field=value [field=value ...] [--dry-run]`

- `<id>` — **required**, a UUID. Accepts EITHER the candidate UUID or the
  ScreeningCall's own pk: filters by `candidate_id` first, then falls back to `pk`.
- `field=value` — one or more. At least one required.
- `--dry-run` — show the before→after diff and validate, but do NOT save.

If no id or no field=value pair is given, ask for it.

## Editable fields

`status trigger_mode triggered_at attempt_at next_attempt_at decision decision_reason
additional_info completed_at general_info competencies references`

Value rules:
- `null` → sets the field to NULL (nullable fields only).
- JSON fields (`general_info`, `competencies`, `references`) → value must be a JSON
  literal, e.g. `general_info='{"notes":"x"}'`.
- Datetime fields (`triggered_at`, `attempt_at`, `next_attempt_at`, `completed_at`) →
  ISO 8601, e.g. `completed_at=2026-06-11T08:00:00+00:00`.
- Choice fields: `status` ∈ `queued|in_progress|missed_call|reschedule_requested|completed|self_discarded|cancelled`,
  `trigger_mode` ∈ `manual|self`, `decision` ∈ `PASS|FAIL|DEPRIORITIZE|UNREACHABLE`.

Changes are validated with `full_clean()` before save — bad choices/types are rejected.

## Run

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/update_screening.sh $ARGUMENTS
```

## Examples

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/update_screening.sh <id> status=completed decision=PASS
${CLAUDE_PLUGIN_ROOT}/scripts/update_screening.sh <id> decision_reason="Good fit" completed_at=2026-06-11T08:00:00+00:00
${CLAUDE_PLUGIN_ROOT}/scripts/update_screening.sh <id> next_attempt_at=null --dry-run
${CLAUDE_PLUGIN_ROOT}/scripts/update_screening.sh <id> general_info='{"notes":"hi","score":3}'
```

## Expected output

```
Matched by candidate_id|screening pk: id=<pk> candidate=<candidate_id>
  status: 'queued' -> 'completed'
  decision: None -> 'PASS'
Saved.            # or "Dry run -- not saved." with --dry-run
```

## Exit codes / errors

- `0` — saved (or dry-run validated ok).
- `1` — validation failed (`Validation failed: {...}`), no row found, or non-UUID id.
- `2` — bad usage: no id, no field=value pairs, unknown field, bad JSON, or bad datetime.

## Notes

- Runs inside the **base** compose (`django` + `postgres` only) — no mongo/faker
  overlay, so it avoids the `bitnami/mongodb:6.0.4` image (removed from Docker Hub Aug 2025).
- This writes directly to the DB and bypasses the Selena callback flow
  (`qida_base/candidates/services/screening_call_service.py`). It does NOT notify Selena.
