#!/usr/bin/env bash
# HOK-3452: the PR-closed eval path settles through the one eval-failure
# decision instead of writing a raw decision file (or recording a failed eval
# as completed).
#
#   persisted result   -> evalCompleted = true, no failure record
#   failed result      -> evalFailed = true and the decision record written
#   failed after reap  -> no .tasks entry, postReapEval.outcome = failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_FILE="$REPO_DIR/shared/lib/wavemill-mill.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$REPO_DIR/tests/lib/state-fixtures.sh"
source "$REPO_DIR/shared/lib/transient-marker.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$label"
  fi
}

extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) { exit }
    }
  ' "$source_file"
}

eval "$(extract_function "$MILL_FILE" run_pr_closed_eval)"
declare -F run_pr_closed_eval >/dev/null || { echo "could not extract run_pr_closed_eval" >&2; exit 1; }

log() { :; }
_with_timeout() { shift; "$@"; }

# Keep the real tool runner for the failure-policy CLI, and fake only the eval
# hook. Capture the original function under a new name before overriding.
_runner_def="$(declare -f wavemill_run_tool)"
eval "${_runner_def/wavemill_run_tool/real_wavemill_run_tool}"
FAKE_EVAL_MODE=""
wavemill_run_tool() {
  local tool="$1"
  shift
  if [[ "$tool" == "run-eval-hook.ts" ]]; then
    local result_file=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --result-file) result_file="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ "$FAKE_EVAL_MODE" == "persisted" ]]; then
      printf '{"persisted": true}\n' > "$result_file"
      return 0
    fi
    return 1
  fi
  real_wavemill_run_tool "$tool" "$@"
}

SESSION="pr-closed-test"
AGENT_CMD="true"
ISSUE="HOK-7101"
SLUG="hok-7101"

new_fixture() {
  WORKTREE_ROOT="$TMP_DIR/wt-root-$RANDOM$RANDOM"
  export WORKTREE_ROOT
  WT="$WORKTREE_ROOT/$SLUG"
  mkdir -p "$WT"
  git -C "$WT" init -q
  git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m one
  STATE_DIR="$WT/features/$SLUG"
  mkdir -p "$STATE_DIR"
  STATE_FILE="$TMP_DIR/state-$RANDOM$RANDOM.json"
  export STATE_FILE
  # Schema-validated row (HOK-3223), plus the terminal-history maps the
  # reaped-task case needs.
  fixture_workflow_state "$STATE_FILE" "$ISSUE" \
    slug="$SLUG" branch="task/$SLUG" phase=ready status=active pr=42 runId=run-pr-closed
  jq -c '.terminalTaskHistory = {tasks: {}} | .terminalTaskTombstones = {}' \
    "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
  MARKER="$STATE_DIR/.eval-failure-decision.json"
}

run_and_wait() {
  run_pr_closed_eval "$ISSUE" "42" "task/$SLUG" "$SLUG" "$ISSUE"
  wait
}

# --- Persisted eval records completion --------------------------------------
new_fixture
FAKE_EVAL_MODE="persisted"
run_and_wait

assert_eq "persisted: evalCompleted true" "true" \
  "$(jq -r --arg i "$ISSUE" '.tasks[$i].evalCompleted' "$STATE_FILE")"
assert_eq "persisted: evalFailed not set" "null" \
  "$(jq -r --arg i "$ISSUE" '.tasks[$i].evalFailed // "null"' "$STATE_FILE")"
if [[ -f "$MARKER" ]]; then fail "persisted: no failure record"; else pass "persisted: no failure record"; fi

# --- Failed eval sets evalFailed and records the decision -------------------
new_fixture
FAKE_EVAL_MODE="failed"
run_and_wait

assert_eq "failed: evalCompleted not set" "null" \
  "$(jq -r --arg i "$ISSUE" '.tasks[$i].evalCompleted // "null"' "$STATE_FILE")"
assert_eq "failed: evalFailed true" "true" \
  "$(jq -r --arg i "$ISSUE" '.tasks[$i].evalFailed // "null"' "$STATE_FILE")"
if [[ -f "$MARKER" ]]; then pass "failed: decision record written"; else fail "failed: decision record written"; fi
assert_eq "failed: record carries a failureKind" "true" \
  "$(jq -e '.detail.failureKind | type == "string" and length > 0' "$MARKER" >/dev/null 2>&1 && echo true || echo false)"
assert_eq "failed: record carries the runId" "run-pr-closed" \
  "$(jq -r '.detail.runId // ""' "$MARKER")"

# --- Failed eval after reap stays audit-only --------------------------------
new_fixture
jq --arg i "$ISSUE" '
  .terminalTaskHistory.tasks[$i] = {issue: $i, slug: "hok-7101"}
  | del(.tasks[$i])
' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
FAKE_EVAL_MODE="failed"
run_and_wait

assert_eq "reaped: entry not recreated" "null" \
  "$(jq -r --arg i "$ISSUE" '.tasks[$i] // "null"' "$STATE_FILE")"
assert_eq "reaped: postReapEval outcome" "failed" \
  "$(jq -r --arg i "$ISSUE" '.terminalTaskHistory.tasks[$i].postReapEval.outcome // ""' "$STATE_FILE")"
if [[ -f "$MARKER" ]]; then fail "reaped: no live record written"; else pass "reaped: no live record written"; fi

echo ""
echo "pr-closed-eval-decision: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
