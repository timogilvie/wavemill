#!/usr/bin/env bash
# Protects against pending async output being appended twice by the picker,
# and a new job kind bypassing the real job tracker (2026-10-28 incident).
set -euo pipefail
source "$(dirname "$0")/harness.sh"
reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP picker-pending-touch-set journey: $reason"
  exit 0
fi

ISSUE="JRN-1"
JOURNEY_MAX_PARALLEL=2
journey_init picker-pending-touch-set
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo
fakes_linear_add_issue JRN-2 "Leave a second task in the backlog" Todo
journey_write_monitor_env
journey_start_monitor
journey_wait_until "$ISSUE" 5 "backlog offers task" journey_backlog_offers "$ISSUE"
journey_command "select 1"
phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
touch_set_tracked() {
  jq -e --arg id "in-flight-touch-set-$ISSUE" \
    '.jobs[$id] | .kind == "in-flight-touch-set"' "$STATE_FILE" >/dev/null 2>&1
}
touch_set_cached() {
  local fd
  fd="$(journey_feature_dir "$ISSUE")"
  jq -e '.detail.files | type == "array"' "$fd/.in-flight-touch-set-result.json" >/dev/null 2>&1
}
journey_wait_until "$ISSUE" 5 "task launched" phase_is planning
# The spare slot and backlog force the production picker to serialize the
# pending result while this task is active, rather than use slots-full UI.
journey_wait_until "$ISSUE" 8 "touch set job registered" touch_set_tracked
journey_wait_until "$ISSUE" 8 "touch set result cached" touch_set_cached
journey_wait_until "$ISSUE" 15 "PR merged by tend" journey_pr_merged
journey_wait_until "$ISSUE" 8 "task reaped" journey_task_reaped "$ISSUE"
journey_assert_landed "$ISSUE"
journey_assert "backlog peer was not launched" test -z "$(journey_task_field JRN-2 phase)"
journey_assert "monitor survived picker refreshes" kill -0 "$JOURNEY_MONITOR_PID"
journey_finish
