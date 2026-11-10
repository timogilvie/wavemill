#!/usr/bin/env bash
# Golden journey (HOK-3426): a review agent killed mid-stage settles on the
# RECORDED exit fact — the launcher's `agent-exit` record — never on a pane
# descendant count — and the run completes with zero operator touches.
#
# Protects against: the reported 2026-11-05 stall shape in both directions.
#   (a) a live reviewer stamped `failed` because a name-resolved pane (or a
#       pane whose agent had not forked yet) showed no descendants;
#   (b) a genuinely killed reviewer never being noticed because the pane shell
#       outlives the agent (the pane descendant count is not an exit fact).
# The settled stage must relaunch through the shared `stage-failure-review`
# bucket and the task must still merge and reap.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP agent-killed-mid-review journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/hok-3426" && pwd)"
ISSUE="JRN-1"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init. This injects the review script that kills the reviewer
# before it writes the PR or a verdict.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init agent-killed-mid-review
fakes_linear_add_issue "$ISSUE" "Test review agent killed mid-stage" Todo

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
# The exit fact is the only new evidence after the kill: assert the monitor's
# own settling decision names it (not `agent-stalled`, not a pane read).
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/mill.log" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}
review_settled_on_exit_fact() {
  [[ "$(mill_log_count "review agent settled without a result (agent-exited)")" -ge 1 ]]
}
review_relaunched() { [[ "$(journey_agent_launch_count "$ISSUE" review)" -ge 2 ]]; }

journey_wait_until "$ISSUE" 5 "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8 "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8 "review launched"             phase_is review
# The reviewer exits 143 two seconds in; the pane shell stays alive. Only the
# launcher-recorded exit fact can settle it.
journey_wait_until "$ISSUE" 20 "review settled on the recorded exit fact" review_settled_on_exit_fact
journey_wait_until "$ISSUE" 25 "review relaunched after the killed agent" review_relaunched
journey_wait_until "$ISSUE" 20 "PR merged by tend"           pr_merged
journey_wait_until "$ISSUE" 10 "task reaped after merge"     task_reaped

echo ""
echo "assertions:"
journey_assert "PR #1 merged into $JOURNEY_INTEGRATION_BRANCH" \
  test "$(fakes_gh_pr_field 1 baseRefName)" = "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "exactly two review launches (one real kill, one relaunch)" \
  test "$(journey_agent_launch_count "$ISSUE" review)" = "2"
journey_assert "the kill settled the stage on the recorded exit fact, once" \
  test "$(mill_log_count "review agent settled without a result (agent-exited)")" = "1"
journey_assert "no stall-clock settle was needed for the killed reviewer" \
  test "$(mill_log_count "agent settled without a result (agent-stalled)")" = "0"
journey_assert "zero operator touches beyond the workflow's plan approval" \
  test "$(journey_approval_count)" = "1"
journey_assert "Linear issue ended Done" test "$(fakes_linear_state_of "$ISSUE")" = "Done"
journey_assert_no_unhandled_fake_calls

journey_finish
