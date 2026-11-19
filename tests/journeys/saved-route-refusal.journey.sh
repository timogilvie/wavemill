#!/usr/bin/env bash
# Golden journey: a refused saved route raises one inbox item, and the
# operator's reroute clears it and relaunches the stage (HOK-3512, replaying
# the HOK-3500 incident).
#
# Protects against: a retryable coding failure whose saved route then fails
# launch validation holding forever — the controller waited on an
# `execution-contract-available` wake nothing produced, the task stayed
# coding/active and no inbox item, retry or hook appeared. Now the refusal is
# one failure-policy terminal escalation through escalate_operator_attention
# naming the stage, model and validator reason; `wavemill reroute` is the
# operator event that expires it, and the stage relaunches under its bounded
# retry with no other touches.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP saved-route-refusal journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/saved-route-refusal" && pwd)"
ISSUE="JRN-1"
unset WAVEMILL_PHASE WAVEMILL_ISSUE
# Before journey_init: agent panes inherit the tmux server's environment.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init saved-route-refusal
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo
JOURNEY_EXPECT_ATTENTION=1

journey_start_monitor
journey_set_tick_budget 120
journey_wait_until "$ISSUE" 30 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
FEATURE_DIR=""
remember_feature_dir() { FEATURE_DIR="$(journey_feature_dir "$ISSUE" 2>/dev/null || true)"; [[ -n "$FEATURE_DIR" ]]; }
refusal_escalated() {
  journey_jq_true '(.detail.escalationBasis // "" | startswith("policy-terminal"))
    and (tostring | test("recovery_contract_unavailable|refused by launch validation"))
    and (tostring | test("journey-retired-coder")) and (tostring | test("model_not_launchable"))' \
    "$FEATURE_DIR/.needs-attention"
}
attention_cleared() { [[ ! -f "$FEATURE_DIR/.needs-attention" ]]; }
coding_relaunched() { [[ "$(journey_agent_launch_count "$ISSUE" coding)" -ge 2 ]]; }

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 3  "feature dir known"           remember_feature_dir
journey_wait_until "$ISSUE" 12 "refused saved route raised one inbox item naming the validator reason" refusal_escalated
cp "$FEATURE_DIR/.needs-attention" "$JOURNEY_TMP/refusal-attention.json"
LAUNCHES_AT_REFUSAL="$(journey_agent_launch_count "$ISSUE" coding)"

# The operator's one touch: reroute the stage to a launchable model.
npx tsx "$JOURNEY_INSTALL_DIR/tools/reroute-task.ts" "$ISSUE" --phase coding \
  --model "$(cat "$FEATURE_DIR/journey-launchable-coder-model")" \
  --feature-dir "$FEATURE_DIR" --repo "$REPO_DIR" > "$JOURNEY_TMP/logs/reroute.json"
REROUTE_EVENTS="$(grep -c '"command":"reroute"' "$FEATURE_DIR/.operator-events.jsonl" 2>/dev/null || echo 0)"

journey_wait_until "$ISSUE" 10 "reroute expired the inbox item"            attention_cleared
journey_wait_until "$ISSUE" 15 "coding relaunched under stage-failure-coding" coding_relaunched
journey_wait_until "$ISSUE" 8  "review launched"                           phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"                         journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"                   journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "no relaunch while the saved route was refused" test "$LAUNCHES_AT_REFUSAL" = "1"
journey_assert "the inbox item names the coding stage" \
  bash -c 'jq -e "tostring | test(\"saved coding route\")" "$1" >/dev/null' _ "$JOURNEY_TMP/refusal-attention.json"
journey_assert "exactly two coding launches (one refused replay held, one bounded relaunch)" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "2"
journey_assert "the reroute was recorded as one operator event" \
  test "$REROUTE_EVENTS" = "1"
journey_assert_landed "$ISSUE"

journey_finish
