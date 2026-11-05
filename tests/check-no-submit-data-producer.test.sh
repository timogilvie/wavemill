#!/usr/bin/env bash
# Test: legacy submit_data producer is gone (HOK-3415, REQ-F4)
#
# Enforces the invariant that no code path in shared/lib/ or tools/ still
# produces the legacy `submit_data` contribution row. Wavemill now emits
# `technical_task_router_row/v4` exclusively (HOK-3412 schema). The audit
# reader (`hokusai-audit.ts`) and the queue tagger (`hokusai-queue.ts`) keep
# a historical reference to the retired row shape so already-queued
# `submit_data` rows can be audited — those two files are the allowlist.
#
# The guard fails if any new call site to `buildSubmitDataContributionRow` or
# `buildHokusaiContributionProjection`, or any `'submit_data'` row-shape
# literal, appears outside the allowlist.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Files allowed to mention the retired row shape in historical readers.
ALLOWLIST=(
  "shared/lib/hokusai-audit.ts"
  "shared/lib/hokusai-queue.ts"
  "shared/lib/hokusai-contribution-schema.ts"
)

check_no_submit_data_producer() {
  local root="$1"
  local -a scan_dirs=()
  local file raw_matches allow skip failed=false

  for dir in shared tools; do
    [[ -d "$root/$dir" ]] && scan_dirs+=("$dir")
  done
  if (( ${#scan_dirs[@]} == 0 )); then
    return 0
  fi

  # The retired producer symbols and row-shape literal. `isSubmitDataContributionRow`
  # is a reader (type guard, HOK-3415 keeps it exported for historical rows)
  # so it is explicitly excluded.
  raw_matches=$(cd "$root" && grep -rnE \
    -e 'buildSubmitDataContributionRow' \
    -e 'buildHokusaiContributionProjection' \
    -e "'submit_data'" \
    -e '"submit_data"' \
    "${scan_dirs[@]}" \
    --include='*.ts' --include='*.js' --include='*.sh' \
    | grep -v '\.test\.' \
    | grep -v 'isSubmitDataContributionRow' \
    | grep -v '^[^:]*:[^:]*:\s*#\s*allow-submit-data:' \
    | grep -v '^[^:]*:[^:]*:\s*//\s*allow-submit-data:' \
    || true)

  if [[ -z "$raw_matches" ]]; then
    return 0
  fi

  while IFS=: read -r file lineno rest; do
    [[ -z "$file" ]] && continue
    skip=false
    for allow in "${ALLOWLIST[@]}"; do
      if [[ "$file" == "$allow" ]]; then
        skip=true
        break
      fi
    done
    if [[ "$skip" == "true" ]]; then
      continue
    fi
    echo "FAIL: $file:$lineno references the retired submit_data producer" >&2
    echo "      Matched: $rest" >&2
    echo "      Emit technical_task_router_row/v4 via buildTechnicalTaskRouterRowV4 instead" >&2
    failed=true
  done <<< "$raw_matches"

  if [[ "$failed" == "true" ]]; then
    return 1
  fi
  return 0
}

echo "Checking no new submit_data producer call sites..."
if ! check_no_submit_data_producer "$REPO_ROOT"; then
  echo "FAIL: Legacy submit_data producer call sites detected" >&2
  exit 1
fi

echo "PASS: No legacy submit_data producer references outside the allowlist"
exit 0
