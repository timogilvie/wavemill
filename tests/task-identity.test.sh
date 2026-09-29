#!/usr/bin/env bash
# HOK-3114 — bash parity test for shared/lib/task-identity.sh.
#
# Evaluates every row of tests/fixtures/task-identity-cases.json (the same
# rows shared/lib/task-identity.test.ts asserts against the TS module) and
# checks parse output, resolved Linear ID / error code, and both predicates.
# Each row gets its own state file so rows with the same task ID but
# different metadata do not interfere.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$REPO_DIR/tests/fixtures/task-identity-cases.json"

# shellcheck source=../shared/lib/task-identity.sh
source "$REPO_DIR/shared/lib/task-identity.sh"

pass=0
fail=0
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL  $label: expected '$expected', got '$actual'"
    fail=$((fail + 1))
  fi
}

count="$(jq '.cases | length' "$FIXTURE")"
for ((i = 0; i < count; i++)); do
  row="$(jq -c ".cases[$i]" "$FIXTURE")"
  name="$(jq -r '.name' <<< "$row")"
  task_id="$(jq -r '.taskId' <<< "$row")"
  state_file="$tmpdir/state-$i.json"
  jq '{tasks: (if .task == null then {} else {(.taskId): .task} end)}' <<< "$row" > "$state_file"

  # parse
  expected_parse="$(jq -r '.expected.parse | if . == null then "FAIL" else [.taskId, .linearId, .role] | @tsv end' <<< "$row")"
  actual_parse="$(task_identity_parse "$task_id")" || actual_parse="FAIL"
  check "$name: parse" "$expected_parse" "$actual_parse"

  # resolved Linear ID / error code
  expected_linear="$(jq -r '.expected | if .error then "ERR:" + .error else .linearId end' <<< "$row")"
  rc=0
  actual_linear="$(task_identity_linear_id "$task_id" "$state_file" 2>/dev/null)" || rc=$?
  case "$rc" in
    0) ;;
    1) actual_linear="ERR:invalid_task_id" ;;
    2) actual_linear="ERR:linear_id_mismatch" ;;
    *) actual_linear="ERR:rc=$rc" ;;
  esac
  check "$name: linear_id" "$expected_linear" "$actual_linear"

  # predicates
  expected_challenger="$(jq -r '.expected.isChallenger' <<< "$row")"
  actual_challenger=false
  task_identity_is_challenger "$task_id" && actual_challenger=true
  check "$name: is_challenger" "$expected_challenger" "$actual_challenger"

  expected_writer="$(jq -r '.expected.isLinearWriter' <<< "$row")"
  actual_writer=false
  task_identity_is_linear_writer "$task_id" "$state_file" && actual_writer=true
  check "$name: is_linear_writer" "$expected_writer" "$actual_writer"
done

# STATE_FILE default: metadata is read from $STATE_FILE when no file is passed.
printf '{"tasks":{"HOK-1":{"linearIssueId":"HOK-2"}}}' > "$tmpdir/default.json"
rc=0
STATE_FILE="$tmpdir/default.json" task_identity_linear_id "HOK-1" >/dev/null 2>&1 || rc=$?
check "STATE_FILE default: mismatch detected" "2" "$rc"

echo "task-identity: $pass passed, $fail failed ($count fixture rows)"
(( fail == 0 ))
