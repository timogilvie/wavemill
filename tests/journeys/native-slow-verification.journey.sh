#!/usr/bin/env bash
# Golden journey (HOK-3381): a native coder whose verification outlasts 60
# minutes of wall time on a slowed fake test runner writes .coding-complete
# and merges with zero operator touches.
#
# Protects against: the fixed 60-minute wall clock (deleted as coding's model
# budget in HOK-3381) — or any controller-side check — treating a
# tool-dominated >60-minute coding attempt as a failure: a budget-exhaustion
# handoff, a stage-failure relaunch, or a needs-user park, instead of letting
# the completed attempt land. The HOK-3374 incident lost a working attempt to
# exactly this: 51 of its 60 minutes were our own run_tests on a loaded host.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP native-slow-verification journey: $reason"
  exit 0
fi

FIXTURE_DIR="$(cd "$(dirname "$0")/fixtures/hok-3381" && pwd)"
ISSUE="JRN-1"
# A journey launched from inside a mill agent pane inherits that agent's
# WAVEMILL_PHASE / WAVEMILL_ISSUE.
unset WAVEMILL_PHASE WAVEMILL_ISSUE
# Before journey_init: agent panes inherit the tmux server's environment.
export FAKE_AGENT_SCRIPT_DIR="$FIXTURE_DIR/fake-agent"
journey_init native-slow-verification
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

journey_start_monitor
journey_set_tick_budget 100
journey_wait_until "$ISSUE" 30 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
FEATURE_DIR=""
remember_feature_dir() { FEATURE_DIR="$(journey_feature_dir "$ISSUE" 2>/dev/null || true)"; [[ -n "$FEATURE_DIR" ]]; }
transcript_window_over_an_hour() {
  local transcript="$FEATURE_DIR/native-sessions/coding-$ISSUE.jsonl"
  [[ -f "$transcript" ]] || return 1
  jq -s -e '(.[-1].timestamp - .[0].timestamp) > 3600000' "$transcript" >/dev/null 2>&1
}

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 3  "feature dir known"           remember_feature_dir
journey_wait_until "$ISSUE" 10 "review launched"             phase_is review
# Capture coding-attempt evidence before the merge reaps the worktree.
NO_BUDGET_STOP=0
grep -rqs 'budget_exhausted\|native-stage-timeout' "$FEATURE_DIR" || NO_BUDGET_STOP=1
NO_FAILURE_HANDOFF=0
[[ -f "$FEATURE_DIR/.coding-failure-handoff.json" ]] || NO_FAILURE_HANDOFF=1
TRANSCRIPT_OVER_AN_HOUR=0
if transcript_window_over_an_hour; then TRANSCRIPT_OVER_AN_HOUR=1; fi
journey_wait_until "$ISSUE" 15 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "exactly one coding launch (no budget stop, no relaunch)" \
  test "$(journey_agent_launch_count "$ISSUE" coding)" = "1"
journey_assert "the transcript's wall window exceeds 60 minutes (slowed test runner)" \
  test "$TRANSCRIPT_OVER_AN_HOUR" = "1"
journey_assert "no budget-exhaustion handoff was written for the slow verification run" \
  test "$NO_FAILURE_HANDOFF" = "1"
journey_assert "no budget_exhausted / native-stage-timeout anywhere in the feature dir" \
  test "$NO_BUDGET_STOP" = "1"
journey_assert_landed "$ISSUE"

journey_finish
