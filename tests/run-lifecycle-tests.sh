#!/usr/bin/env bash
set -u -o pipefail

# Focused lifecycle integration gate.
#
# These tests exercise controller lifecycle behavior without requiring a real
# tmux session, Linear/GitHub network access, Claude, or Codex. Keep this
# runner thin: scenario logic belongs in the individual test files so failures
# include their existing expected/actual details and logs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

run_lifecycle_test() {
  local name="$1"
  shift

  echo ""
  echo "=== $name ==="
  echo "Running: $*"

  if (cd "$REPO_DIR" && "$@"); then
    pass "$name"
  else
    local status=$?
    fail "$name exited with status $status"
  fi
}

echo "=== Wavemill Lifecycle Integration Tests ==="

run_lifecycle_test "planning validation regressions" bash tests/planning-validation.test.sh
run_lifecycle_test "startup handoff" bash tests/startup-handoff.test.sh
run_lifecycle_test "lifecycle harness" bash tests/lifecycle-harness.test.sh
run_lifecycle_test "lifecycle scenarios" bash tests/lifecycle-scenarios.test.sh
run_lifecycle_test "stage state shell helpers" bash tests/stage-state.test.sh
run_lifecycle_test "stage state TypeScript helpers" node --test tests/stage-state.test.ts
run_lifecycle_test "monitor ready transition" bash tests/monitor-ready-transition.test.sh
run_lifecycle_test "error recovery" bash tests/error-recovery.test.sh
run_lifecycle_test "dependent task launch" bash tests/wavemill-dependent-launch.test.sh
run_lifecycle_test "queued tasks state" bash tests/wavemill-queued-tasks-state.test.sh
run_lifecycle_test "launch plan queue metadata" bash tests/wavemill-launch-plan-queue-metadata.test.sh
run_lifecycle_test "terminal lifecycle cert matrix" bash tests/terminal-lifecycle-cert-matrix.test.sh
run_lifecycle_test "terminal lifecycle cert restart" bash tests/terminal-lifecycle-cert-restart.test.sh
run_lifecycle_test "terminal lifecycle cert budgets" bash tests/terminal-lifecycle-cert-budgets.test.sh

# Skip control layout test in CI - tmux session creation fails in containerized environments
if [[ -z "${CI:-}" ]]; then
  run_lifecycle_test "control layout" bash tests/control-layout.test.sh
else
  echo ""
  echo "=== control layout ==="
  echo "  SKIP  control layout (requires interactive tmux, not available in CI)"
fi

run_lifecycle_test "wavemill status" bash tests/wavemill-status.test.sh

echo ""
echo "--- Lifecycle Results: $PASS passed, $FAIL failed ---"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
