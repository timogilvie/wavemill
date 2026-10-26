#!/usr/bin/env bash
# Golden journey: a coding agent killed mid-stage recovers through the single
# failure policy and the task still merges with no operator touch (HOK-3313).
#
# Protects against: the HOK-3313 regression. A Claude coder gets SIGTERMed
# mid-stage (exit 143) with the word "OpenRouter" in the pane scrollback
# from an earlier helper call. The old pane-text sniff
# (agent_or_model_is_native_for_recovery, now deleted) would have matched
# "OpenRouter", mis-classified the exit as a native provider failure, and
# clobbered agent='claude' in the stage result — routing the arm through
# a native-launch-failure quarantine path that never retried.
#
# After HOK-3313: identity comes from the launch record only (.coding-result.json
# agent='claude'), the single failure policy classifies the unrecognised exit
# as retryable, maybe_retry_failed_stage relaunches under stage-failure-coding,
# the second launch completes, and the PR merges normally.
#
# Wall-clock note: this journey carries an extra lifecycle hop (kill → retry →
# complete) over the baseline happy-path, so the default 90s JOURNEY_BUDGET_SECONDS
# is tight. Honours whatever JOURNEY_BUDGET_SECONDS the caller sets; local macOS
# runs typically take 5-7m, CI Ubuntu typically 2-3m.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP agent-killed-mid-stage journey: $reason"
  exit 0
fi

ISSUE="JRN-3313"
# Before journey_init: the tmux server (and so every agent pane) inherits the
# environment at init.
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/hok-3313/fake-agent" && pwd)"
journey_init agent-killed-mid-stage
fakes_linear_add_issue "$ISSUE" "Task whose coder dies mid-stage" Todo
# Zero operator touches: the SIGTERM must never surface as needs-attention
# (the harness default asserts no .needs-attention at any tick).

journey_start_monitor
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
coding_runs() { cat "$FAKE_ROOT/coding-runs-$ISSUE" 2>/dev/null || echo 0; }
coder_relaunched() { (( $(coding_runs) >= 2 )); }

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning"                phase_is planning
journey_wait_until "$ISSUE" 15 "first coding agent exited (simulated SIGTERM)" \
  bash -c '[[ "$(cat "$1" 2>/dev/null)" -ge 1 ]]' _ "$FAKE_ROOT/coding-runs-$ISSUE"
journey_wait_until "$ISSUE" 20 "second coder launched by stage-failure retry" coder_relaunched
journey_wait_until "$ISSUE" 25 "PR merged by tend after recovery" journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"          journey_task_reaped "$ISSUE"

mill_log_count() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -c "$1" || true
}

echo ""
echo "assertions:"
journey_assert "exactly two coder launches (one killed, one succeeded)" \
  test "$(coding_runs)" = "2"
journey_assert "the simulated kill was observed by the mill" \
  bash -c '(( $1 >= 1 ))' _ "$(mill_log_count "Native coding failed")"
journey_assert "the exit was classified retryable, not terminal" \
  test "$(mill_log_count "retrying under stage-failure-coding")" != "0"
journey_assert "the arm never parked at needs-user over the SIGTERM" \
  test "$JOURNEY_SAW_ATTENTION" = "0"
journey_assert_landed "$ISSUE"

journey_finish
