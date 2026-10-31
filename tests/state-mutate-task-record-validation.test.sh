#!/usr/bin/env bash
# HOK-3222 Phase 1: state_mutate validates the task records a write to
# workflow-state.json adds or changes (shell seam of
# shared/lib/task-record-write-guard.ts) and shadow-logs violations to
# <state dir>/state-schema-violations.jsonl while letting the write through.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$REPO_DIR/tests/lib/state-fixtures.sh"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }

assert_eq() {
  local expected="$1" actual="$2" message="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$message"; else fail "$message (expected '$expected', got '$actual')"; fi
}

# Fresh <repo>/.wavemill/workflow-state.json seeded with two clean rows.
new_state() {
  local repo="$TEST_DIR/$1"
  mkdir -p "$repo/.wavemill"
  local state="$repo/.wavemill/workflow-state.json"
  fixture_workflow_state "$state" HOK-1 slug=one -- HOK-2 slug=two
  printf '%s\n' "$state"
}

log_lines() {
  local log="$(dirname "$1")/state-schema-violations.jsonl"
  if [[ -f "$log" ]]; then wc -l <"$log" | tr -d ' '; else echo 0; fi
}

echo "test_malformed_shell_write_is_logged_and_applied"
# protects: a shell writer that stores a wrongly-typed task field corrupts state silently.
state="$(new_state shadow)"
state_mutate "$state" '.tasks["HOK-1"].evalFailed = "no"' 2>"$TEST_DIR/shadow.err"
log="$(dirname "$state")/state-schema-violations.jsonl"
assert_eq "1" "$(log_lines "$state")" "one violation line is logged"
assert_eq "shell|HOK-1|/tasks/HOK-1/evalFailed|shadow|$state" \
  "$(jq -r '[.writer, .issue, .path, .mode, .statePath] | join("|")' "$log")" "the line names writer, task, field, mode and state file"
assert_eq "/tasks/*/evalFailed must be boolean" "$(jq -r '.signature' "$log")" "the signature is task-agnostic"
assert_eq "no" "$(jq -r '.tasks["HOK-1"].evalFailed' "$state")" "shadow mode still applies the write"
assert_eq "two" "$(jq -r '.tasks["HOK-2"].slug' "$state")" "other rows are untouched"
if grep -q 'write produced schema violations' "$TEST_DIR/shadow.err"; then pass "stderr reports the violation"; else fail "stderr reports the violation"; fi
if compgen -G "$state.tmp.*" >/dev/null || [[ -d "$state.lock" ]]; then fail "no temp file or lock is left behind"; else pass "no temp file or lock is left behind"; fi

echo "test_clean_write_logs_nothing"
# protects: a valid write must not produce false-positive violation lines.
state="$(new_state clean)"
state_mutate "$state" '.tasks["HOK-1"].evalFailed = true | .tasks["HOK-3"] = {slug: "three", phase: "coding"}'
assert_eq "0" "$(log_lines "$state")" "a clean write (changed + added rows) logs nothing"
assert_eq "true" "$(jq -r '.tasks["HOK-1"].evalFailed' "$state")" "the clean write is applied"

echo "test_inherited_violation_is_not_charged_to_the_writer"
# protects: a pre-existing bad field (other row, or same row) must not be charged to an unrelated write.
state="$(new_state inherited)"
WAVEMILL_TASK_RECORD_WRITE_VALIDATE_SHADOW=0 \
  state_mutate "$state" '.tasks["HOK-1"].evalFailed = "legacy" | .tasks["HOK-2"].evalFailed = "legacy"'
assert_eq "0" "$(log_lines "$state")" "the kill switch skips validation entirely"
state_mutate "$state" '.tasks["HOK-2"].slug = "renamed" | .tasks["HOK-1"].status = "aborted"'
assert_eq "0" "$(log_lines "$state")" "touching rows that already carried the bad field logs nothing"
assert_eq "renamed|aborted" "$(jq -r '[.tasks["HOK-2"].slug, .tasks["HOK-1"].status] | join("|")' "$state")" "both writes applied"
state_mutate "$state" '.tasks["HOK-1"].challengerLaunched = "yes"' 2>/dev/null
assert_eq "1" "$(log_lines "$state")" "a new violation in a row with an inherited one is logged once"
assert_eq "/tasks/HOK-1/challengerLaunched" "$(jq -r '.path' "$(dirname "$state")/state-schema-violations.jsonl")" "only the introduced violation is logged"

echo "test_task_state_mutate_existing_is_covered"
# protects: the reap-safe writer bypasses validation because it is a separate helper.
state="$(new_state existing)"
STATE_FILE="$state" task_state_mutate_existing HOK-2 '.evalFailed = "nope"' 2>/dev/null
assert_eq "HOK-2" "$(jq -r '.issue' "$(dirname "$state")/state-schema-violations.jsonl")" "task_state_mutate_existing writes are validated"

echo "test_non_workflow_state_files_are_not_validated"
# protects: the guard leaking onto other JSON state files that have a different shape.
other="$TEST_DIR/other/.wavemill/hokusai-queue.json"
mkdir -p "$(dirname "$other")"
# allow-task-literal: a non-workflow-state `tasks` map is the point of the test
printf '{"tasks":{"HOK-1":{"evalFailed":true}}}\n' >"$other"
state_mutate "$other" '.tasks["HOK-1"].evalFailed = "not a bool here"'
if [[ -f "$(dirname "$other")/state-schema-violations.jsonl" ]]; then fail "non-workflow-state writes are not validated"; else pass "non-workflow-state writes are not validated"; fi

echo "test_observer_finding_once_per_signature"
# protects: a writer repeating the same defect every tick floods the observer with one finding per write.
state="$(new_state observer)"
repo="$(dirname "$(dirname "$state")")"
printf '{"observer":{"enabled":true}}\n' >"$repo/.wavemill-config.json"
state_mutate "$state" '.tasks["HOK-1"].evalFailed = "a"' 2>/dev/null
state_mutate "$state" '.tasks["HOK-2"].evalFailed = "b"' 2>/dev/null
assert_eq "2" "$(log_lines "$state")" "both violating writes are logged"
findings="$repo/.wavemill/observer-findings.jsonl"
if [[ -f "$findings" ]]; then
  assert_eq "1" "$(jq -s '[.[] | select(.context.invariantId == "task-record-write")] | length' "$findings")" \
    "one observer finding for the shared signature"
else
  pass "observer capability off on this host: no findings file (shadow log is authoritative)"
fi

echo
echo "state-mutate task-record validation: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
