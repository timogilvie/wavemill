#!/usr/bin/env bash
# HOK-3453: one rule for a Ready result's queueState. The monitor
# (`ready_queue_state`) and the dashboard (`get_ready_queue_state`) both read
# it through `ready_result_queue_state` (wavemill-common.sh): a recorded value
# wins, an absent value is `ready` only on a completed pass/warn result.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0
check_eq() {
  if [[ "$2" == "$3" ]]; then
    echo "  PASS  $1"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $1 (expected '$2', got '$3')"; FAIL=$((FAIL + 1))
  fi
}

extract_function() {
  awk -v name="$2" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$1"
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

FUNC_FILE="$TEST_TMP/readers.sh"
extract_function "$REPO_DIR/shared/lib/wavemill-monitor.sh" ready_queue_state > "$FUNC_FILE"
extract_function "$REPO_DIR/shared/lib/wavemill-status.sh" get_ready_queue_state >> "$FUNC_FILE"
# shellcheck source=/dev/null
source "$FUNC_FILE"

# Each case: name | result JSON ("" = no file) | expected value.
run_case() {
  local name="$1" json="$2" expected="$3"
  local worktree="$TEST_TMP/$name" slug="task"
  local state_dir="$worktree/features/$slug"
  mkdir -p "$state_dir"
  [[ -n "$json" ]] && printf '%s\n' "$json" > "$state_dir/.ready-result.json"

  check_eq "$name: shared rule" "$expected" "$(ready_result_queue_state "$state_dir/.ready-result.json")"
  check_eq "$name: monitor reader" "$expected" "$(ready_queue_state "$state_dir")"
  check_eq "$name: dashboard reader" "$expected" "$(get_ready_queue_state "$worktree" "$slug")"
}

echo "=== ready_result_queue_state (HOK-3453) ==="
run_case "missing-file" "" ""
run_case "absent-completed-pass" '{"stage":"ready","status":"completed","artifacts":{"type":"ready","verdict":"pass"}}' "ready"
run_case "absent-completed-warn" '{"stage":"ready","status":"completed","artifacts":{"type":"ready","verdict":"warn"}}' "ready"
run_case "absent-completed-fail" '{"stage":"ready","status":"completed","artifacts":{"type":"ready","verdict":"fail"}}' ""
run_case "absent-running-pass" '{"stage":"ready","status":"running","artifacts":{"type":"ready","verdict":"pass"}}' ""
run_case "absent-failed-no-artifacts" '{"stage":"ready","status":"failed"}' ""
run_case "recorded-merge-needed" '{"stage":"ready","status":"completed","artifacts":{"type":"ready","verdict":"pass","queueState":"merge-needed"}}' "merge-needed"
run_case "recorded-ready-stale" '{"stage":"ready","status":"completed","artifacts":{"type":"ready","verdict":"pass","queueState":"ready-stale"}}' "ready-stale"
run_case "recorded-wins-on-running" '{"stage":"ready","status":"running","artifacts":{"type":"ready","queueState":"merge-candidate"}}' "merge-candidate"
run_case "malformed-json" '{not json' ""

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
