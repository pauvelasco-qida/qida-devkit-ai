#!/usr/bin/env bash
# Delete a ScreeningCall row from the Postgres DB.
#
# Accepts EITHER a candidate UUID or the ScreeningCall's own pk as the id:
# it filters by candidate_id first, then falls back to pk. A ScreeningCall is a
# OneToOne on Candidate (qida_base/candidates/models.py:180), so either id resolves
# to at most one row.
#
# The REST API cannot delete it: DELETE .../screening only flips status to CANCELLED
# (screening_call_service.py:111). This script does the hard delete.
#
# Must be run from the QidaBase repo root (where docker-compose.yml lives).
#
# Usage:
#   remove_screening.sh <id>          # dry run: show the row, delete nothing
#   remove_screening.sh <id> --yes    # actually delete
#
# Runs against the base compose (django + postgres only). No mongo/faker overlay,
# so it avoids the bitnami/mongodb image (pulled from Docker Hub Aug 2025).
set -euo pipefail

ID="${1:-}"
FLAG="${2:-}"

if [[ -z "$ID" ]]; then
  echo "Usage: $0 <id> [--yes]   (id = candidate UUID or ScreeningCall pk)" >&2
  exit 2
fi

if [[ ! -f docker-compose.yml ]]; then
  echo "Error: docker-compose.yml not found in $(pwd). Run from the QidaBase repo root." >&2
  exit 2
fi

DO_DELETE=0
if [[ "$FLAG" == "--yes" ]]; then
  DO_DELETE=1
fi

docker compose run --rm \
  -e IDENT="$ID" \
  -e DO_DELETE="$DO_DELETE" \
  django python manage.py shell -c '
import os
import uuid
from qida_base.candidates.models import ScreeningCall

ident = os.environ["IDENT"]
do_delete = os.environ.get("DO_DELETE") == "1"

try:
    uuid.UUID(ident)
except ValueError:
    print(f"{ident!r} is not a valid UUID. Nothing to delete.")
else:
    qs = ScreeningCall.objects.filter(candidate_id=ident)
    match_kind = "candidate_id"
    if not qs.exists():
        qs = ScreeningCall.objects.filter(pk=ident)
        match_kind = "screening pk"

    sc = qs.first()
    if sc is None:
        print(f"No ScreeningCall found for id {ident} (tried candidate_id and pk). Nothing to delete.")
    else:
        print(f"Found ScreeningCall by {match_kind}: id={sc.id} candidate={sc.candidate_id} status={sc.status} triggered_at={sc.triggered_at}")
        if do_delete:
            print(f"Deleted: {qs.delete()}")
        else:
            print("Dry run -- re-run with --yes to delete this row.")
        print(f"Remaining for this match: {qs.count()}")
'
