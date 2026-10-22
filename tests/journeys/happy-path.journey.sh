#!/usr/bin/env bash
# Golden journey: one task from backlog selection to merged and reaped.
#
# Protects against: any break in the plan → code → review → ready → tend merge
# → reap chain across real module boundaries — e.g. a reader that expects a
# field the writer never produces (HOK-3212), or a hand-off whose two sides
# disagree on shape (the reconciler never applying wm:ready).
#
# Formerly covered by lifecycle-harness tests retired per HOK-3228:
# test_positive_handoff_two_ticks (approved plan → coding launch, no
# source-overreach warning) and
# test_completed_coding_pane_is_quarantined_best_effort (the coding window is
# killed after .coding-complete and review gets a fresh window, never a
# "missing, recreating" fallback).
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP happy-path journey: $reason"
  exit 0
fi

ISSUE="JRN-1"
journey_init happy-path
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

journey_start_monitor
# The operator picks the first backlog task, as from the mill prompt.
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

# Budgets are monitor ticks (passes), not seconds.
journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert "one plan approval led to exactly one coding launch" \
  test "$(journey_approval_count)/$(journey_agent_launch_count "$ISSUE" coding)" = "1/1"
journey_assert "the plan→code handoff saw no planning source overreach" \
  test "$(journey_mill_log_count "Planning phase modified source code")" = "0"
journey_assert "the coding window was quarantined and review got a fresh window" \
  bash -c '(( $1 >= 1 ))' _ "$(journey_mill_log_count "intentionally quarantined after coding, creating fresh review window")"
journey_assert "no task window was ever recreated as missing" \
  test "$(journey_mill_log_count "missing, recreating")" = "0"
journey_assert_landed "$ISSUE"

journey_finish
