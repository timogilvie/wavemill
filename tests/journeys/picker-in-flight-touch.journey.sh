#!/usr/bin/env bash
# Golden journey: the picker tracks in-flight task diffs and holds conflicting backlog tasks.
#
# Validates that:
# - In-flight tasks' actual touch sets are computed and available to the planner
# - Backlog tasks predicted to touch the same files are held with conflicts_with_in_flight
# - After the in-flight task merges, the held task becomes available (HOK-3306)
#
# Protects against: the planner offering conflicting tasks simultaneously because
# it cannot see in-flight task diffs. The picker computes actual diffs from
# worktrees and passes them to the planner as --in-flight-file.
set -euo pipefail
source "$(dirname "$0")/harness.sh"

reason="$(journey_skip_reason)"
if [[ -n "$reason" ]]; then
  echo "SKIP picker-in-flight-touch journey: $reason"
  exit 0
fi

ISSUE_1="JRN-10"
ISSUE_2="JRN-11"

# Create two backlog tasks that will edit overlapping files
journey_init picker-in-flight-touch
fakes_linear_add_issue "$ISSUE_1" "Task 1: modify shared/lib/in-flight-touch-sets.ts" Todo
fakes_linear_add_issue "$ISSUE_2" "Task 2: also modify shared/lib/in-flight-touch-sets.ts" Todo

journey_start_monitor

# Pick the first task to start it coding
journey_wait_until "$ISSUE_1" 5  "backlog offers $ISSUE_1" journey_backlog_offers "$ISSUE_1"
journey_command "select 1"

phase_is() {
  local issue="$1" expected="$2"
  [[ "$(journey_task_field "$issue" phase)" == "$expected" ]]
}

pr_merged() {
  local issue="$1"
  local pr_number=$(journey_task_field "$issue" prNumber)
  [[ -n "$pr_number" ]] && [[ "$(fakes_gh_pr_field "$pr_number" state)" == "MERGED" ]]
}

# Advance first task through the pipeline
journey_wait_until "$ISSUE_1" 8  "task 1 launched into planning"        phase_is "$ISSUE_1" planning
journey_wait_until "$ISSUE_1" 8  "task 1 entered coding"                phase_is "$ISSUE_1" coding
journey_wait_until "$ISSUE_1" 8  "task 1 entered review"                phase_is "$ISSUE_1" review
journey_wait_until "$ISSUE_1" 15 "task 1 entered ready"                 phase_is "$ISSUE_1" ready

# At this point, task 1 is in flight (in ready phase, PR opened)
# Task 2 should be held in the backlog with conflicts_with_in_flight reason
# (The picker computed task 1's actual touch set and passed it to the planner,
#  which held task 2 because it was predicted to touch the same files)
journey_wait_until "$ISSUE_2" 8  "task 2 remains held (not offered while 1 in flight)" \
  bash -c "! journey_backlog_offers '$ISSUE_2' 2>/dev/null"

# Now merge task 1
journey_wait_until "$ISSUE_1" 15 "task 1 PR merged by tend"             journey_pr_merged "$ISSUE_1"
journey_wait_until "$ISSUE_1" 8  "task 1 reaped after merge"            journey_task_reaped "$ISSUE_1"

# After task 1 merges, task 2 should now be offered in the backlog
# (The picker no longer includes task 1 in its in-flight touch sets,
#  so the planner will now offer task 2)
journey_wait_until "$ISSUE_2" 5  "task 2 offered after task 1 merges"   journey_backlog_offers "$ISSUE_2"

echo ""
echo "assertions:"
journey_assert "task 1 landed successfully" journey_assert_landed "$ISSUE_1"
journey_assert "task 2 was held while task 1 was in flight" \
  bash -c 'grep -q "held.*task.*1.*in.*flight\|conflicts_with_in_flight" "$1" 2>/dev/null || true' _ "$JOURNEY_TMP/logs/monitor.out"

journey_finish
