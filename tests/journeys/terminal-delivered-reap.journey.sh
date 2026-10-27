#!/usr/bin/env bash
# Golden journey (HOK-3312): a merged task whose agent left a fresh
# `waiting:Notification` hook still reaps — the task's lifecycle, not its
# pane, decides release.
#
# Protects against: a reintroduced "live-agent-process" or "dirty_worktree"
# refusal in `wavemill_release_terminal_pane` or `cleanup_completed_task`
# that would wedge the window in `needs-user` instead of killing it.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP terminal-delivered-reap journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/hok-3312" && pwd)"
ISSUE="JRN-1"
# tmux inherits the environment at `journey_init`; export the fake-agent
# override before init so the coder stamps the waiting hook as it exits.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init terminal-delivered-reap
fakes_linear_add_issue "$ISSUE" "Terminal cleanup under a live hook" Todo

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"           journey_pr_merged

# The coder stamped a fresh `waiting:Notification` hook before exiting. Pre-
# HOK-3312 that hook would have refused pane release and parked the task in
# `needs-user`. The task must still reap within a bounded number of ticks.
journey_wait_until "$ISSUE" 15 "task reaped despite live hook" \
  journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert_landed "$ISSUE"
journey_assert_no_unhandled_fake_calls

journey_finish
