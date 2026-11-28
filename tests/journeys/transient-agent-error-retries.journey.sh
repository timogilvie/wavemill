#!/usr/bin/env bash
# Golden journey (HOK-3459): a transient, unrecognized agent error is
# persisted as a failed coding stage, retried through stage-failure-coding,
# and reaches merge/reap without operator touches beyond plan approval.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP transient-agent-error-retries journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/hok-3459" && pwd)"
ISSUE="JRN-3459"
# Before journey_init, inject a coding failure into the first fake agent run.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init transient-agent-error-retries
fakes_linear_add_issue "$ISSUE" "Test transient agent failure retries" Todo

# One operator touch total: the planning approval the workflow requires.
journey_set_approval_budget 1
journey_set_tick_budget 120
journey_start_monitor
journey_wait_until "$ISSUE" 30 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
pr_merged() { [[ "$(fakes_gh_pr_field 1 state)" == "MERGED" ]]; }
task_reaped() {
  local status
  status="$(journey_task_field "$ISSUE" status)"
  [[ -z "$(journey_task_field "$ISSUE" phase)" || "$status" == "merged" || "$status" == "completed" ]] \
    && [[ ! -d "$WORKTREE_ROOT/$(jq -r --arg id "$ISSUE" '.tasks[$id].slug // "__none__"' "$STATE_FILE" 2>/dev/null)" ]]
}
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/mill.log" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}
coding_failed_under_policy() {
  [[ "$(mill_log_count "Native coding failed (native-unclassified)")" -ge 1 ]]
}
coding_relaunched() { [[ "$(journey_agent_launch_count "$ISSUE" coding)" -ge 2 ]]; }

journey_wait_until "$ISSUE" 5 "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8 "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 20 "coding error recorded through shared policy" coding_failed_under_policy
journey_wait_until "$ISSUE" 25 "coding relaunched after transient agent error" coding_relaunched
journey_wait_until "$ISSUE" 20 "PR merged by tend"           pr_merged
journey_wait_until "$ISSUE" 10 "task reaped after merge"     task_reaped

echo ""
echo "assertions:"
journey_assert "PR #1 merged into $JOURNEY_INTEGRATION_BRANCH" \
  test "$(fakes_gh_pr_field 1 baseRefName)" = "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "exactly two coding launches (one injected error, one recovery)" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "2"
journey_assert "the injected error became a shared failed-stage result" \
  test "$(mill_log_count "Native coding failed (native-unclassified)")" = "1"
journey_assert "task reached merge without operator attention" \
  test "$(journey_task_field "$ISSUE" status)" != "error"
journey_assert "zero operator touches beyond the workflow's plan approval" \
  test "$(journey_approval_count)" = "1"
journey_assert "Linear issue ended Done" test "$(fakes_linear_state_of "$ISSUE")" = "Done"
journey_assert_no_unhandled_fake_calls

journey_finish
