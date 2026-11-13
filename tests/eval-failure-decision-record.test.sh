#!/usr/bin/env bash
# HOK-3452 acceptance: the eval-failure decision is one condition-keyed record.
#
# The decision is written through eval_failure_decision_record (marker_write,
# keyed on the worktree head + attempt runId) and read through
# eval_failure_decision_current, which returns it only while both still
# describe the current attempt. A stale decision (moved head, earlier run,
# legacy raw file) is never returned, so it cannot abort a challenge pair.
#
# Cases:
#   1. current head + current runId -> decision returned, reconciler keeps it
#   2. head moved -> not returned, reconciler expires it with an audit line
#   3. current head but earlier runId -> not returned (run is the tie-breaker)
#   4. legacy raw file (no schemaVersion) -> not returned
#   5. operator event after write -> not returned, reconciler expires it
#   6. mark_eval_failed writes evalFailed + the record; a reaped task writes
#      neither and records the decision in postReapEval instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$REPO_DIR/tests/lib/state-fixtures.sh"
source "$REPO_DIR/shared/lib/bounded-retry.sh"
source "$REPO_DIR/shared/lib/transient-marker.sh"
source "$REPO_DIR/shared/lib/condition-reconciler.sh"

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

assert_empty() {
  local label="$1" actual="$2"
  if [[ -z "$actual" ]]; then pass "$label"; else
    echo "    expected empty, got: $actual"
    fail "$label"
  fi
}

assert_file_state() {
  local label="$1" expected="$2" path="$3"
  local got=missing
  [[ -f "$path" ]] && got=present
  assert_eq "$label" "$expected" "$got"
}

new_fixture() {
  ISSUE="HOK-7001"
  SLUG="hok-7001"
  RUN_ID="run-$RANDOM$RANDOM"
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
    slug="$SLUG" branch="task/$SLUG" phase=executing status=active runId="$RUN_ID"
  jq -c '.terminalTaskHistory = {tasks: {}} | .terminalTaskTombstones = {}' \
    "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
  MARKER="$STATE_DIR/.eval-failure-decision.json"
  DECISION='{"class":"terminal","failureKind":"eval-harness-error","attribution":"infra","nextAction":"retry eval"}'
}

bump_head() {
  git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m two
}

current() {
  eval_failure_decision_current "$ISSUE" "$STATE_DIR" "$WT"
}

# --- Case 1: current head + current runId -----------------------------------
new_fixture
mark_eval_failed "$ISSUE" "$DECISION" "$RUN_ID"

assert_eq "live write: evalFailed set" "true" \
  "$(jq -r --arg i "$ISSUE" '.tasks[$i].evalFailed' "$STATE_FILE")"
assert_file_state "live write: record written" present "$MARKER"

returned="$(current)"
assert_eq "current: failureKind returned" "eval-harness-error" \
  "$(jq -r '.failureKind // ""' <<<"$returned")"
assert_eq "current: runId returned" "$RUN_ID" \
  "$(jq -r '.runId // ""' <<<"$returned")"

condition_reconcile_task "$ISSUE" "$WT" "$STATE_DIR"
assert_file_state "current: reconciler keeps the record" present "$MARKER"

# --- Case 2: head moved -----------------------------------------------------
new_fixture
mark_eval_failed "$ISSUE" "$DECISION" "$RUN_ID"
bump_head

assert_empty "head moved: decision not returned" "$(current)"

condition_reconcile_task "$ISSUE" "$WT" "$STATE_DIR"
assert_file_state "head moved: reconciler expires the record" missing "$MARKER"
reconcile_log="$STATE_DIR/.condition-reconcile.jsonl"
assert_eq "head moved: audit names the record" ".eval-failure-decision.json" \
  "$(jq -r 'select(.marker == ".eval-failure-decision.json") | .marker' "$reconcile_log" 2>/dev/null | head -n1)"
assert_eq "head moved: audit trigger is head" "head" \
  "$(jq -r 'select(.marker == ".eval-failure-decision.json") | .trigger' "$reconcile_log" 2>/dev/null | head -n1)"

# --- Case 3: same head, earlier runId ---------------------------------------
new_fixture
mark_eval_failed "$ISSUE" "$DECISION" "$RUN_ID"
# A new attempt on the same commit: runId changes, head does not.
jq --arg i "$ISSUE" --arg run "$RUN_ID-next" '.tasks[$i].runId = $run' \
  "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

assert_empty "earlier run: decision not returned" "$(current)"

condition_reconcile_task "$ISSUE" "$WT" "$STATE_DIR"
assert_file_state "earlier run: head condition still holds, record kept" present "$MARKER"

# --- Case 4: legacy raw file ------------------------------------------------
new_fixture
printf '{"class":"terminal","failureKind":"eval-harness-error"}\n' > "$MARKER"

assert_empty "legacy file: decision not returned" "$(current)"

# --- Case 5: operator event after write -------------------------------------
new_fixture
mark_eval_failed "$ISSUE" "$DECISION" "$RUN_ID"
operator_event_record "$STATE_DIR" "re-review" "$ISSUE" "retry the pair"

# The reconciler runs before every gate in the monitor pass, so an operator
# event expires the record before a reader can apply it.
condition_reconcile_task "$ISSUE" "$WT" "$STATE_DIR"
assert_file_state "operator event: reconciler expires the record" missing "$MARKER"
assert_empty "operator event: decision not returned after reconcile" "$(current)"
assert_eq "operator event: audit trigger is operator-event" "operator-event" \
  "$(jq -r 'select(.marker == ".eval-failure-decision.json") | .trigger' "$STATE_DIR/.condition-reconcile.jsonl" 2>/dev/null | head -n1)"

# --- Case 6: reaped task keeps the audit-only path --------------------------
new_fixture
jq --arg i "$ISSUE" '
  .terminalTaskHistory.tasks[$i] = {issue: $i, slug: "hok-7001"}
  | del(.tasks[$i])
' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

mark_eval_failed "$ISSUE" "$DECISION" "$RUN_ID"
assert_file_state "reaped: record not written" missing "$MARKER"
assert_eq "reaped: entry not recreated" "null" \
  "$(jq -r --arg i "$ISSUE" '.tasks[$i] // "null"' "$STATE_FILE")"
assert_eq "reaped: postReapEval outcome" "failed" \
  "$(jq -r --arg i "$ISSUE" '.terminalTaskHistory.tasks[$i].postReapEval.outcome // ""' "$STATE_FILE")"
assert_eq "reaped: postReapEval carries the decision" "eval-harness-error" \
  "$(jq -r --arg i "$ISSUE" '.terminalTaskHistory.tasks[$i].postReapEval.decision.failureKind // ""' "$STATE_FILE")"

echo ""
echo "eval-failure-decision-record: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
