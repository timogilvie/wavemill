#!/usr/bin/env bash
# Golden journey: a coder writes .coding-complete and exits with an
# uncommitted change; the mill relaunches it once, the tree is cleaned, and the
# task still merges with no operator touch (HOK-3128).
#
# Protects against: the `.coding-complete` + dirty-tree park. The handoff guard
# rightly holds review while the agent may still commit, but once the agent has
# exited nobody will ever clean the tree, so the hold became a permanent
# needs-user (and, for a challenger, blocked its primary's green PR). The guard
# now relaunches coding once per head (bounded-retry bucket
# coding-dirty-handoff) with a "commit or discard these paths" instruction.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP dirty-tree-coding-complete journey: $reason"
  exit 0
fi

ISSUE="JRN-4"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/dirty-tree-coding-complete/fake-agent" && pwd)"
# The exit grace (default 120s) guards a live agent that writes the marker and
# then commits. It is wall-clock, not tick-clock; the fake agent's Stop hook is
# already final, so waiting it out would only burn the journey budget.
export WAVEMILL_CODING_DIRTY_HANDOFF_GRACE_SECONDS=0
journey_init dirty-tree-coding-complete
fakes_linear_add_issue "$ISSUE" "Change whose coder leaves a dirty tree" Todo
# Zero operator touches: the default asserts no .needs-attention at any tick.
# (The pre-exit hold only paints the tmux window red; it writes no marker.)

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
coding_launches() { journey_agent_launch_count "$ISSUE" coding; }
relaunched() { [[ "$(coding_launches)" -ge 2 ]]; }
agent_log_count() { grep -c "$1" "$FAKE_AGENT_LOG" 2>/dev/null || true; }
mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"             phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"                         phase_is coding
journey_wait_until "$ISSUE" 10 "dirty handoff relaunched the coder"      relaunched
journey_wait_until "$ISSUE" 10 "review launched after the tree was clean" phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"                       journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"                 journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "exactly two coding launches (original + one dirty-handoff relaunch)" \
  test "$(coding_launches)" = "2"
journey_assert "the first coder really left the tree dirty after .coding-complete" \
  test "$(agent_log_count "fault=dirty-tree-after-complete")" = "1"
journey_assert "the relaunched coder got the recovery instruction naming the dirty path" \
  test "$(agent_log_count "role=dirty-handoff recovery-instruction=present")" = "1"
journey_assert "the mill logged exactly one coding-dirty-handoff relaunch" \
  test "$(mill_log_count "coding-dirty-handoff relaunch (agent exited")" = "1"
journey_assert "no dirty-handoff exhaustion or terminalization" \
  test "$(mill_log_count "coding-dirty-handoff exhausted")" = "0"
journey_assert "review launched once, and only on a clean tree" \
  test "$(agent_log_count "phase=review issue=$ISSUE tree-at-launch=clean")/$(agent_log_count "tree-at-launch=dirty")" = "1/0"
journey_assert "the leftover change landed on $JOURNEY_INTEGRATION_BRANCH" \
  bash -c 'git --git-dir "$1" show "refs/heads/$2:journey-output.txt" | grep -q "^leftover $3:"' \
    _ "$FAKE_GH_ORIGIN" "$JOURNEY_INTEGRATION_BRANCH" "$ISSUE"
journey_assert_landed "$ISSUE"

journey_finish
