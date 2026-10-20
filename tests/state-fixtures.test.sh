#!/usr/bin/env bash
# HOK-3223: tests/lib/state-fixtures.sh builds schema-validated workflow-state
# rows for shell tests, and fixture_real_state_accessors swaps test stubs for
# the production state accessors.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/state-fixtures.sh
source "$SCRIPT_DIR/lib/state-fixtures.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
check() {
  if [[ "$2" == "$3" ]]; then PASS=$((PASS + 1)); echo "  PASS  $1"
  else FAIL=$((FAIL + 1)); echo "  FAIL  $1 (expected '$3', got '$2')"; fi
}

validate_state() {
  (cd "$REPO_DIR" && node --experimental-strip-types --no-warnings -e "
    const { readFileSync } = await import('node:fs');
    const { validateWorkflowState } = await import('./shared/lib/workflow-state.ts');
    const result = validateWorkflowState(JSON.parse(readFileSync(process.argv[1], 'utf-8')));
    console.log(result.valid ? 'valid' : JSON.stringify(result.issues));
  " "$1")
}

echo "=== fixture_task ==="
row="$(fixture_task HOK-1 pr=9999 slug=feat)"
check "pr stays the string the shell writers store" "$(jq -r '.["HOK-1"].pr | type' <<< "$row")" "string"
check "override applied" "$(jq -r '.["HOK-1"].slug' <<< "$row")" "feat"
check "default phase" "$(jq -r '.["HOK-1"].phase' <<< "$row")" "planning"
check "default status" "$(jq -r '.["HOK-1"].status' <<< "$row")" "active"
check "JSON array field" "$(fixture_task HOK-1 'challengeArms=[]' | jq -c '.["HOK-1"].challengeArms')" "[]"
check "boolean field" "$(fixture_task HOK-1 challenge=true | jq -r '.["HOK-1"].challenge | type')" "boolean"
check "field:=json gives a numeric PR" "$(fixture_task HOK-1 pr:=1230 | jq -r '.["HOK-1"].pr | type')" "number"
check "--bare row holds only the overrides" "$(fixture_task --bare HOK-1 phase=coding | jq -c '.')" '{"HOK-1":{"phase":"coding"}}'

set +e
err="$(fixture_task HOK-1 prNumber=1 2>&1 >/dev/null)"; rc=$?
set -e
check "unknown field exits 1" "$rc" "1"
check "unknown field is named" "$([[ "$err" == *'unknown task field "prNumber"'* ]] && echo yes)" "yes"

set +e
err="$(fixture_task HOK-1 challenge=yes 2>&1 >/dev/null)"; rc=$?
set -e
check "non-JSON value for a boolean field exits 2" "$rc" "2"
check "usage is printed" "$([[ "$err" == *"usage: build-fixture-task.ts"* ]] && echo yes)" "yes"

echo "=== fixture_workflow_state ==="
STATE_FILE="$TMP/a/.wavemill/workflow-state.json"
fixture_workflow_state "$STATE_FILE" HOK-1 -- HOK-2 phase=ready
check "creates the file and its directory" "$(jq -r '.tasks | keys | join(",")' "$STATE_FILE")" "HOK-1,HOK-2"
check "second task override" "$(jq -r '.tasks["HOK-2"].phase' "$STATE_FILE")" "ready"
check "written state validates" "$(validate_state "$STATE_FILE")" "valid"

jq '.session = "wm-test"' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
fixture_workflow_state "$STATE_FILE" HOK-2 phase=review -- HOK-3
check "merge keeps other top-level keys" "$(jq -r '.session' "$STATE_FILE")" "wm-test"
check "merge keeps untouched tasks" "$(jq -r '.tasks | keys | join(",")' "$STATE_FILE")" "HOK-1,HOK-2,HOK-3"
check "merge replaces same-id rows" "$(jq -r '.tasks["HOK-2"].phase' "$STATE_FILE")" "review"

EMPTY_FILE="$TMP/empty.json"
fixture_workflow_state "$EMPTY_FILE"
check "no ids writes an empty task map" "$(jq -c '.' "$EMPTY_FILE")" '{"tasks":{}}'

before="$(cat "$STATE_FILE")"
set +e
fixture_workflow_state "$STATE_FILE" HOK-4 headSha=abc 2>/dev/null; rc=$?
set -e
check "rejected fixture fails" "$rc" "1"
check "rejected fixture leaves the file untouched" "$(cat "$STATE_FILE")" "$before"

echo "=== fixture_real_state_accessors ==="
# A stub like the ones tests used to carry; the real accessor must replace it.
get_task_meta() { echo stub; }
fixture_real_state_accessors
for fn in read_state_value get_task_meta state_mutate task_state_mutate_existing; do
  check "$fn is defined" "$(declare -F "$fn" >/dev/null && echo yes)" "yes"
done
check "get_task_meta replaced the stub and reads the fixture" "$(get_task_meta HOK-2 phase)" "review"
check "get_task_meta is empty for a missing field" "$(get_task_meta HOK-2 challengeRole)" ""
check "read_state_value reads the fixture" "$(read_state_value missing '.tasks["HOK-1"].status')" "active"
check "read_state_value falls back to the default" "$(STATE_FILE="$TMP/nope.json" read_state_value fallback '.x')" "fallback"
state_mutate "$STATE_FILE" '.tasks[$i].phase = "ready"' --arg i HOK-3
check "state_mutate writes through the lock" "$(get_task_meta HOK-3 phase)" "ready"
check "state_mutate released its lock" "$([[ -d "$STATE_FILE.lock" ]] && echo held || echo released)" "released"
task_state_mutate_existing HOK-3 '.evalCompleted = true'
check "task_state_mutate_existing updates a live row" "$(get_task_meta HOK-3 evalCompleted)" "true"
set +e
task_state_mutate_existing HOK-404 '.evalCompleted = true'
set -e
check "task_state_mutate_existing never recreates a reaped row" "$(jq -r '.tasks | has("HOK-404")' "$STATE_FILE")" "false"
check "state after real writers still validates" "$(validate_state "$STATE_FILE")" "valid"

echo ""
echo "passed=$PASS failed=$FAIL"
(( FAIL == 0 ))
