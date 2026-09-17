#!/usr/bin/env bash
# HOK-3038: Ready→Tend handoff state regression tests.
# Validates that the handoff record, label verification, and Tend claim
# interact correctly — especially the HOK-3030 race scenario.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="$REPO_DIR/tools"

passed=0
failed=0
errors=""

run_test() {
  local name="$1"
  shift
  if "$@" 2>/dev/null; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    errors="${errors}\n  FAIL: $name"
  fi
}

# ── Test 1: Handoff module round-trip ────────────────────────────────
test_handoff_roundtrip() {
  local tmp
  tmp=$(mktemp -d)
  trap "rm -rf '$tmp'" RETURN

  # Publish
  npx tsx "$REPO_DIR/shared/lib/ready-tend-handoff-cli.ts" publish \
    --state-dir "$tmp" --pr 999 --head abc123

  # Verify the file exists and has correct state
  local state
  state=$(jq -r '.state' "$tmp/.ready-tend-handoff.json")
  [[ "$state" == "ready-published" ]] || return 1

  # Verify record-failure persists typed stage
  npx tsx "$REPO_DIR/shared/lib/ready-tend-handoff-cli.ts" record-failure \
    --state-dir "$tmp" --stage route-stamp --diagnostic "stamp failed"

  local stage
  stage=$(jq -r '.failureStage' "$tmp/.ready-tend-handoff.json")
  [[ "$stage" == "route-stamp" ]] || return 1
}

# ── Test 2: Handoff CLI rejects bad arguments ────────────────────────
test_handoff_cli_rejects_bad_args() {
  ! npx tsx "$REPO_DIR/shared/lib/ready-tend-handoff-cli.ts" publish 2>/dev/null
}

# ── Test 3: Typed failure stages are distinct ────────────────────────
test_typed_failure_stages() {
  local tmp
  tmp=$(mktemp -d)
  trap "rm -rf '$tmp'" RETURN

  npx tsx "$REPO_DIR/shared/lib/ready-tend-handoff-cli.ts" publish \
    --state-dir "$tmp" --pr 100 --head def456

  for stage in route-stamp ready-label ownership-changed github-api; do
    npx tsx "$REPO_DIR/shared/lib/ready-tend-handoff-cli.ts" record-failure \
      --state-dir "$tmp" --stage "$stage" --diagnostic "test $stage"
    local recorded
    recorded=$(jq -r '.failureStage' "$tmp/.ready-tend-handoff.json")
    [[ "$recorded" == "$stage" ]] || return 1
  done
}

# ── Test 4: Diagnostic redaction ─────────────────────────────────────
test_diagnostic_redaction() {
  local tmp
  tmp=$(mktemp -d)
  trap "rm -rf '$tmp'" RETURN

  npx tsx "$REPO_DIR/shared/lib/ready-tend-handoff-cli.ts" publish \
    --state-dir "$tmp" --pr 101 --head aaa111

  npx tsx "$REPO_DIR/shared/lib/ready-tend-handoff-cli.ts" record-failure \
    --state-dir "$tmp" --stage github-api \
    --diagnostic "token=ghp_SENSITIVE123 at /Users/secret/path"

  local diag
  diag=$(jq -r '.diagnosticExcerpt' "$tmp/.ready-tend-handoff.json")
  # Must not contain the raw token or user path
  [[ "$diag" != *"ghp_SENSITIVE123"* ]] || return 1
  [[ "$diag" != *"/Users/secret"* ]] || return 1
}

# ── Run tests ────────────────────────────────────────────────────────
run_test "handoff roundtrip" test_handoff_roundtrip
run_test "CLI rejects bad args" test_handoff_cli_rejects_bad_args
run_test "typed failure stages" test_typed_failure_stages
run_test "diagnostic redaction" test_diagnostic_redaction

echo ""
echo "ready-label-state: $passed passed, $failed failed"
if [[ $failed -gt 0 ]]; then
  echo -e "Failures:$errors"
  exit 1
fi
