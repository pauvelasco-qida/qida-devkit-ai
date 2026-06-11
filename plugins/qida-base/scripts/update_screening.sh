#!/usr/bin/env bash
# Update fields of a ScreeningCall row in the Postgres DB.
#
# Accepts EITHER a candidate UUID or the ScreeningCall's own pk as <id>: filters by
# candidate_id first, then falls back to pk. A ScreeningCall is a OneToOne on Candidate
# (qida_base/candidates/models.py:180), so either id resolves to at most one row.
#
# Fields are given as field=value pairs. Validated with full_clean() before save.
#
# Must be run from the QidaBase repo root (where docker-compose.yml lives).
#
# Usage:
#   update_screening.sh <id> field=value [field=value ...] [--dry-run]
#
# Examples:
#   update_screening.sh <id> status=completed decision=PASS
#   update_screening.sh <id> decision_reason="Good fit" completed_at=2026-06-11T08:00:00+00:00
#   update_screening.sh <id> next_attempt_at=null --dry-run
#   update_screening.sh <id> general_info='{"notes": "x"}'
#
# Editable fields: status trigger_mode triggered_at attempt_at next_attempt_at
#   decision decision_reason additional_info completed_at general_info competencies references
# Value `null` sets the field to NULL. JSON fields take a JSON literal. Datetimes take ISO 8601.
#
# Runs against the base compose (django + postgres only). No mongo/faker overlay,
# so it avoids the bitnami/mongodb image (pulled from Docker Hub Aug 2025).
set -euo pipefail

ID="${1:-}"
if [[ -z "$ID" ]]; then
  echo "Usage: $0 <id> field=value [field=value ...] [--dry-run]   (id = candidate UUID or ScreeningCall pk)" >&2
  exit 2
fi
shift

if [[ ! -f docker-compose.yml ]]; then
  echo "Error: docker-compose.yml not found in $(pwd). Run from the QidaBase repo root." >&2
  exit 2
fi

DRY=0
PAIRS=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    *=*) PAIRS+="$arg"$'\n' ;;
    *) echo "Bad argument: $arg (expected field=value or --dry-run)" >&2; exit 2 ;;
  esac
done

if [[ -z "$PAIRS" ]]; then
  echo "No field=value pairs given." >&2
  exit 2
fi

docker compose run --rm \
  -e IDENT="$ID" \
  -e DRY="$DRY" \
  -e PAIRS="$PAIRS" \
  django python manage.py shell -c '
import os
import json
import uuid
from django.core.exceptions import ValidationError
from django.utils.dateparse import parse_datetime
from qida_base.candidates.models import ScreeningCall

ident = os.environ["IDENT"]
dry = os.environ.get("DRY") == "1"
pairs = os.environ["PAIRS"]

EDITABLE = {
    "status", "trigger_mode", "triggered_at", "attempt_at", "next_attempt_at",
    "decision", "decision_reason", "additional_info", "completed_at",
    "general_info", "competencies", "references",
}
JSON_FIELDS = {"general_info", "competencies", "references"}
DATETIME_FIELDS = {"triggered_at", "attempt_at", "next_attempt_at", "completed_at"}

try:
    uuid.UUID(ident)
except ValueError:
    print(f"{ident!r} is not a valid UUID. Nothing to update.")
    raise SystemExit(1)

qs = ScreeningCall.objects.filter(candidate_id=ident)
match_kind = "candidate_id"
if not qs.exists():
    qs = ScreeningCall.objects.filter(pk=ident)
    match_kind = "screening pk"

sc = qs.first()
if sc is None:
    print(f"No ScreeningCall found for id {ident} (tried candidate_id and pk).")
    raise SystemExit(1)

changes = {}
for line in pairs.splitlines():
    line = line.strip()
    if not line:
        continue
    field, _, raw = line.partition("=")
    field = field.strip()
    if field not in EDITABLE:
        print(f"Field {field!r} is not editable. Editable: {sorted(EDITABLE)}")
        raise SystemExit(2)
    if raw == "null":
        val = None
    elif field in JSON_FIELDS:
        try:
            val = json.loads(raw)
        except json.JSONDecodeError as e:
            print(f"{field}: invalid JSON ({e}).")
            raise SystemExit(2)
    elif field in DATETIME_FIELDS:
        val = parse_datetime(raw)
        if val is None:
            print(f"{raw!r} is not a valid ISO 8601 datetime for {field}.")
            raise SystemExit(2)
    else:
        val = raw
    changes[field] = val

print(f"Matched by {match_kind}: id={sc.id} candidate={sc.candidate_id}")
for field, val in changes.items():
    print(f"  {field}: {getattr(sc, field)!r} -> {val!r}")
    setattr(sc, field, val)

try:
    sc.full_clean()
except ValidationError as e:
    print(f"Validation failed: {e.message_dict}")
    raise SystemExit(1)

if dry:
    print("Dry run -- not saved.")
else:
    sc.save()
    print("Saved.")
'
