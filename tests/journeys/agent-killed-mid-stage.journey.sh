#!/usr/bin/env bash
# Golden journey: a Claude agent killed mid-stage recovers automatically with
# correct identity and no operator intervention (HOK-3313).
#
# Protects against: exit detection classifying the agent incorrectly (via pane
# text sniffing), bypassing the failure policy, or using wrong identity
# (codex vs claude, native vs CLI). The task should relaunch from the last
# durable commit and eventually merge.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP agent-killed-mid-stage journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/hok-3313" && pwd)"
ISSUE="JRN-1"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init. This injects the custom coding script that kills the
# agent mid-stage with exit code 143.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init agent-killed-mid-stage
fakes_linear_add_issue "$ISSUE" "Test agent killed mid-stage" Todo

export WAVEMILL_CODING_OWNER_GRACE_SECONDS=0
journey_start_monitor
journey_wait_until "$ISSUE" 30  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
pr_merged() { [[ "$(fakes_gh_pr_field 1 state)" == "MERGED" ]]; }
task_reaped() {
  local status
  status="$(journey_task_field "$ISSUE" status)"
  [[ -z "$(journey_task_field "$ISSUE" phase)" || "$status" == "merged" || "$status" == "completed" ]] \
    && [[ ! -d "$WORKTREE_ROOT/$(jq -r --arg id "$ISSUE" '.tasks[$id].slug // "__none__"' "$STATE_FILE" 2>/dev/null)" ]]
}

# Task progresses through plan and coding.
journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding

# The fake agent writes a commit but exits before .coding-complete. The monitor
# should detect the exit, classify it as retryable (not terminal), and relaunch.
# This wait gives enough ticks for the monitor to detect the dead agent.
journey_log "waiting for agent to exit and recovery to launch..."
coding_relaunched() { [[ "$(journey_agent_launch_count "$ISSUE" coding)" -ge 2 ]]; }
journey_wait_until "$ISSUE" 20 "coding relaunched after millisecond-timestamp agent exit" coding_relaunched

# Once relaunched, the task should complete the workflow normally.
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"           pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     task_reaped

echo ""
echo "assertions:"
journey_assert "PR #1 merged into $JOURNEY_INTEGRATION_BRANCH" \
  test "$(fakes_gh_pr_field 1 baseRefName)" = "$JOURNEY_INTEGRATION_BRANCH"
journey_assert "exactly two coding launches, with automatic crash recovery" test "$(journey_agent_launch_count "$ISSUE" coding)" = "2"
journey_assert "Linear issue ended Done" test "$(fakes_linear_state_of "$ISSUE")" = "Done"
journey_assert_no_unhandled_fake_calls

journey_finish
