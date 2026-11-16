#!/usr/bin/env bash
# Golden journey (HOK-3382): a native coding stage whose harness tool wedges
# is reassessed by the recovery controller, settled as a harness hang, retried
# through stage-failure-coding, and merged with zero operator touches.
#
# Protects against: a hung harness holding the stage in flight forever (the
# disposition is right that the process is alive; nobody asked "reassessment
# is due, now what?"), and the settled-without-result stamp charging the hang
# to the model. The model-time budget no longer backstops this case — it pauses
# while a tool executes — so the controller must own it.
#
# The fixture reuses the existing progress-clock seam (HOK-3422) to move the
# shared stall clock past 30 minutes inside the tick budget; no production
# threshold is changed.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP native-harness-hang journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/native-harness-hang" && pwd)"
ISSUE="JRN-1"
unset WAVEMILL_PHASE WAVEMILL_ISSUE
# Before journey_init: agent panes inherit the tmux server's environment.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init native-harness-hang
# Only the shared progress readers see the skew; controller writes and every
# other job keep real time.
export NODE_OPTIONS="--import=$(cd "$FIXTURE_DIR/../controller-writes-dont-reset-stall" && pwd)/progress-clock.mjs $NODE_OPTIONS"
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

journey_start_monitor
journey_set_tick_budget 140
journey_wait_until "$ISSUE" 30 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
FEATURE_DIR=""
remember_feature_dir() { FEATURE_DIR="$(journey_feature_dir "$ISSUE" 2>/dev/null || true)"; [[ -n "$FEATURE_DIR" ]]; }

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 3  "feature dir known"           remember_feature_dir

# Capture the settled attempt's hold evidence before the relaunch overwrites
# the result file.
SETTLED_EVIDENCE=""
capture_settled_harness_hang() {
  local result="$FEATURE_DIR/.coding-result.json"
  [[ -f "$result" ]] || return 1
  local reason tool
  reason="$(jq -r '.artifacts.exitEvidence.reason // empty' "$result" 2>/dev/null || true)"
  tool="$(jq -r '.artifacts.exitEvidence.harnessHold.toolName // empty' "$result" 2>/dev/null || true)"
  [[ "$reason" == "harness-hung" && "$tool" == "run_tests" ]] || return 1
  SETTLED_EVIDENCE="reason=${reason} tool=${tool}"
  return 0
}
journey_wait_until "$ISSUE" 20 "hung harness settled with hold evidence" capture_settled_harness_hang

hang_retry_rows() {
  local actions="$FEATURE_DIR/.recovery-actions.jsonl"
  [[ -f "$actions" ]] || { echo 0; return 0; }
  jq -s '[.[] | select(.action == "retry-stage" and .stage == "coding"
    and ((.rationale // "") | test("run_tests")))] | length' "$actions" 2>/dev/null || echo 0
}
HANG_RETRY_ROWS=0
hang_retry_recorded() {
  HANG_RETRY_ROWS="$(hang_retry_rows)"
  [[ "$HANG_RETRY_ROWS" -ge 1 ]]
}
journey_wait_until "$ISSUE" 8  "controller recorded the harness-hang retry-stage action" hang_retry_recorded

# The hung child must be gone after the controller's teardown.
HUNG_CHILD_PID="$(cat "$FEATURE_DIR/hung-child.pid" 2>/dev/null || true)"
HUNG_CHILD_GONE=0
hung_child_gone() {
  [[ -n "$HUNG_CHILD_PID" ]] || HUNG_CHILD_PID="$(cat "$FEATURE_DIR/hung-child.pid" 2>/dev/null || true)"
  [[ -n "$HUNG_CHILD_PID" ]] || return 1
  if ! kill -0 "$HUNG_CHILD_PID" 2>/dev/null; then HUNG_CHILD_GONE=1; return 0; fi
  return 1
}
journey_wait_until "$ISSUE" 10 "hung child gone after teardown" hung_child_gone

coding_relaunched() { [[ "$(journey_agent_launch_count "$ISSUE" coding)" -ge 2 ]]; }
journey_wait_until "$ISSUE" 10 "coding relaunched through stage-failure-coding" coding_relaunched
journey_wait_until "$ISSUE" 10 "review launched"             phase_is review

# Capture audit/evidence before the merge reaps the worktree. The failed-stage
# seam legitimately records its own relaunch obligation too; the oracle is the
# one rule-4a row whose rationale names the hung tool.
HANG_RETRY_FINAL="$(hang_retry_rows)"
HANG_RETRY_ROUTED="$(jq -rs 'map(select(.action == "retry-stage" and .stage == "coding"))
  | map(.rationale // "") | map(select(test("stage-failure-coding"))) | length as $n
  | if $n >= 1 then "1" else "0" end' "$FEATURE_DIR/.recovery-actions.jsonl" 2>/dev/null || echo 0)"
NO_BUDGET_STOP=0
grep -rqs 'budget_exhausted\|native-stage-timeout' "$FEATURE_DIR" || NO_BUDGET_STOP=1

journey_wait_until "$ISSUE" 15 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "exactly two coding launches (hang settled, then one retry)" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "2"
journey_assert "exactly one retry-stage coding row names the hung harness tool" \
  bash -c '[[ "$1" = "1" && "$2" = "1" ]]' _ "$HANG_RETRY_ROWS" "$HANG_RETRY_FINAL"
journey_assert "the hang retry routes through stage-failure-coding" \
  test "$HANG_RETRY_ROUTED" = "1"
journey_assert "the settled attempt carries exitEvidence.reason=harness-hung and harnessHold.toolName=run_tests" \
  test "$SETTLED_EVIDENCE" = "reason=harness-hung tool=run_tests"
journey_assert "the hung test-runner child is gone after teardown" \
  test "$HUNG_CHILD_GONE" = "1"
journey_assert "no budget_exhausted / native-stage-timeout anywhere in the feature dir" \
  test "$NO_BUDGET_STOP" = "1"
journey_assert_landed "$ISSUE"

journey_finish
