#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_RUNNER="$REPO_DIR/tests/run-unit-tests.sh"
CUSTOM_RUNNER="$REPO_DIR/tests/run-custom-tests.sh"

missing=()
duplicates=()

registered_in() {
  local rel="$1"
  local runner="$2"
  awk -v rel="$rel" '$1 == rel { found=1 } END { exit found ? 0 : 1 }' "$runner"
}

while IFS= read -r test_file; do
  rel="${test_file#$REPO_DIR/}"
  count=0
  if registered_in "$rel" "$UNIT_RUNNER"; then
    count=$((count + 1))
  fi
  if registered_in "$rel" "$CUSTOM_RUNNER"; then
    count=$((count + 1))
  fi

  if (( count == 0 )); then
    missing+=("$rel")
  elif (( count > 1 )); then
    duplicates+=("$rel")
  fi
done < <(
  find "$REPO_DIR/shared/lib" "$REPO_DIR/tools" \
    \( -path "$REPO_DIR/shared/lib/hokusai-*.test.ts" -o -path "$REPO_DIR/tools/hokusai-*.test.ts" \) \
    -type f \
    | sort
)

if (( ${#missing[@]} > 0 )); then
  echo "Hokusai test files missing from unit/custom TypeScript registries:" >&2
  printf '  %s\n' "${missing[@]}" >&2
fi

if (( ${#duplicates[@]} > 0 )); then
  echo "Hokusai test files registered in both unit and custom TypeScript registries:" >&2
  printf '  %s\n' "${duplicates[@]}" >&2
fi

if (( ${#missing[@]} > 0 || ${#duplicates[@]} > 0 )); then
  exit 1
fi

echo "All Hokusai TypeScript tests are registered exactly once."
