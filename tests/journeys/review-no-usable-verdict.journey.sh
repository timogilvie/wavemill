#!/usr/bin/env bash
# Golden journey: a review that settles with no usable verdict is relaunched,
# never set to `error` (HOK-3463).
#
# Protects against: a review agent that exits without a verdict being stamped
# "Agent exited without creating PR" and parked in `error`, or paging the
# operator on the first occurrence. With the mill opening the PR, "no PR after
# review" means only "no usable verdict": it retries through the
# stage-failure-review bucket and the task merges with no operator touch.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP review-no-usable-verdict journey: $reason"
  exit 0
fi

ISSUE="JRN-1"
export FAKE_AGENT_SCRIPT_DIR
FAKE_AGENT_SCRIPT_DIR="$(cd "$(dirname "$0")/fixtures/review-no-usable-verdict/fake-agent" && pwd)"
journey_init review-no-usable-verdict
fakes_linear_add_issue "$ISSUE" "Add journey output file" Todo

journey_start_monitor
journey_set_tick_budget 80
journey_wait_until "$ISSUE" 5  "backlog offers $ISSUE" journey_backlog_offers "$ISSUE"
journey_command "select 1"

phase_is() { [[ "$(journey_task_field "$ISSUE" phase)" == "$1" ]]; }
review_runs() { cat "$(journey_feature_dir "$ISSUE")/.journey-review-runs" 2>/dev/null || echo 0; }
review_relaunched() { (( $(review_runs) >= 2 )); }
monitor_logged() {
  sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log" 2>/dev/null \
    | grep -qF "$1"
}

journey_wait_until "$ISSUE" 5  "task launched into planning" phase_is planning
journey_wait_until "$ISSUE" 8  "coding launched"             phase_is coding
journey_wait_until "$ISSUE" 8  "review launched"             phase_is review
journey_wait_until "$ISSUE" 20 "review relaunched after the lost verdict" review_relaunched
journey_wait_until "$ISSUE" 20 "PR merged by tend"           journey_pr_merged
journey_wait_until "$ISSUE" 8  "task reaped after merge"     journey_task_reaped "$ISSUE"

echo ""
echo "assertions:"
journey_assert_landed "$ISSUE"
journey_assert "the lost verdict was routed to the stage-failure-review bucket" \
  monitor_logged "review agent settled without a result (no-usable-verdict:"
journey_assert "the task was never reported as exiting without a PR" \
  bash -c '! sed "s/\x1b\[[0-9;]*[A-Za-z]//g" "$1" "$2" 2>/dev/null | grep -qF "Agent exited without creating PR"' _ \
    "$JOURNEY_TMP/logs/monitor.out" "$JOURNEY_TMP/logs/status.log"
journey_assert "the PR carries the title the relaunched review recorded" \
  test "$(fakes_gh_pr_field 1 title)" = "$ISSUE: journey change after a lost verdict"
journey_assert "no operator attention was needed" test "$JOURNEY_SAW_ATTENTION" = "0"

journey_finish
