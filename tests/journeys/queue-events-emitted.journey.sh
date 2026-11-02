#!/usr/bin/env bash
# Golden journey: Queue lifecycle events are emitted correctly during merge.
#
# Protects against: incomplete event emission in the merge lane.
# Verifies that queue lifecycle events (candidate_prepared, check_run_completed,
# rebase_performed, merged, dequeued, abandoned) are emitted at appropriate
# lifecycle boundaries per HOK-3339.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP queue-events-emitted journey: $reason"
  exit 0
fi

ISSUE="JRN-2"
journey_init queue-events-emitted
fakes_linear_add_issue "$ISSUE" "Emit queue lifecycle events" Todo

journey_start_monitor

# The operator picks the first backlog task.
journey_wait_until "$ISSUE" 5 "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }

# Run through full workflow to generate events.
journey_wait_until "$ISSUE" 8  "coding launched"    phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"    phase_is review
journey_wait_until "$ISSUE" 15 "PR merged by tend"  journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped"        journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"

# Find the merge lane state directory and check emitted events.
PR_NUM="$(journey_get_pr_number)"
MERGE_STATE_DIR="$(journey_merge_lane_state_dir)"
EVENTS_LOG="$MERGE_STATE_DIR/.queue-events.jsonl"

if [[ ! -f "$EVENTS_LOG" ]]; then
  echo "FAIL: queue events log not found at $EVENTS_LOG"
  journey_finish 1
fi

# Verify events were emitted (at least the ones we expect)
assert_event_type() {
  local event_type="$1"
  if jq --exit-status "select(.eventType == \"$event_type\" and .prNumber == $PR_NUM)" "$EVENTS_LOG" > /dev/null 2>&1; then
    return 0
  else
    return 1
  fi
}

journey_assert "candidate_prepared event emitted" \
  assert_event_type "candidate_prepared"
journey_assert "check_run_completed event emitted" \
  assert_event_type "check_run_completed"
journey_assert "merged event emitted" \
  assert_event_type "merged"
journey_assert "dequeued event emitted" \
  assert_event_type "dequeued"

journey_assert_landed "$ISSUE"
journey_assert "post-merge eval completed" \
  test "$JOURNEY_SAW_ATTENTION" = "0"

journey_finish
