#!/usr/bin/env bash
# Golden journey (HOK-3492): a native coder crosses the task's one recorded
# spend budget ($25) and the mill stops the task instead of relaunching it.
#
# Protects against: the incident HOK-3382_c — nine native launches sharing one
# task budget spent $45-75 while nothing compared spend to the $25 the route
# recorded. The recorded cost-kind budget fact is terminal under
# failure-policy.ts (`task-budget-exhausted`): the stage does not consume a
# stage-failure-coding retry, and the task is not relaunched. Zero operator
# touches are needed to reach that decision.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP native-coder-cost-budget journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/hok-3492" && pwd)"
ISSUE="JRN-1"
unset WAVEMILL_PHASE WAVEMILL_ISSUE
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init native-coder-cost-budget
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

# The route's recorded budget, exactly as the incident carried it.
journey_write_config '{"mill": {"defaultMaxCostUsd": 25}}'

journey_start_monitor
journey_set_tick_budget 80
journey_wait_until "$ISSUE" 30 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
FEATURE_DIR=""
remember_feature_dir() { FEATURE_DIR="$(journey_feature_dir "$ISSUE" 2>/dev/null || true)"; [[ -n "$FEATURE_DIR" ]]; }
decision_recorded() {
  [[ -n "$FEATURE_DIR" ]] || return 1
  jq -e '.class == "terminal" and .failureKind == "native-stage-timeout"
    and .budgetExhausted.kind == "cost"' "$FEATURE_DIR/.coding-failure-decision.json" >/dev/null 2>&1
}
settle_from=""
three_settle_ticks() {
  [[ -n "$settle_from" ]] || { settle_from="$(journey_tick)"; return 1; }
  (( $(journey_tick) - settle_from >= 3 ))
}

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 3  "feature dir known"           remember_feature_dir
journey_wait_until "$ISSUE" 12 "cost budget stop classified terminal" decision_recorded
journey_wait_until "$ISSUE" 5  "the mill settles after the terminal decision" three_settle_ticks

retry_count_file="$FEATURE_DIR/.retry-stage-failure-coding-count"
STAGE_FAILURE_RETRIES=0
[[ -f "$retry_count_file" ]] && STAGE_FAILURE_RETRIES="$(cat "$retry_count_file" 2>/dev/null || echo 0)"
STAGE_RESULT="$(jq -c '{status, failureReason, budgetExhausted}' "$FEATURE_DIR/.coding-result.json" 2>/dev/null || echo '{}')"

echo ""
echo "assertions:"
journey_assert "exactly one coding launch — the exhausted task budget did not relaunch" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "1"
journey_assert "the cost-kind budget fact is a terminal task-budget stop, not a stage retry" \
  bash -c 'printf %s "$1" | jq -e ".class == \"terminal\" and .budgetExhausted.kind == \"cost\"" >/dev/null' _ \
    "$(cat "$FEATURE_DIR/.coding-failure-decision.json" 2>/dev/null)"
journey_assert "no stage-failure-coding attempt was consumed" \
  test "${STAGE_FAILURE_RETRIES:-0}" = "0"
journey_assert "the failed stage result records budget_exhausted:cost with the measured cost fact" \
  bash -c 'printf %s "$1" | jq -e ".status == \"failed\" and .failureReason == \"budget_exhausted:cost\"
    and .budgetExhausted.kind == \"cost\" and (.budgetExhausted.used >= 25)" >/dev/null' _ "$STAGE_RESULT"
journey_assert "the task never reached a PR (no relaunch, no review, no merge)" \
  test -z "$(journey_get_pr_number)"
journey_assert_no_unhandled_fake_calls

journey_finish
