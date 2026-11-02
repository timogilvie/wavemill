#!/usr/bin/env bash
# Golden journey: a native coder that exhausts its wall-clock budget relaunches
# through the existing bounded retry, and the records carry the one budget
# fact (HOK-3362, replaying HOK-3329 attempt 2).
#
# Protects against: our own budget abort being recorded as a provider error
# (`provider_error` / `provider-unknown-error`), the budget stop parking the
# task instead of retrying under stage-failure-coding, and the failed
# attempt's budget fact being lost once the relaunch succeeds — the eval
# record must carry it with the derived fault class, with zero operator
# touches.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP native-coder-budget-exhaustion journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/hok-3362" && pwd)"
ISSUE="JRN-1"
# A journey launched from inside a mill agent pane inherits that agent's
# WAVEMILL_PHASE / WAVEMILL_ISSUE; the fake CLI would then answer the eval's
# `claude -p` judge call as a phase launch instead of serving the verdict.
unset WAVEMILL_PHASE WAVEMILL_ISSUE
# Before journey_init: agent panes inherit the tmux server's environment.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init native-coder-budget-exhaustion
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

# Post-merge eval on, judged by the shared fake: the harness's verdict file is
# the one MONITOR_ENV points the fake at, so seed it with a scored verdict.
# One task never forms grounded-planner pairs, so no other `claude -p` call
# reads it.
cp "$FIXTURE_DIR/judge-verdict.json" "$JOURNEY_TMP/judge-verdict.json"
journey_write_config '{"eval": {"judge": {"model": "claude-sonnet-5", "provider": "anthropic"}}}'
printf 'AUTO_EVAL=true\n' >> "$MONITOR_ENV"
EVAL_LOG="/tmp/${SESSION}-eval-${ISSUE}.log"

journey_start_monitor
journey_wait_until "$ISSUE" 30 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
FEATURE_DIR=""
remember_feature_dir() { FEATURE_DIR="$(journey_feature_dir "$ISSUE" 2>/dev/null || true)"; [[ -n "$FEATURE_DIR" ]]; }
budget_decision_recorded() {
  journey_jq_true '.failureKind == "native-stage-timeout" and .class == "retryable"
    and .budgetExhausted.kind == "wall_clock" and .budgetExhausted.progress.toolCallsExecuted == 230' \
    "$FEATURE_DIR/.coding-failure-decision.json"
}
coding_relaunched() { [[ "$(journey_agent_launch_count "$ISSUE" coding)" -ge 2 ]]; }
eval_settled() {
  [[ -f "$EVAL_LOG" ]] && cp "$EVAL_LOG" "$JOURNEY_TMP/logs/eval.log"
  grep -q 'Eval process exited with code' "$EVAL_LOG" 2>/dev/null
}
eval_record() { grep -h "\"$ISSUE\"" "$STATE_DIR"/evals/*.jsonl 2>/dev/null | tail -1; }

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 3  "feature dir known"           remember_feature_dir
# The budget stop is classified from the typed envelope: the one budget kind,
# retryable under the stage's shared bucket, carrying the fact.
journey_wait_until "$ISSUE" 10 "budget stop classified native-stage-timeout (retryable)" budget_decision_recorded
journey_wait_until "$ISSUE" 20 "coding relaunched by stage-failure-coding" coding_relaunched
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
NO_PROVIDER_ERROR_IN_FEATURE_DIR=0
grep -rqs 'provider_error\|provider-unknown-error' "$FEATURE_DIR" || NO_PROVIDER_ERROR_IN_FEATURE_DIR=1
HISTORY_FACT_KIND="$(jq -r '[.history[]? | .budgetExhausted.kind // empty] | first // empty' "$FEATURE_DIR/.coding-result.json" 2>/dev/null || true)"
journey_wait_until "$ISSUE" 15 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"
journey_wait_until "$ISSUE" 10 "post-merge eval settled"     eval_settled

echo ""
echo "assertions:"
journey_assert "exactly two coding launches (one budget stop, one bounded-retry relaunch)" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "2"
journey_assert "no provider_error / provider-unknown-error anywhere in the feature dir" \
  test "$NO_PROVIDER_ERROR_IN_FEATURE_DIR" = "1"
journey_assert "the relaunch archived the failed attempt's budget fact in the coding history" \
  test "$HISTORY_FACT_KIND" = "wall_clock"
journey_assert "eval record carries budgetExhaustions[0] = coding wall_clock fact" \
  bash -c 'printf %s "$1" | jq -e ".budgetExhaustions[0] | .stage == \"coding\" and .fact.kind == \"wall_clock\"
    and .fact.progress.turnsCompleted == 145 and .fact.progress.toolCallsExecuted == 230" >/dev/null' _ "$(eval_record)"
journey_assert "eval record derives model-fault from the progress evidence" \
  bash -c 'printf %s "$1" | jq -e ".budgetExhaustions[0].faultClass == \"model-fault\"" >/dev/null' _ "$(eval_record)"
journey_assert_landed "$ISSUE"

journey_finish
