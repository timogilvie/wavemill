#!/usr/bin/env bash
# HOK-3470: one-off - label the open "One X" consolidation issues so the
# consolidation CI gate (tools/check-consolidation.ts) applies to them.
# Extra issue IDs may be passed as arguments. Requires LINEAR_API_KEY.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for id in HOK-3447 HOK-3426 HOK-3459 HOK-3461 HOK-3460 "$@"; do
  (cd "$REPO_ROOT" && npx tsx tools/add-issue-label.ts "$id" consolidation) # install-paths: allow one-off repo-local maintenance script, not an install asset
done
