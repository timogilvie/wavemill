#!/usr/bin/env bash
# wavemill-test-suite: lifecycle (run by tests/run-lifecycle-tests.sh)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/fixtures/lifecycle"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

run_fixture() {
  local name="$1"
  local path="$2"
  local output=""
  local status=0

  output="$(bash "$path" 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    pass "$name"
  else
    printf '%s\n' "$output" | sed 's/^/    /'
    fail "$name"
  fi
}

echo "=== Dependent Task Launch ==="

run_fixture "parent PR triggers child launch" "$FIXTURE_DIR/parent_pr_triggers_child_launch.sh"
run_fixture "missing parent branch fails clearly" "$FIXTURE_DIR/parent_branch_missing_fails_clearly.sh"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
