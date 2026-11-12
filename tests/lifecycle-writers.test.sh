#!/usr/bin/env bash
# HOK-3454 Slice 1: lifecycle writers stamp retention on terminal outcomes.
#
# Every shell path that writes a terminal workflowOutcome with a retention-required
# resourceDisposition now goes through wm_ensure_terminal_retention, so the
# task-record write guard logs no schema violations.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$REPO_DIR/tests/lib/state-fixtures.sh"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

# wavemill-monitor.sh is invoked with a monitor.env argument; extract only the
# one lifecycle writer we need rather than sourcing the whole monitor script.
extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$source_file"
}

monitor_helpers="$TEST_DIR/monitor-helpers.sh"
{
  extract_function "$REPO_DIR/shared/lib/wavemill-monitor.sh" "mark_task_aborted_for_cleanup"
} > "$monitor_helpers"
source "$monitor_helpers"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }

assert_eq() {
  local expected="$1" actual="$2" message="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$message"; else fail "$message (expected '$expected', got '$actual')"; fi
}

assert_has_retention() {
  local state="$1" issue="$2" message="$3"
  local reason
  reason="$(jq -r ".tasks[\"$issue\"].lifecycle.retention.reason // empty" "$state")"
  if [[ -n "$reason" ]]; then pass "$message"; else fail "$message (no retention.reason)"; fi
}

log_lines() {
  local log="$(dirname "$1")/state-schema-violations.jsonl"
  if [[ -f "$log" ]]; then wc -l <"$log" | tr -d ' '; else echo 0; fi
}

new_state() {
  local repo="$TEST_DIR/$1"
  mkdir -p "$repo/.wavemill"
  local state="$repo/.wavemill/workflow-state.json"
  fixture_workflow_state "$state" HOK-1 slug=one -- HOK-2 slug=two
  printf '%s\n' "$state"
}

echo "test_mark_task_aborted_for_cleanup_stamps_retention"
# protects: a challenger arm terminalized for cleanup writes workflowOutcome
# "aborted" while resourceDisposition is still "allocated", producing the
# terminal-outcome + no-retention pair.
state="$(new_state aborted)"
fixture_workflow_state "$state" HOK-3_c status=active phase=coding lifecycle:='{"schemaVersion":1,"workflowOutcome":"active","resourceDisposition":"allocated"}'
STATE_FILE="$state" mark_task_aborted_for_cleanup HOK-3_c "challenge arm cleanup"
assert_eq "aborted" "$(jq -r '.tasks["HOK-3_c"].lifecycle.workflowOutcome' "$state")" "workflowOutcome is aborted"
assert_eq "verification-required" "$(jq -r '.tasks["HOK-3_c"].lifecycle.resourceDisposition' "$state")" "disposition downgraded to verification-required"
assert_has_retention "$state" "HOK-3_c" "retention block was stamped"
assert_eq "0" "$(log_lines "$state")" "write guard logged no violations"

echo "test_set_task_lifecycle_disposition_stamps_retention_on_terminal_outcome"
# protects: a cleanup step passes reason="" for a terminal outcome with a
# retention-required disposition and silently writes the invalid pair.
state="$(new_state disposition)"
fixture_workflow_state "$state" HOK-4 status=active phase=coding lifecycle:='{"schemaVersion":1,"workflowOutcome":"active","resourceDisposition":"allocated"}'
STATE_FILE="$state" set_task_lifecycle_disposition HOK-4 "closed" "allocated" "" "cleanup_completed_task"
assert_eq "closed" "$(jq -r '.tasks["HOK-4"].lifecycle.workflowOutcome' "$state")" "workflowOutcome is closed"
assert_eq "verification-required" "$(jq -r '.tasks["HOK-4"].lifecycle.resourceDisposition' "$state")" "disposition downgraded to verification-required"
assert_has_retention "$state" "HOK-4" "retention block was stamped"
assert_eq "0" "$(log_lines "$state")" "write guard logged no violations"

echo "test_cleanup_episode_record_outcome_stamps_retention"
# protects: a reaped episode passes retention_reason="" and leaves a terminal
# allocated row without retention. Reaped is exempt from the retention rule,
# so the writer only needs to avoid making the pair worse.
state="$(new_state episode)"
# allow-task-literal: deliberately invalid pre-fix row (closed+allocated, no retention) that the fixture builder would reject
jq -n '{tasks: {"HOK-5": {status: "closed", phase: "closed", lifecycle: {schemaVersion: 1, workflowOutcome: "closed", resourceDisposition: "allocated"}}}}' > "$state"
candidate='{"fingerprint":"hok3454-test-fp","fingerprintInputs":{"branch":"task/hok-3454"}}'
STATE_FILE="$state" cleanup_episode_record_outcome HOK-5 "reaped" "none" "cleanup-complete" "$candidate" "" 2>/dev/null
assert_eq "closed" "$(jq -r '.tasks["HOK-5"].lifecycle.workflowOutcome' "$state")" "workflowOutcome is closed"
assert_eq "reaped" "$(jq -r '.tasks["HOK-5"].lifecycle.resourceDisposition' "$state")" "disposition is reaped"
assert_eq "0" "$(log_lines "$state")" "write guard logged no violations (reaped is exempt)"

echo "test_cleanup_episode_record_outcome_stamps_retention_for_transient"
# protects: a transient episode maps resourceDisposition to verification-required
# but last_outcome="" leaves the terminal row without retention.
state="$(new_state episode-transient)"
# allow-task-literal: deliberately invalid pre-fix row (closed+allocated, no retention) that the fixture builder would reject
jq -n '{tasks: {"HOK-6": {status: "closed", phase: "closed", lifecycle: {schemaVersion: 1, workflowOutcome: "closed", resourceDisposition: "allocated"}}}}' > "$state"
candidate='{"fingerprint":"hok3454-transient-fp","fingerprintInputs":{"branch":"task/hok-3454"}}'
STATE_FILE="$state" cleanup_episode_record_outcome HOK-6 "transient" "operational" "" "$candidate" "" 2>/dev/null
assert_eq "closed" "$(jq -r '.tasks["HOK-6"].lifecycle.workflowOutcome' "$state")" "workflowOutcome is closed"
assert_eq "verification-required" "$(jq -r '.tasks["HOK-6"].lifecycle.resourceDisposition' "$state")" "disposition is verification-required"
assert_has_retention "$state" "HOK-6" "retention block was stamped"
assert_eq "0" "$(log_lines "$state")" "write guard logged no violations"

echo "test_hok3424_replay_fixture"
# protects: the HOK-3424_c challenger row from the shadow log reaches a valid
# lifecycle after a shell cleanup writer touches it. Loads the exact pre-fix
# state from the fixture (the fixture builder would reject closed+allocated
# without retention, but that is the exact signature that reached the writer).
FIXTURE="$REPO_DIR/tests/fixtures/incidents/hok-3424-retention-missing.json"
state="$(new_state hok3424)"
jq '.before' "$FIXTURE" > "$state"
STATE_FILE="$state" set_task_lifecycle_disposition HOK-3424_c "" "allocated" "" "cleanup_completed_task"
assert_has_retention "$state" "HOK-3424_c" "HOK-3424_c challenger now carries retention"
assert_eq "0" "$(log_lines "$state")" "HOK-3424_c replay write guard logged no violations"

echo
echo "lifecycle-writers: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
